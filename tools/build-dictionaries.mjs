/**
 * Пересобирает desktop/plugin.js: скачивает частотные списки FrequencyWords,
 * упаковывает их в gzip+base64 и подставляет в tools/plugin.template.js.
 *
 *   node tools/build-dictionaries.mjs            # скачать списки заново
 *   node tools/build-dictionaries.mjs --offline  # использовать data/*.txt, если лежат
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import https from 'node:https'

const ROOT = path.resolve(import.meta.dirname, '..')
const DATA = path.join(ROOT, 'data')
const TEMPLATE = path.join(ROOT, 'tools', 'plugin.template.js')
const OUT = path.join(ROOT, 'desktop', 'plugin.js')

const SOURCES = {
  ru_full: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/ru/ru_full.txt',
  en_50k: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt'
}

const LIMITS = { ru: 200000, en: 50000 }
const PATTERNS = { ru: /^[\u0430-\u044f\u0451]{3,24}$/, en: /^[a-z]{2,24}$/ }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, response => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`))
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

const encode = words =>
  zlib.gzipSync(Buffer.from(words.join(' '), 'utf8'), { level: 9 }).toString('base64')

async function main() {
  const offline = process.argv.includes('--offline')
  fs.mkdirSync(DATA, { recursive: true })

  const files = {}
  for (const [key, url] of Object.entries(SOURCES)) {
    const dest = path.join(DATA, `${key}.txt`)
    if (offline && fs.existsSync(dest)) {
      files[key] = dest
      continue
    }
    process.stdout.write(`скачиваю ${key}… `)
    files[key] = await download(url, dest)
    console.log('готово')
  }

  const ru = pick(files.ru_full, LIMITS.ru, PATTERNS.ru)
  const en = pick(files.en_50k, LIMITS.en, PATTERNS.en)

  const source = fs
    .readFileSync(TEMPLATE, 'utf8')
    .replace('__RU_B64__', encode(ru))
    .replace('__EN_B64__', encode(en))
    .replace('__RU_COUNT__', String(ru.length))
    .replace('__EN_COUNT__', String(en.length))

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, source, 'utf8')

  console.log(
    `desktop/plugin.js: ru ${ru.length} слов, en ${en.length} слов, ${(source.length / 1048576).toFixed(2)} МБ`
  )
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
