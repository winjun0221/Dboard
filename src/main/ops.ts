// 표 데이터 보기·고치기, CSV 내보내기·가져오기 (Electron 없이 — 테스트에서 그대로 쓴다)
import fs from 'node:fs'
import { countSql, selectAll, selectPage } from '../shared/dialect'
import { buildChange, buildInsertMany } from '../shared/edit'
import { csvLine, decodeText, detectDelimiter, detectEncoding, parseCsv } from '../shared/csv'
import { t } from '../shared/i18n'
import type { Cell, CsvPreview, CsvReadOptions, CsvWriteOptions, DataQuery, ImportOptions, RowChange, SortKey, TableData, TableKey, TableRef } from '../shared/types'
import { elapsed, type Session } from './drivers/base'
import type { Live } from './conn'

const keyCache = new Map<string, TableKey>()
const keyId = (live: Live, ref: TableRef) => `${live.config.id}\u0000${ref.db}\u0000${ref.schema}\u0000${ref.table}`

/** 행을 찾는 열: 기본 키 → SQLite rowid → 모든 열 */
export async function tableKey(live: Live, ref: TableRef, refresh = false): Promise<TableKey> {
  const id = keyId(live, ref)
  const cached = keyCache.get(id)
  if (cached && !refresh) return cached
  const s = await live.metaSession(ref.db)
  const cols = await live.mod.columns(s, ref)
  if (cols.length === 0) throw new Error(t('표를 찾지 못했어요: {name}', { name: ref.table }))
  const pk = cols.filter((c) => c.pk).map((c) => c.name)
  let key: TableKey
  if (pk.length) key = { kind: 'pk', columns: pk }
  else if (live.mod.dialect === 'sqlite') {
    // 뷰는 rowid가 없다
    const objs = await live.mod.objects(s, ref.db, ref.schema, { showSystem: true })
    const isView = objs.find((o) => o.name === ref.table)?.kind === 'view'
    key = isView ? { kind: 'all', columns: cols.map((c) => c.name) } : { kind: 'rowid', columns: [] }
  } else key = { kind: 'all', columns: cols.map((c) => c.name) }
  keyCache.set(id, key)
  return key
}

export async function tableData(live: Live, ref: TableRef, q: DataQuery): Promise<TableData> {
  const t0 = performance.now()
  const key = await tableKey(live, ref, q.offset === 0)
  const s = await live.metaSession(ref.db)
  const withRowid = key.kind === 'rowid'
  const r = await s.query(selectPage(live.mod.dialect, ref, q, withRowid))
  let columns = r.columns
  let rows = r.rows
  let rowids: Cell[] | null = null
  if (withRowid) {
    rowids = rows.map((x) => x[0])
    rows = rows.map((x) => x.slice(1))
    columns = columns.slice(1)
  }
  const hasMore = rows.length > q.limit
  if (hasMore) {
    rows = rows.slice(0, q.limit)
    rowids = rowids?.slice(0, q.limit) ?? null
  }
  return { columns, rows, rowids, hasMore, key, ms: elapsed(t0) }
}

export async function countRows(live: Live, ref: TableRef, filter: string): Promise<number> {
  const s = await live.metaSession(ref.db)
  const r = await s.query(countSql(live.mod.dialect, ref, filter))
  return Number(r.rows[0]?.[0] ?? 0)
}

/** 바뀜을 한 트랜잭션으로 저장. UPDATE·DELETE가 한 행이 아닌 행을 바꾸면 전부 되돌린다 */
export async function applyChanges(live: Live, ref: TableRef, changes: RowChange[]): Promise<number> {
  if (changes.length === 0) return 0
  const key = await tableKey(live, ref)
  const s = await live.metaSession(ref.db)
  const d = live.mod.dialect
  return s.transaction(async (tx) => {
    let n = 0
    for (const c of changes) {
      const b = buildChange(d, ref, key, c)
      const affected = await tx.exec(b.sql, b.params)
      if (b.expectOne && affected !== null && affected !== 1) {
        throw new Error(affected === 0
          ? t('바꿀 행을 찾지 못해서 저장하지 않았어요. 다른 곳에서 바뀌었을 수 있어요. 새로고침한 뒤 다시 해 주세요.')
          : t('한 행만 바뀌어야 하는데 {n}행이 바뀌려고 해서 저장하지 않았어요.', { n: affected }))
      }
      n++
    }
    return n
  })
}

// ───────── CSV 내보내기 ─────────

/** 파일에 조금씩 쓰기 (큰 결과도 메모리에 다 올리지 않음) */
async function writeCsv(file: string, o: CsvWriteOptions, run: (onColumns: (names: string[]) => void, onRows: (rows: Cell[][]) => Promise<void>) => Promise<number>): Promise<number> {
  const out = fs.createWriteStream(file, { encoding: 'utf8' })
  let failed: Error | null = null
  out.on('error', (e) => {
    failed = e
  })
  const write = (s: string) => new Promise<void>((resolve, reject) => {
    if (failed) return reject(failed)
    if (out.write(s)) return resolve()
    const done = (e?: Error) => {
      out.off('drain', done)
      out.off('error', done)
      if (e) reject(e)
      else resolve()
    }
    out.on('drain', done)
    out.on('error', done)
  })
  try {
    if (o.bom) await write('﻿')
    let header: Promise<void> = Promise.resolve()
    const n = await run(
      (names) => {
        if (o.header) header = write(csvLine(names, o.delimiter) + '\r\n')
      },
      async (rows) => {
        await header
        await write(rows.map((r) => csvLine(r, o.delimiter, o.nullText)).join('\r\n') + '\r\n')
      },
    )
    await header
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    return n
  } catch (e) {
    out.destroy()
    throw e
  }
}

export function saveRowsCsv(file: string, columns: string[], rows: Cell[][], o: CsvWriteOptions): Promise<number> {
  return writeCsv(file, o, async (onColumns, onRows) => {
    onColumns(columns)
    for (let i = 0; i < rows.length; i += 2000) await onRows(rows.slice(i, i + 2000))
    return rows.length
  })
}

export function exportSql(s: Session, sql: string, file: string, o: CsvWriteOptions): Promise<number> {
  return writeCsv(file, o, (onColumns, onRows) => s.stream(sql, (cols) => onColumns(cols.map((c) => c.name)), onRows))
}

export async function exportTable(live: Live, ref: TableRef, filter: string, order: SortKey[], file: string, o: CsvWriteOptions): Promise<number> {
  const s = await live.metaSession(ref.db)
  return exportSql(s, selectAll(live.mod.dialect, ref, filter, order), file, o)
}

// ───────── CSV 가져오기 ─────────

const MAX_CSV = 512 * 1024 * 1024

function readCsv(file: string, o: CsvReadOptions) {
  const size = fs.statSync(file).size
  if (size > MAX_CSV) throw new Error(t('CSV 파일이 너무 커요 (512MB까지)'))
  const bytes = fs.readFileSync(file)
  const encoding = o.encoding === 'auto' ? detectEncoding(bytes) : o.encoding
  const text = decodeText(bytes, encoding)
  const delimiter = o.delimiter === 'auto' ? detectDelimiter(text) : o.delimiter
  const all = parseCsv(text, delimiter)
  const width = Math.max(0, ...all.slice(0, 1000).map((r) => r.length))
  const headers = o.header && all.length ? all[0] : Array.from({ length: width }, (_, i) => t('열 {n}', { n: i + 1 }))
  const rows = o.header ? all.slice(1) : all
  return { encoding, delimiter, headers, rows }
}

export function previewCsv(file: string, o: CsvReadOptions, name: string): CsvPreview {
  const r = readCsv(file, o)
  return { path: file, name, encoding: r.encoding, delimiter: r.delimiter, headers: r.headers, rows: r.rows.slice(0, 50), total: r.rows.length }
}

export async function importCsv(live: Live, ref: TableRef, file: string, o: ImportOptions): Promise<number> {
  const r = readCsv(file, o)
  const picks = o.mapping.map((col, i) => ({ col, i })).filter((m): m is { col: string; i: number } => !!m.col)
  if (picks.length === 0) throw new Error(t('넣을 열을 하나 이상 골라 주세요'))
  const seen = new Set<string>()
  for (const p of picks) {
    if (seen.has(p.col)) throw new Error(t('같은 열을 두 번 골랐어요: {name}', { name: p.col }))
    seen.add(p.col)
  }
  const rows: Cell[][] = r.rows
    .filter((row) => !(row.length === 1 && row[0] === ''))
    .map((row) => picks.map((p) => {
      const v = row[p.i] ?? ''
      return o.emptyAsNull && v === '' ? null : v
    }))
  const s = await live.metaSession(ref.db)
  const stmts = buildInsertMany(live.mod.dialect, ref, picks.map((p) => p.col), rows)
  return s.transaction(async (tx) => {
    let done = 0
    for (const b of stmts) {
      try {
        await tx.exec(b.sql, b.params)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(t('{from}~{to}번째 행을 넣다가 실패해서 하나도 넣지 않았어요.\n{error}', { from: done + 1, to: done + b.params.length / picks.length, error: msg }))
      }
      done += b.params.length / picks.length
    }
    return done
  })
}
