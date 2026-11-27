// 가져오기 파일 읽기: 엑셀(xlsx)·JSON → 머리글 + 글 행. CSV는 ops.readCsv
import { strFromU8, unzipSync } from 'fflate'
import { decodeText, detectEncoding } from '../shared/csv'
import { t } from '../shared/i18n'

export interface Table {
  headers: string[]
  rows: string[][]
  /** 엑셀 시트 이름들 */
  sheets?: string[]
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unxml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)))
  return ENT[e] ?? m
})
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
/** <t> 조각들을 이어 붙인 글 (서식이 섞인 글은 <r><t>…</t></r> 여러 개) */
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('')

/** A1의 열 글자 → 0부터 */
function colIndex(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0)
    if (c < 65 || c > 90) break
    n = n * 26 + (c - 64)
  }
  return n - 1
}

const pad = (n: number) => String(n).padStart(2, '0')
/** 엑셀 날짜 일련번호 → 글 (1900 체계) */
function excelDate(v: number): string {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000))
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  if (v < 1) return time
  return Number.isInteger(v) ? date : `${date} ${time}`
}

export function readXlsx(bytes: Uint8Array, sheet: number, header: boolean): Table {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new Error(t('엑셀(xlsx) 파일을 읽지 못했어요'))
  }
  const get = (p: string) => (files[p] ? strFromU8(files[p]) : '')
  const wb = get('xl/workbook.xml')
  if (!wb) throw new Error(t('엑셀(xlsx) 파일을 읽지 못했어요'))
  const rels = new Map([...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id') ?? '', attr(m[0], 'Target') ?? '']))
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: unxml(attr(m[0], 'name') ?? ''), rid: attr(m[0], 'r:id') ?? '' }))
  if (!sheets.length) throw new Error(t('엑셀 파일에 시트가 없어요'))
  const pick = sheets[Math.min(Math.max(0, sheet), sheets.length - 1)]
  let target = rels.get(pick.rid) ?? 'worksheets/sheet1.xml'
  target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '')
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]))
  // 날짜 서식인 칸 모양(s) 찾기
  const styles = get('xl/styles.xml')
  const custom = new Map([...styles.matchAll(/<numFmt\b[^>]*>/g)].map((m) => [Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') ?? '']))
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? ''
  const isDate = [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0)
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')
    return /[ymdhs]/i.test(code) && !/^general$/i.test(code)
  })
  const xml = get(target)
  const rows: string[][] = []
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rowNo = Number(attr(rm[1] ?? rm[3] ?? '', 'r') ?? rows.length + 1)
    while (rows.length < rowNo - 1) rows.push([])
    const row: string[] = []
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1]
      const body = cm[2] ?? ''
      const ref = attr(a, 'r')
      const idx = ref ? colIndex(ref) : row.length
      const type = attr(a, 't') ?? 'n'
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let out = ''
      if (type === 's') out = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') out = texts(body)
      else if (type === 'b') out = v === '1' ? 'true' : v === '0' ? 'false' : ''
      else if (type === 'str' || type === 'e' || type === 'd') out = unxml(v ?? '')
      else if (v !== undefined) {
        const num = Number(v)
        out = isDate[Number(attr(a, 's') ?? -1)] && Number.isFinite(num) ? excelDate(num) : v
      }
      while (row.length < idx) row.push('')
      row[idx] = out
    }
    rows.push(row)
  }
  while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop()
  return withHeader(rows, header, sheets.map((s) => s.name))
}

function withHeader(all: string[][], header: boolean, sheets?: string[]): Table {
  const width = Math.max(0, ...all.slice(0, 1000).map((r) => r.length))
  const headers = header && all.length ? Array.from({ length: width }, (_, i) => all[0][i] ?? '') : Array.from({ length: width }, (_, i) => t('열 {n}', { n: i + 1 }))
  return { headers, rows: header ? all.slice(1) : all, ...(sheets ? { sheets } : {}) }
}

const cellText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** JSON: 객체 배열(열 = 키들) · 배열의 배열 · 배열 하나를 담은 객체({"data": [...]}) */
export function readJson(bytes: Uint8Array, header: boolean): Table {
  let data: unknown
  try {
    data = JSON.parse(decodeText(Buffer.from(bytes), detectEncoding(Buffer.from(bytes))).replace(/^﻿/, ''))
  } catch {
    throw new Error(t('JSON 파일을 읽지 못했어요'))
  }
  if (!Array.isArray(data) && data && typeof data === 'object') {
    const inner = Object.values(data as Record<string, unknown>).find(Array.isArray)
    data = inner ?? [data]
  }
  if (!Array.isArray(data)) throw new Error(t('JSON은 배열(행 목록)이어야 해요'))
  if (data.every(Array.isArray)) return withHeader((data as unknown[][]).map((r) => r.map(cellText)), header)
  const keys: string[] = []
  const seen = new Set<string>()
  for (const o of data.slice(0, 5000)) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue
    for (const k of Object.keys(o)) {
      if (seen.has(k)) continue
      seen.add(k)
      keys.push(k)
    }
  }
  return { headers: keys, rows: data.map((o) => keys.map((k) => (o && typeof o === 'object' ? cellText((o as Record<string, unknown>)[k]) : ''))) }
}
