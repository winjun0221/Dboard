// 표 데이터 고치기 → SQL 문장. 실행은 자리 표시 + 값(params), 미리 보기는 값을 글자로 넣은 SQL
import { beginSql, literal, maxParams, placeholder, qualify, quoteIdent } from './dialect'
import { t } from './i18n'
import { isBin, type Cell, type Dialect, type RowChange, type TableKey, type TableRef } from './types'

export interface Built {
  sql: string
  params: Cell[]
  /** UPDATE·DELETE는 정확히 한 행이 바뀌어야 한다 (아니면 되돌림) */
  expectOne: boolean
}

class Params {
  list: Cell[] = []
  constructor(private d: Dialect) {}
  add(v: Cell): string {
    this.list.push(v)
    return placeholder(this.d, this.list.length)
  }
}

function where(d: Dialect, key: TableKey, values: Cell[], p: Params): string {
  if (key.kind === 'rowid') return `_rowid_ = ${p.add(values[0])}`
  const parts: string[] = []
  key.columns.forEach((col, i) => {
    const v = values[i]
    // 바이너리는 앞부분만 갖고 있어서 비교에 못 쓴다 (모든 열로 찾을 때만 생김)
    if (v !== null && isBin(v)) return
    parts.push(v === null ? `${quoteIdent(d, col)} IS NULL` : `${quoteIdent(d, col)} = ${p.add(v)}`)
  })
  if (parts.length === 0) throw new Error(t('행을 찾을 열이 없어요'))
  return parts.join(' AND ')
}

/** 키가 없는 표(모든 열로 찾기)는 같은 값의 행이 여럿일 수 있어서 한 행만 */
function limitOne(d: Dialect, key: TableKey, ref: TableRef, verb: 'UPDATE' | 'DELETE', setPart: string, cond: string): string {
  const t = qualify(d, ref)
  const head = verb === 'UPDATE' ? `UPDATE ${t} SET ${setPart}` : `DELETE FROM ${t}`
  if (key.kind !== 'all') return `${head} WHERE ${cond}`
  if (d === 'mysql') return `${head} WHERE ${cond} LIMIT 1`
  if (d === 'mssql') return verb === 'UPDATE' ? `UPDATE TOP (1) ${t} SET ${setPart} WHERE ${cond}` : `DELETE TOP (1) FROM ${t} WHERE ${cond}`
  if (d === 'postgres') return `${head} WHERE ctid = (SELECT ctid FROM ${t} WHERE ${cond} LIMIT 1)`
  return `${head} WHERE ${cond}`
}

export function buildChange(d: Dialect, ref: TableRef, key: TableKey, c: RowChange): Built {
  const p = new Params(d)
  const t = qualify(d, ref)
  if (c.op === 'insert') {
    const cols = Object.keys(c.values)
    if (cols.length === 0) {
      return { sql: d === 'mysql' ? `INSERT INTO ${t} () VALUES ()` : `INSERT INTO ${t} DEFAULT VALUES`, params: [], expectOne: false }
    }
    const vals = cols.map((col) => p.add(c.values[col]))
    return { sql: `INSERT INTO ${t} (${cols.map((x) => quoteIdent(d, x)).join(', ')}) VALUES (${vals.join(', ')})`, params: p.list, expectOne: false }
  }
  if (c.op === 'update') {
    const set = Object.keys(c.values).map((col) => `${quoteIdent(d, col)} = ${p.add(c.values[col])}`).join(', ')
    const cond = where(d, key, c.key, p)
    return { sql: limitOne(d, key, ref, 'UPDATE', set, cond), params: p.list, expectOne: true }
  }
  const cond = where(d, key, c.key, p)
  return { sql: limitOne(d, key, ref, 'DELETE', '', cond), params: p.list, expectOne: true }
}

/** 자리 표시를 값 글자로 바꾼 SQL (미리 보기). 문자열 안의 ?는 건드리지 않게 자리 표시 순서대로만 바꾼다 */
/** 키로 행 하나의 칸 하나 읽기 (값 보기: 화면 표에는 바이너리 앞부분만 있다) */
export function selectCell(d: Dialect, ref: TableRef, key: TableKey, keyValues: Cell[], column: string): Built {
  const p = new Params(d)
  const cond = where(d, key, keyValues, p)
  const col = quoteIdent(d, column)
  const sql = d === 'mssql' ? `SELECT TOP (1) ${col} FROM ${qualify(d, ref)} WHERE ${cond}` : `SELECT ${col} FROM ${qualify(d, ref)} WHERE ${cond} LIMIT 1`
  return { sql, params: p.list, expectOne: false }
}

export function inlineParams(d: Dialect, b: Built): string {
  if (d === 'postgres') return b.sql.replace(/\$(\d+)/g, (_, n: string) => literal(d, b.params[Number(n) - 1] ?? null))
  if (d === 'mssql') return b.sql.replace(/@p(\d+)/g, (_, n: string) => literal(d, b.params[Number(n) - 1] ?? null))
  let i = 0
  // 이름은 따옴표로 감싸져 있고 ?가 들어갈 일이 드물지만, 따옴표 안은 건너뛴다
  return b.sql.replace(/("(?:[^"]|"")*"|`(?:[^`]|``)*`)|\?/g, (m, quoted: string | undefined) => (quoted ? m : literal(d, b.params[i++] ?? null)))
}

export function previewChanges(d: Dialect, ref: TableRef, key: TableKey, changes: RowChange[]): string[] {
  return [beginSql(d), ...changesAsSql(d, ref, key, changes), 'COMMIT']
}

/** 바뀜 → 값을 글자로 넣은 SQL 문장들 (트랜잭션 없이 — 고른 행을 SQL로 복사할 때) */
export function changesAsSql(d: Dialect, ref: TableRef, key: TableKey, changes: RowChange[]): string[] {
  return changes.map((c) => inlineParams(d, buildChange(d, ref, key, c)))
}

/** CSV 가져오기: 여러 행 INSERT를 자리 표시 한도에 맞춰 나눈다 */
export function buildInsertMany(d: Dialect, ref: TableRef, columns: string[], rows: Cell[][]): Built[] {
  if (columns.length === 0 || rows.length === 0) return []
  const perStmt = Math.max(1, Math.min(d === 'mssql' ? 1000 : 5000, Math.floor(maxParams(d) / columns.length)))
  const head = `INSERT INTO ${qualify(d, ref)} (${columns.map((c) => quoteIdent(d, c)).join(', ')}) VALUES `
  const out: Built[] = []
  for (let i = 0; i < rows.length; i += perStmt) {
    const p = new Params(d)
    const chunk = rows.slice(i, i + perStmt)
    const values = chunk.map((r) => '(' + columns.map((_, k) => p.add(r[k] ?? null)).join(', ') + ')').join(', ')
    out.push({ sql: head + values, params: p.list, expectOne: false })
  }
  return out
}
