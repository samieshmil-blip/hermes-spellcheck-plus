/**
 * spellcheck-plus — варианты замены для слов с ошибками в поле ввода Hermes.
 *
 * Зачем: Hermes рисует меню правого клика сам и не пускает системное меню
 * Chromium. Из-за этого слово с опечаткой (и его подсказки) до меню не доезжает:
 * красное подчёркивание видно, а списка вариантов нет. Плагин считает варианты
 * на месте, по частотным словарям, и добавляет их в меню через штатный слот
 * `COMPOSER_AREAS.contextMenu` — без обращений к DOM приложения.
 *
 * Языки: русский и английский, каждый можно выключить в Настройки ▸ Плагины.
 * Словари встроены в файл (частотные списки, __RU_COUNT__ и __EN_COUNT__ слов).
 */

import { COMPOSER_AREAS, ToggleRow, host, usePluginI18n } from '@hermes/plugin-sdk'
import { useCallback, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'spellcheck-plus'
const STORE_KEY = 'settings'
const DEFAULT_SETTINGS = { languages: ['ru', 'en'] }

// Потолки, чтобы меню открывалось мгновенно даже на промахе.
const HOT_RANK = Infinity // вариант из словаря — годится (список уже частотный)
const DIST2_RANK = 60000 // для второй правки — только частые слова
const DIST2_BUDGET_MS = 40
const DIST2_MAX_CANDIDATES = 20000
const CACHE_LIMIT = 500

// Словари лежат в файле сжатыми (gzip + base64): сам плагин остаётся одним
// небольшим файлом, а в исходниках нет трёх мегабайт текста.
const RU_DATA = '__RU_B64__'
const EN_DATA = '__EN_B64__'

const LANGUAGES = {
  ru: {
    label: 'Русский',
    data: RU_DATA,
    alphabet: 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
    script: /^[\u0400-\u04FF-]+$/
  },
  en: {
    label: 'English',
    data: EN_DATA,
    alphabet: 'abcdefghijklmnopqrstuvwxyz',
    script: /^[A-Za-z'-]+$/
  }
}

/** Расшифрованный текст словаря по языку ('' пока не распаковано). */
const dictionaries = new Map()

/** ё и е — одна буква для поиска, но в подсказке показываем оригинал. */
const normalize = word => word.toLowerCase().replace(/ё/g, 'е')

let ctxRef = null
let settings = { ...DEFAULT_SETTINGS }
const indexes = new Map() // lang → Map<normalized, { display, rank }>
const cache = new Map() // `${lang}:${word}` → string[]

/* ─────────────────────────────── словари ──────────────────────────────── */

/** gzip + base64 → текст. Распаковка идёт один раз при старте плагина. */
async function decodeDictionary(payload) {
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

async function loadDictionary(lang) {
  if (dictionaries.has(lang)) return dictionaries.get(lang)

  const spec = LANGUAGES[lang]
  if (!spec) return ''

  try {
    const text = await decodeDictionary(spec.data)
    dictionaries.set(lang, text)
    return text
  } catch {
    dictionaries.set(lang, '')
    return ''
  }
}

function indexFor(lang) {
  const ready = indexes.get(lang)
  if (ready) return ready

  const spec = LANGUAGES[lang]
  const text = dictionaries.get(lang)
  if (!spec || !text) return null

  const map = new Map()
  const words = text.split(' ')
  for (let rank = 0; rank < words.length; rank++) {
    const display = words[rank]
    const key = normalize(display)
    if (!map.has(key)) map.set(key, { display, rank })
  }

  const sorted = [...map.keys()].sort()
  const index = { map, sorted }
  indexes.set(lang, index)
  return index
}

/** Есть ли в словаре слово, начинающееся со `stem` (двоичный поиск). */
function hasPrefix(index, stem) {
  const keys = index.sorted
  let lo = 0
  let hi = keys.length

  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keys[mid] < stem) lo = mid + 1
    else hi = mid
  }

  return lo < keys.length && keys[lo].startsWith(stem)
}

/** Готовит словари включённых языков (вызывается из register, не блокирует UI). */
async function buildEnabled() {
  for (const lang of settings.languages) {
    if (!dictionaries.has(lang)) await loadDictionary(lang)
    indexFor(lang)
  }
}

/* ────────────────────────────── поиск вариантов ───────────────────────── */

function editsOne(word, alphabet) {
  const out = new Set()
  const n = word.length

  for (let i = 0; i < n; i++) out.add(word.slice(0, i) + word.slice(i + 1))
  for (let i = 0; i < n - 1; i++) out.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2))
  for (let i = 0; i < n; i++) {
    for (const ch of alphabet) out.add(word.slice(0, i) + ch + word.slice(i + 1))
  }
  for (let i = 0; i <= n; i++) {
    for (const ch of alphabet) out.add(word.slice(0, i) + ch + word.slice(i))
  }
  return out
}

function suggestFor(lang, raw, limit = 4) {
  const spec = LANGUAGES[lang]
  const index = indexFor(lang)
  if (!spec || !index) return []

  const word = normalize(raw)
  const hits = []

  for (const candidate of editsOne(word, spec.alphabet)) {
    const hit = index.map.get(candidate)
    if (hit && hit.rank < HOT_RANK) hits.push(hit)
  }

  // вторая правка — только если первой не хватило и слово не короткое;
  // жёсткие потолки: по числу кандидатов и по времени
  if (!hits.length && word.length >= 5) {
    const deadline = performance.now() + DIST2_BUDGET_MS
    let examined = 0
    let stop = false

    for (const first of editsOne(word, spec.alphabet)) {
      for (const candidate of editsOne(first, spec.alphabet)) {
        const hit = index.map.get(candidate)
        if (hit && hit.rank < DIST2_RANK) {
          hits.push(hit)
          if (hits.length >= 12) stop = true
        }
        if (stop) break
        examined++
        if (examined > DIST2_MAX_CANDIDATES) stop = true
        else if ((examined & 2047) === 0 && performance.now() > deadline) stop = true
      }
      if (stop) break
    }
  }

  if (!hits.length) return []

  hits.sort((a, b) => a.rank - b.rank)
  const out = []
  const seen = new Set()
  for (const hit of hits) {
    const key = normalize(hit.display)
    if (seen.has(key) || key === word) continue
    seen.add(key)
    out.push(hit.display)
    if (out.length >= limit) break
  }
  return out
}

/** Похоже на словоформу известного слова (орфографи-я → орфографии)? Тогда
 *  подсказки не нужны: это не опечатка, а редкая или техническая форма. */
function looksLikeForm(index, word) {
  if (!index) return false
  const longest = Math.min(2, word.length - 6)

  for (let cut = 1; cut <= longest; cut++) {
    const stem = word.slice(0, word.length - cut)
    if (stem.length >= 6 && hasPrefix(index, stem)) return true
  }

  return false
}

/** Варианты для слова: '' когда слово не просит подсказок (из словаря, чужой алфавит). */
function suggestionsFor(raw) {
  const word = raw.trim()
  if (word.length < 3) return []

  for (const lang of settings.languages) {
    const spec = LANGUAGES[lang]
    if (!spec || !spec.script.test(word)) continue

    const key = `${lang}:${normalize(word)}`
    if (cache.has(key)) return cache.get(key)

    const index = indexFor(lang)
    const normalized = normalize(word)
    const known = index?.map.has(normalized)
    const list = known || looksLikeForm(index, normalized) ? [] : suggestFor(lang, word)

    if (cache.size > CACHE_LIMIT) cache.clear()
    cache.set(key, list)
    return list
  }

  return []
}

/* ──────────────────────────────── настройки ───────────────────────────── */

function readSettings() {
  const stored = ctxRef?.storage?.get?.(STORE_KEY, null)
  if (stored && Array.isArray(stored.languages)) {
    settings = { languages: stored.languages.filter(lang => LANGUAGES[lang]) }
  } else {
    settings = { ...DEFAULT_SETTINGS }
  }
  return settings
}

function writeSettings(next) {
  settings = next
  ctxRef?.storage?.set?.(STORE_KEY, next)
  cache.clear()
  buildEnabled()
}

function LanguageRow({ lang, onChanged }) {
  const [on, setOn] = useState(settings.languages.includes(lang))
  const toggle = useCallback(() => {
    const next = new Set(settings.languages)
    if (next.has(lang)) next.delete(lang)
    else next.add(lang)
    writeSettings({ languages: [...next] })
    setOn(next.has(lang))
    onChanged()
  }, [lang, onChanged])

  return jsx(ToggleRow, {
    label: LANGUAGES[lang].label,
    checked: on,
    onChange: toggle
  })
}

function SettingsPage() {
  const t = usePluginI18n(ID)
  const [, force] = useState(0)
  const redraw = useCallback(() => force(n => n + 1), [])

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px 0' },
    children: [
      jsx('div', { style: { fontSize: '12px', color: 'var(--ui-text-tertiary)', lineHeight: 1.5 }, children: t('hint') }),
      ...Object.keys(LANGUAGES).map(lang => jsx(LanguageRow, { key: lang, lang, onChanged: redraw }))
    ]
  })
}

/** Все локали, которые перечисляет приложение: отсутствие ключа молча падает в en. */
const LOCALES = {
  en: {
    header: 'Did you mean:',
    addToDict: 'Add to dictionary',
    hint: 'Languages that get replacement suggestions in the composer’s right-click menu.',
    settingsTitle: 'Spellcheck Plus'
  },
  ru: {
    header: 'Возможно, вы имели в виду:',
    addToDict: 'Добавить в словарь',
    hint: 'Языки, для которых в меню правого клика по полю ввода показываются варианты замены.',
    settingsTitle: 'Spellcheck Plus'
  },
  zh: {
    header: '您是不是要输入：',
    addToDict: '添加到词典',
    hint: '在输入框右键菜单中显示替换建议的检查语言。',
    settingsTitle: 'Spellcheck Plus'
  },
  'zh-hant': {
    header: '您是不是要輸入：',
    addToDict: '加入字典',
    hint: '在輸入框右鍵選單中顯示取代建議的檢查語言。',
    settingsTitle: 'Spellcheck Plus'
  },
  ja: {
    header: 'もしかして：',
    addToDict: '辞書に追加',
    hint: '入力欄の右クリックメニューで候補を表示する言語。',
    settingsTitle: 'Spellcheck Plus'
  },
  ar: {
    header: 'هل تقصد:',
    addToDict: 'إضافة إلى القاموس',
    hint: 'اللغات التي تظهر لها بدائل في قائمة زر الفأرة الأيمن داخل حقل الإدخال.',
    settingsTitle: 'Spellcheck Plus'
  },
  fr: {
    header: 'Vouliez-vous dire :',
    addToDict: 'Ajouter au dictionnaire',
    hint: 'Langues pour lesquelles le menu contextuel du champ de saisie propose des remplacements.',
    settingsTitle: 'Spellcheck Plus'
  },
  de: {
    header: 'Meinten Sie:',
    addToDict: 'Zum Wörterbuch hinzufügen',
    hint: 'Sprachen, für die das Kontextmenü des Eingabefelds Ersetzungen vorschlägt.',
    settingsTitle: 'Spellcheck Plus'
  },
  es: {
    header: '¿Quisiste decir:',
    addToDict: 'Añadir al diccionario',
    hint: 'Idiomas para los que el menú del campo de entrada sugiere alternativas.',
    settingsTitle: 'Spellcheck Plus'
  }
}

/* ───────────────────────────── регистрация ────────────────────────────── */

export default {
  id: ID,
  name: 'Spellcheck Plus',
  description: 'Русские и английские варианты замены слова в меню правого клика по полю ввода.',
  register(ctx) {
    ctxRef = ctx

    ctx.i18n.register(LOCALES)

    readSettings()

    // словари распаковываются в фоне: меню не ждёт, пока это закончится
    setTimeout(() => {
      void buildEnabled()
    }, 800)

    ctx.register({
      id: 'suggestions',
      area: COMPOSER_AREAS.contextMenu,
      data: {
        items: ({ word }) => {
          const raw = (word || '').trim()
          if (!raw) return []

          const list = suggestionsFor(raw)
          if (!list.length) return []

          const t = ctx.i18n.t
          return [
            { disabled: true, label: t('header'), onSelect: () => {} },
            ...list.map(s => ({ label: s, onSelect: action => action.replaceWord(s) })),
            {
              label: t('addToDict'),
              onSelect: () => {
                cache.clear()
                void host.spellcheck?.addWord?.(raw)
              }
            }
          ]
        }
      }
    })

    ctx.registerSettingsPage?.({
      id: 'settings',
      title: ctx.i18n.t('settingsTitle'),
      icon: 'check',
      render: () => jsx(SettingsPage, {})
    })
  }
}
