// CSV 읽기·쓰기 (RFC 4180: 큰따옴표로 감싸기, 안의 큰따옴표는 두 번, 감싼 칸 안의 줄바꿈 허용)
import { isBin, type Cell, type CsvDelimiter } from './types'

export function csvField(s: string, delim: string): string {
  return s.includes(delim) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function cellText(v: Cell, nullText = ''): string {
  if (v === null) return nullText
  if (isBin(v)) return '0x' + v.bin
  return String(v)
}

export function csvLine(values: Cell[], delim: string, nullText = ''): string {
  return values.map((v) => csvField(cellText(v, nullText), delim)).join(delim)
}

/** 글 전체를 행들로. 끝의 빈 줄은 버린다 */
export function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const n = text.length
  if (text.charCodeAt(0) === 0xfeff) i = 1
  let fieldStart = true
  while (i < n) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && fieldStart) {
      quoted = true
      fieldStart = false
      i++
      continue
    }
    if (text.startsWith(delim, i)) {
      row.push(field)
      field = ''
      fieldStart = true
      i += delim.length
      continue
    }
    if (c === '\r' || c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      fieldStart = true
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += c
    fieldStart = false
    i++
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // 끝의 완전히 빈 줄
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop()
  return rows
}

/** 처음 몇 줄을 보고 구분자 고르기: 줄마다 같은 수로 나뉘는 것 중 칸이 가장 많은 것 */
export function detectDelimiter(text: string): CsvDelimiter {
  const sample = text.slice(0, 64 * 1024)
  let best: CsvDelimiter = ','
  let bestScore = 0
  for (const d of [',', '\t', ';', '|'] as CsvDelimiter[]) {
    const rows = parseCsv(sample, d).slice(0, 20)
    if (rows.length === 0) continue
    const counts = rows.map((r) => r.length)
    const first = counts[0]
    if (first < 2) continue
    const same = counts.filter((c) => c === first).length / counts.length
    const score = same * first
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

/** UTF-8로 올바르게 읽히면 utf8, 아니면 한국 엑셀이 흔히 쓰는 EUC-KR(CP949) */
export function detectEncoding(bytes: Uint8Array): 'utf8' | 'euc-kr' {
  try {
    // 앞 4MB만 본다. stream: true라 자른 곳이 글자 중간이어도 오류가 아니다
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)), { stream: true })
    return 'utf8'
  } catch {
    return 'euc-kr'
  }
}

export function decodeText(bytes: Uint8Array, enc: 'utf8' | 'euc-kr'): string {
  return new TextDecoder(enc === 'utf8' ? 'utf-8' : 'euc-kr').decode(bytes)
}
