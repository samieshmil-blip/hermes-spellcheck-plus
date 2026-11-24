/**
 * Пересобирает desktop/plugin.js: скачивает частотные списки FrequencyWords,
 * упаковывает их в gzip+base64 и подставляет в tools/plugin.template.js.
 *
 *   node tools/build-dictionaries.mjs            # скачать списки и собрать
 *   node tools/build-dictionaries.mjs --offline  # взять уже скачанное из data/
 *
 * Списки: https://github.com/hermitdave/FrequencyWords (MIT), срез 2018.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import https from 'node:https'

const ROOT = path.resolve(import.meta.dirname, '..')
const DATA = path.join(ROOT, 'data')
const TEMPLATE = path.join(ROOT, 'tools', 'plugin.template.js')
const OUT = path.join(ROOT, 'desktop', 'plugin.js')
const VERSION = '0.2.0'

const BASE = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018'

/**
 * label — подпись в настройках (на своём языке),
 * alphabet — буквы для генерации правок (последним идёт «-», он литерал),
 * script — что вообще считаем словом этого языка,
 * file/limit — источник частотного списка и сколько слов берём.
 */
const LANGS = {
  ru: {
    label: 'Русский',
    alphabet: 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
    script: '^[\\u0400-\\u04FF-]+$',
    file: 'ru_full',
    limit: 200000
  },
  en: { label: 'English', alphabet: 'abcdefghijklmnopqrstuvwxyz', script: '^[A-Za-z-]+$', file: 'en_50k', limit: 50000 },
  uk: { label: 'Українська', alphabet: 'абвгґдеєжзиіїйклмнопрстуфхцчшщьюя', script: '^[\\u0400-\\u04FF-]+$', file: 'uk_50k', limit: 50000 },
  de: { label: 'Deutsch', alphabet: 'abcdefghijklmnopqrstuvwxyzäöüß', script: '^[A-Za-zÄÖÜäöüß-]+$', file: 'de_50k', limit: 50000 },
  fr: { label: 'Français', alphabet: 'abcdefghijklmnopqrstuvwxyzàâçéèêëîïôûùüÿœæ', script: '^[A-Za-zÀ-ÿœæ-]+$', file: 'fr_50k', limit: 50000 },
  es: { label: 'Español', alphabet: 'abcdefghijklmnñopqrstuvwxyzáéíóúü', script: '^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ-]+$', file: 'es_50k', limit: 50000 },
  it: { label: 'Italiano', alphabet: 'abcdefghilmnopqrstuvzàèéìíòóùú', script: '^[A-Za-zÀ-ÿ-]+$', file: 'it_50k', limit: 50000 },
  pt: { label: 'Português', alphabet: 'abcdefghijklmnopqrstuvwxyzáâãàçéêíóôõúü', script: '^[A-Za-zÀ-ÿ-]+$', file: 'pt_50k', limit: 50000 },
  pl: { label: 'Polski', alphabet: 'aąbcćdeęfghijklłmnńoópqrsśtuvwxyzźż', script: '^[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż-]+$', file: 'pl_50k', limit: 50000 },
  tr: { label: 'Türkçe', alphabet: 'abcçdefgğhıijklmnoöprsştuüvyz', script: '^[A-Za-zÇĞİıÖŞÜçğöşü-]+$', file: 'tr_50k', limit: 50000 }
}

const SOURCES = {
  ru_full: `${BASE}/ru/ru_full.txt`,
  en_50k: `${BASE}/en/en_50k.txt`,
  uk_50k: `${BASE}/uk/uk_50k.txt`,
  de_50k: `${BASE}/de/de_50k.txt`,
  fr_50k: `${BASE}/fr/fr_50k.txt`,
  es_50k: `${BASE}/es/es_50k.txt`,
  it_50k: `${BASE}/it/it_50k.txt`,
  pt_50k: `${BASE}/pt/pt_50k.txt`,
  pl_50k: `${BASE}/pl/pl_50k.txt`,
  tr_50k: `${BASE}/tr/tr_50k.txt`
}

const wordPattern = lang => {
  const alphabet = LANGS[lang].alphabet
  return new RegExp(`^[${alphabet}]{2,24}$`)
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, response => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${url}`))
          return
        }
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          fs.writeFileSync(dest, Buffer.concat(chunks))
          resolve(dest)
        })
      })
      .on('error', reject)
  })
}

function pick(file, limit, pattern) {
  const words = []
  const seen = new Set()

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const space = line.lastIndexOf(' ')
    if (space < 0) continue

    const word = line.slice(0, space).toLowerCase()
    const frequency = Number(line.slice(space + 1)) || 0

    if (frequency < 2 || !pattern.test(word) || seen.has(word)) continue

    seen.add(word)
    words.push(word)
    if (words.length >= limit) break
  }

  return words
}

const gzip64 = words => zlib.gzipSync(Buffer.from(words.join(' '), 'utf8'), { level: 9 }).toString('base64')

async function main() {
  const offline = process.argv.includes('--offline')
  fs.mkdirSync(DATA, { recursive: true })

  const dictionaries = []
  const languages = []

  for (const [lang, spec] of Object.entries(LANGS)) {
    const dest = path.join(DATA, `${spec.file}.txt`)

    if (!offline || !fs.existsSync(dest)) {
      process.stdout.write(`скачиваю ${lang}… `)
      await download(SOURCES[spec.file], dest)
      console.log('готово')
    }

    const words = pick(dest, spec.limit, wordPattern(lang))
    dictionaries.push(`  ${lang}: '${gzip64(words)}'`)
    languages.push(
      `  ${lang}: {\n` +
        `    label: '${spec.label}',\n` +
        `    alphabet: '${spec.alphabet}',\n` +
        `    script: /${spec.script}/\n` +
        `  }`
    )
    console.log(`  ${lang}: ${words.length} слов`)
  }

  const source = fs
    .readFileSync(TEMPLATE, 'utf8')
    .replace('__DICTIONARIES__', dictionaries.join(',\n'))
    .replace('__LANGUAGES__', languages.join(',\n'))
    .replace('__LANGUAGES_LIST__', Object.values(LANGS).map(spec => spec.label).join(', '))
    .replace('__VERSION__', VERSION)

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, source, 'utf8')
  console.log(`desktop/plugin.js: ${(source.length / 1048576).toFixed(2)} МБ, версия ${VERSION}`)
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
