#!/usr/bin/env node
/**
 * ru-spellcheck — включает нативную проверку орфографии (русский + английский)
 * в поле ввода Hermes Desktop.
 *
 * Три правки, пересборка приложения не нужна:
 *  1. dist/assets/main-*.js  — поле ввода чата получает spellCheck:true
 *     (в исходнике для десктопа там жёстко стоит false, поэтому Chromium молчит).
 *  2. dist/electron-main.mjs — языки словаря Chromium: ru-RU/ru + en-US/en.
 *  3. Каталог Dictionaries в userData — готовые Hunspell-словари (.bdic лежат
 *     рядом, в папке dict): Chromium на этом хосте сам их не скачивает, а без
 *     файла словаря он не подчёркивает и не предлагает замены.
 *
 * Скрипт идемпотентен: повторный запуск ничего не портит, а после обновления
 * приложения заново накладывает правки. Оригиналы сохраняются рядом
 * в *.bak-ru-spellcheck (один раз, до первой правки).
 *
 * Запуск:  node apply-fix.cjs        (или двойной клик по apply-fix.cmd)
 * Итог:    apply-fix.log рядом со скриптом, код выхода 0 = всё на месте.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const MARK = 'ru-spellcheck-2'

// Языки словаря. Порядок важен: ru-RU — канон Chromium, ru — короткая форма,
// которую тоже отдаёт availableSpellCheckerLanguages. Лишние отфильтруются.
const LANGS = '["ru-RU","ru","en-US","en"]'
const LANG_EXPR =
  `defaultSession.setSpellCheckerLanguages(/*${MARK}*/ (function(){` +
  `var want=${LANGS}.filter(function(l){return available.indexOf(l)>=0});` +
  `return want.length?want:[chosen];})());`

// Что стоит в нетронутой сборке и что наложила первая версия этого скрипта.
const LANG_PRISTINE = 'defaultSession.setSpellCheckerLanguages([chosen]);'
const LANG_V1 =
  `defaultSession.setSpellCheckerLanguages(/*ru-spellcheck*/ (function(){` +
  `var want=["ru","en-US"].filter(function(l){return available.indexOf(l)>=0});` +
  `return want.length?want:[chosen];})());`

const DICT_SRC = path.join(__dirname, 'dict')
const DICT_FILES = ['ru-RU-3-0.bdic', 'en-US-10-1.bdic']

const DIST = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
  'hermes',
  'hermes-agent',
  'apps',
  'desktop',
  'release',
  'win-unpacked',
  'resources',
  'app.asar.unpacked',
  'dist'
)

const LOG_FILE = path.join(__dirname, 'apply-fix.log')
const out = []
const say = msg => {
  out.push(`[${new Date().toISOString()}] ${msg}`)
  if (process.stdout.isTTY) console.log(msg)
}
const flush = () => {
  try {
    fs.appendFileSync(LOG_FILE, out.join('\n') + '\n', 'utf8')
  } catch {
    /* лог — не критично */
  }
}
const backup = file => {
  const bak = file + '.bak-ru-spellcheck'
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak)
  return bak
}

function patchMain(dist) {
  const file = path.join(dist, 'electron-main.mjs')
  if (!fs.existsSync(file)) return { ok: false, why: 'нет electron-main.mjs' }

  const src = fs.readFileSync(file, 'utf8')
  if (src.includes(`/*${MARK}*/`)) return { ok: true, state: 'уже пропатчено' }

  let next = null
  if (src.includes(LANG_V1)) next = src.replace(LANG_V1, LANG_EXPR)
  else if (src.includes(LANG_PRISTINE)) next = src.replace(LANG_PRISTINE, LANG_EXPR)

  if (!next || next === src) {
    return { ok: false, why: 'не нашёл строку установки языков словаря (сборка изменилась?)' }
  }

  backup(file)
  fs.writeFileSync(file, next, 'utf8')
  return { ok: true, state: 'пропатчено' }
}

/**
 * Chromium качает словари Hunspell сам, но на этом хосте загрузка молчит —
 * кладём готовые .bdic рядом со скриптом и копируем в оба каталога userData.
 */
function ensureDictionaries() {
  if (!fs.existsSync(DICT_SRC)) return { ok: true, state: 'папки dict нет — пропущено' }

  const roaming =
    process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
  const targets = [
    path.join(roaming, 'hermes', 'Dictionaries'),
    path.join(roaming, 'Hermes', 'Dictionaries')
  ]
  const copied = []

  for (const dir of targets) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      for (const name of DICT_FILES) {
        const src = path.join(DICT_SRC, name)
        const dst = path.join(dir, name)
        if (!fs.existsSync(src)) continue
        if (fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size) continue
        fs.copyFileSync(src, dst)
        copied.push(name)
      }
    } catch (err) {
      return { ok: false, state: `ошибка копирования в ${dir}: ${err.message}` }
    }
  }

  return {
    ok: true,
    state: copied.length ? `скопировано: ${[...new Set(copied)].join(', ')}` : 'словари уже на месте'
  }
}

function patchRenderer(dist) {
  const dir = path.join(dist, 'assets')
  if (!fs.existsSync(dir)) return { ok: false, why: 'нет папки assets' }

  // Точка правки — функция composerTextEntryProps: ветка "touch" уже с
  // spellCheck:!0, а десктопная ветка идёт сразу за ней с !1.
  const anchor = 'autoCapitalize:`sentences`,autoCorrect:`on`,spellCheck:!0}:{'
  const hits = []

  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue
    const file = path.join(dir, name)
    const src = fs.readFileSync(file, 'utf8')
    const at = src.indexOf(anchor)
    if (at < 0) continue

    const windowEnd = at + anchor.length + 200
    const win = src.slice(at, windowEnd)
    const off = win.indexOf('spellCheck:!1')

    if (off < 0) {
      hits.push({ file: name, state: 'уже пропатчено' })
      continue
    }

    backup(file)
    const cut = at + off
    const next = src.slice(0, cut) + 'spellCheck:!0' + src.slice(cut + 'spellCheck:!1'.length)
    fs.writeFileSync(file, next, 'utf8')
    hits.push({ file: name, state: 'пропатчено' })
  }

  if (!hits.length) {
    return { ok: false, why: 'не нашёл функцию с настройками поля ввода (сборка изменилась?)' }
  }
  return { ok: true, hits }
}

function main() {
  say('HERMES ru-spellcheck: старт')
  if (!fs.existsSync(DIST)) {
    say(`ОШИБКА: не найден каталог приложения: ${DIST}`)
    flush()
    process.exit(1)
  }
  say(`каталог: ${DIST}`)

  const mainRes = patchMain(DIST)
  say(`electron-main.mjs (языки словаря): ${mainRes.ok ? mainRes.state : 'ОШИБКА — ' + mainRes.why}`)

  const rend = patchRenderer(DIST)
  if (rend.ok) {
    for (const h of rend.hits) say(`assets/${h.file} (spellCheck поля ввода): ${h.state}`)
  } else {
    say(`assets: ОШИБКА — ${rend.why}`)
  }

  const dict = ensureDictionaries()
  say(`словари Hunspell: ${dict.state}`)

  const ok = mainRes.ok && rend.ok && dict.ok
  say(ok ? 'ИТОГ: всё на месте, перезапустите Hermes для применения.' : 'ИТОГ: есть ошибки — см. выше.')
  flush()
  process.exit(ok ? 0 : 1)
}

main()
