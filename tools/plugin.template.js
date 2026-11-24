/**
 * Spellcheck Plus — варианты замены для слов с ошибками в поле ввода Hermes.
 *
 * Зачем: Hermes рисует меню правого клика сам и не отдаёт в него данные
 * проверки орфографии Chromium. Красное подчёркивание видно, списка вариантов
 * нет. Плагин считает варианты на месте по частотным словарям и добавляет их
 * в меню через штатный слот `COMPOSER_AREAS.contextMenu` — без обращений к DOM
 * приложения и без патчей ядра.
 *
 * Языки: __LANGUAGES_LIST__ — каждый включается и выключается в Настройки ▸ Плагины.
 * Словари встроены в файл сжатыми (gzip + base64).
 */

import { COMPOSER_AREAS, ToggleRow, host, usePluginI18n } from '@hermes/plugin-sdk'
import { useCallback, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'spellcheck-plus'
const VERSION = '__VERSION__'
const STORE_KEY = 'settings'
const DEFAULT_SETTINGS = { languages: ['ru', 'en'] }

// Потолки, чтобы меню открывалось мгновенно даже на промахе.
const DIST2_RANK = 120000 // вторая правка: только не самые редкие слова
const DIST2_BUDGET_MS = 45
const DIST2_MAX_CANDIDATES = 30000
const CACHE_LIMIT = 500

/** Словари: язык → gzip+base64 частотного списка (по убыванию частоты). */
const DICTIONARY_DATA = {
__DICTIONARIES__
}

/** Языки, которые умеет плагин: подпись, алфавит для правок, набор письма. */
const LANGUAGES = {
__LANGUAGES__
}

/** Расшифрованный текст словаря по языку ('' пока не распаковано). */
const dictionaries = new Map()

/** ё и е для русского — одна буква при поиске, но в подсказке показываем оригинал. */
const normalize = word => word.toLowerCase().replace(/ё/g, 'е')

let ctxRef = null
let settings = { ...DEFAULT_SETTINGS }
const indexes = new Map() // язык → { map, sorted }
const cache = new Map() // `${lang}:${word}` → string[]

/* ─────────────────────────────── словари ──────────────────────────────── */

async function decodeDictionary(payload) {
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

async function loadDictionary(lang) {
  if (dictionaries.has(lang)) return dictionaries.get(lang)

  const payload = DICTIONARY_DATA[lang]
  if (!payload) return ''

  try {
    const text = await decodeDictionary(payload)
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

  const text = dictionaries.get(lang)
  if (!text || !LANGUAGES[lang]) return null

  const map = new Map()
  const words = text.split(' ')
  for (let rank = 0; rank < words.length; rank++) {
    const display = words[rank]
    const key = normalize(display)
    if (!map.has(key)) map.set(key, { display, rank })
  }

  const index = { map, sorted: [...map.keys()].sort() }
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

/** Похоже на словоформу известного слова (орфографи-я → орфографии)? */
function looksLikeForm(index, word) {
  if (!index) return false
  const longest = Math.min(2, word.length - 6)

  for (let cut = 1; cut <= longest; cut++) {
    const stem = word.slice(0, word.length - cut)
    if (stem.length >= 6 && hasPrefix(index, stem)) return true
  }

  return false
}

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

function collectHits(index, word, alphabet, limit) {
  const hits = []

  for (const candidate of editsOne(word, alphabet)) {
    const hit = index.map.get(candidate)
    if (hit) hits.push(hit)
    if (hits.length >= limit) break
  }

  return hits
}

function collectSecondPass(index, word, alphabet) {
  const hits = []
  const deadline = performance.now() + DIST2_BUDGET_MS
  let examined = 0

  for (const first of editsOne(word, alphabet)) {
    for (const candidate of editsOne(first, alphabet)) {
      const hit = index.map.get(candidate)
      if (hit && hit.rank < DIST2_RANK) hits.push(hit)
      if (hits.length >= 16) return hits

      examined++
      if (examined > DIST2_MAX_CANDIDATES) return hits
      if ((examined & 2047) === 0 && performance.now() > deadline) return hits
    }
  }

  return hits
}

function suggestFor(lang, raw, limit = 4) {
  const spec = LANGUAGES[lang]
  const index = indexFor(lang)
  if (!spec || !index) return []

  const word = normalize(raw)

  // одна правка — доверяем: настоящая опечатка почти всегда здесь
  const hits = collectHits(index, word, spec.alphabet, 16)

  if (!hits.length) {
    // вторая правка — только если слово не похоже на словоформу известного
    if (looksLikeForm(index, word)) return []
    hits.push(...collectSecondPass(index, word, spec.alphabet))
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

/** Варианты для слова: пусто, если слово из словаря или письменность чужая. */
function suggestionsFor(raw) {
  const word = raw.trim()
  if (word.length < 3) return []

  for (const lang of settings.languages) {
    const spec = LANGUAGES[lang]
    if (!spec || !spec.script.test(word)) continue

    const key = `${lang}:${normalize(word)}`
    if (cache.has(key)) return cache.get(key)

    const index = indexFor(lang)
    const list = !index || index.map.has(normalize(word)) ? [] : suggestFor(lang, word)

    if (cache.size > CACHE_LIMIT) cache.clear()
    cache.set(key, list)
    return list
  }

  return []
}

/* ──────────────────────────────── настройки ───────────────────────────── */

function readSettings() {
  const stored = ctxRef?.storage?.get?.(STORE_KEY, null)
  const languages = Array.isArray(stored?.languages)
    ? stored.languages.filter(lang => LANGUAGES[lang])
    : DEFAULT_SETTINGS.languages

  settings = { languages }
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

    writeSettings({ languages: Object.keys(LANGUAGES).filter(id => next.has(id)) })
    setOn(next.has(lang))
    onChanged()
  }, [lang, onChanged])

  return jsx(ToggleRow, { label: LANGUAGES[lang].label, checked: on, onChange: toggle })
}

function SettingsPage() {
  const t = usePluginI18n(ID)
  const [, force] = useState(0)
  const redraw = useCallback(() => force(n => n + 1), [])

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' },
    children: [
      jsx('div', {
        style: { fontSize: '12px', color: 'var(--ui-text-tertiary)', lineHeight: 1.5 },
        children: t('hint')
      }),
      ...Object.keys(LANGUAGES).map(lang => jsx(LanguageRow, { key: lang, lang, onChanged: redraw }))
    ]
  })
}

/** Все локали, которые перечисляет приложение: отсутствие ключа молча падает в en. */
const LOCALES = {
  en: {
    header: 'Did you mean:',
    addToDict: 'Add to dictionary',
    hint: 'Tick the languages you write in. Suggestions appear in the composer’s right-click menu; unticked languages are not loaded at all.',
    settingsTitle: 'Spellcheck Plus'
  },
  ru: {
    header: 'Возможно, вы имели в виду:',
    addToDict: 'Добавить в словарь',
    hint: 'Отметьте языки, на которых пишете. Варианты появляются в меню правого клика по полю ввода; выключенные языки вообще не загружаются.',
    settingsTitle: 'Spellcheck Plus'
  },
  zh: {
    header: '您是不是要输入：',
    addToDict: '添加到词典',
    hint: '选择您使用的语言。替换建议会出现在输入框右键菜单中；未选中的语言不会被加载。',
    settingsTitle: 'Spellcheck Plus'
  },
  'zh-hant': {
    header: '您是不是要輸入：',
    addToDict: '加入字典',
    hint: '選擇您使用的語言。取代建議會出現在輸入框右鍵選單中；未勾選的語言不會載入。',
    settingsTitle: 'Spellcheck Plus'
  },
  ja: {
    header: 'もしかして：',
    addToDict: '辞書に追加',
    hint: '使用する言語にチェックを入れてください。入力欄の右クリックメニューに候補が表示されます。',
    settingsTitle: 'Spellcheck Plus'
  },
  ar: {
    header: 'هل تقصد:',
    addToDict: 'إضافة إلى القاموس',
    hint: 'حدّد اللغات التي تكتب بها. تظهر البدائل في قائمة زر الفأرة الأيمن، واللغات غير المحددة لا تُحمَّل.',
    settingsTitle: 'Spellcheck Plus'
  },
  fr: {
    header: 'Vouliez-vous dire :',
    addToDict: 'Ajouter au dictionnaire',
    hint: 'Cochez les langues que vous utilisez. Les suggestions apparaissent dans le menu contextuel du champ de saisie.',
    settingsTitle: 'Spellcheck Plus'
  },
  de: {
    header: 'Meinten Sie:',
    addToDict: 'Zum Wörterbuch hinzufügen',
    hint: 'Wählen Sie Ihre Sprachen. Vorschläge erscheinen im Kontextmenü des Eingabefelds; abgewählte Sprachen werden nicht geladen.',
    settingsTitle: 'Spellcheck Plus'
  },
  es: {
    header: '¿Quisiste decir:',
    addToDict: 'Añadir al diccionario',
    hint: 'Marca los idiomas en los que escribes. Las sugerencias aparecen en el menú del campo de entrada.',
    settingsTitle: 'Spellcheck Plus'
  }
}

/* ───────────────────────────── регистрация ────────────────────────────── */

export default {
  id: ID,
  name: 'Spellcheck Plus',
  version: VERSION,
  description: 'Replacement suggestions for misspelled words in the composer’s right-click menu.',
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
