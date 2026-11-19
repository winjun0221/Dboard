// 방언별 SQL 조각: 이름 따옴표, 표 전체 이름, 값 글자(미리 보기용), 자리 표시(?, $1, @p1), 페이지 나누기
import { isBin, type Cell, type Dialect, type SortKey, type TableRef } from './types'

/** 이름(표·열·DB) 따옴표. 안에 든 따옴표는 두 번 써서 SQL이 깨지지 않게 */
export function quoteIdent(d: Dialect, name: string): string {
  if (d === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  if (d === 'mssql') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}

/** 표 전체 이름: SQLite "main"."t" · MySQL `db`.`t` · PostgreSQL "schema"."t"(연결이 이미 그 DB) · SQL Server [db].[schema].[t] */
export function qualify(d: Dialect, ref: TableRef): string {
  const q = (n: string) => quoteIdent(d, n)
  if (d === 'sqlite') return ref.db ? `${q(ref.db)}.${q(ref.table)}` : q(ref.table)
  if (d === 'mysql') return ref.db ? `${q(ref.db)}.${q(ref.table)}` : q(ref.table)
  if (d === 'postgres') return ref.schema ? `${q(ref.schema)}.${q(ref.table)}` : q(ref.table)
  return [ref.db, ref.schema || 'dbo', ref.table].filter((x, i) => x || i > 0).map(q).join('.')
}

/** 실행할 때 쓰는 자리 표시 (n은 1부터) */
export function placeholder(d: Dialect, n: number): string {
  if (d === 'postgres') return '$' + n
  if (d === 'mssql') return '@p' + n
  return '?'
}

/** 미리 보기용 값 글자. 실제 실행은 자리 표시 + 값으로 보낸다 */
export function literal(d: Dialect, v: Cell): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `'${String(v)}'`
  if (typeof v === 'boolean') return d === 'postgres' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0'
  if (isBin(v)) {
    if (d === 'postgres') return `'\\x${v.bin}'::bytea`
    if (d === 'mssql') return '0x' + v.bin
    return `X'${v.bin}'`
  }
  let s = v.replace(/'/g, "''")
  if (d === 'mysql') s = s.replace(/\\/g, '\\\\')
  return d === 'mssql' ? `N'${s}'` : `'${s}'`
}

export function orderBy(d: Dialect, order: SortKey[]): string {
  return order.map((o) => quoteIdent(d, o.column) + (o.desc ? ' DESC' : '')).join(', ')
}

/** WHERE 조건 (사용자가 쓴 조건 끝의 -- 주석이 뒤를 먹지 않게 줄을 바꿔 감싼다) */
export function whereClause(filter: string): string {
  const f = filter.trim().replace(/;+\s*$/, '')
  return f ? ` WHERE (\n${f}\n)` : ''
}

/** 표 데이터 한 쪽. limit보다 하나 더 가져와서 다음이 있는지 안다 */
export function selectPage(d: Dialect, ref: TableRef, q: { filter: string; order: SortKey[]; offset: number; limit: number }, withRowid: boolean): string {
  const cols = withRowid ? `_rowid_ AS ${quoteIdent(d, '__dboard_rowid')}, *` : '*'
  const base = `SELECT ${cols} FROM ${qualify(d, ref)}${whereClause(q.filter)}`
  const ob = orderBy(d, q.order)
  if (d === 'mssql') {
    return `${base} ORDER BY ${ob || '(SELECT NULL)'} OFFSET ${q.offset} ROWS FETCH NEXT ${q.limit + 1} ROWS ONLY`
  }
  return `${base}${ob ? ' ORDER BY ' + ob : ''} LIMIT ${q.limit + 1}${q.offset ? ' OFFSET ' + q.offset : ''}`
}

export function selectAll(d: Dialect, ref: TableRef, filter: string, order: SortKey[]): string {
  const ob = orderBy(d, order)
  return `SELECT * FROM ${qualify(d, ref)}${whereClause(filter)}${ob ? ' ORDER BY ' + ob : ''}`
}

export function countSql(d: Dialect, ref: TableRef, filter: string): string {
  return `SELECT COUNT(*) FROM ${qualify(d, ref)}${whereClause(filter)}`
}

export function beginSql(d: Dialect): string {
  if (d === 'mssql') return 'BEGIN TRANSACTION'
  if (d === 'mysql') return 'START TRANSACTION'
  return 'BEGIN'
}

/** 한 번에 보낼 수 있는 자리 표시 수 (SQL Server는 2100개까지) */
export function maxParams(d: Dialect): number {
  if (d === 'mssql') return 2000
  if (d === 'sqlite') return 30000
  return 60000
}

/** 이름 앞뒤 따옴표 없이 보여 줄 표 이름 (탭 제목 등) */
export function displayName(ref: TableRef): string {
  return ref.schema ? `${ref.schema}.${ref.table}` : ref.table
}
