// 방언별 SQL 조각: 이름 따옴표, 표 전체 이름, 값 글자(미리 보기용), 자리 표시(?, $1, @p1, :1), 페이지 나누기
import { features } from './features'
import { isBin, type Cell, type Dialect, type SortKey, type TableRef } from './types'

/** 이름(표·열·DB) 따옴표. 안에 든 따옴표는 두 번 써서(ClickHouse는 \로 가려서) SQL이 깨지지 않게 */
export function quoteIdent(d: Dialect, name: string): string {
  if (d === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  if (d === 'clickhouse') return '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'
  if (d === 'mssql') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}

/**
 * 표 전체 이름: SQLite "main"."t" · MySQL·ClickHouse `db`.`t` · PostgreSQL·Oracle "schema"."t"(연결이 이미 그 DB)
 * · SQL Server [db].[schema].[t] · DuckDB "db"."schema"."t"
 */
export function qualify(d: Dialect, ref: TableRef): string {
  const q = (n: string) => quoteIdent(d, n)
  if (d === 'sqlite' || d === 'mysql' || d === 'clickhouse') return ref.db ? `${q(ref.db)}.${q(ref.table)}` : q(ref.table)
  if (d === 'postgres' || d === 'oracle') return ref.schema ? `${q(ref.schema)}.${q(ref.table)}` : q(ref.table)
  if (d === 'duckdb') return [ref.db, ref.db || ref.schema ? ref.schema || 'main' : '', ref.table].filter(Boolean).map(q).join('.')
  return [ref.db, ref.schema || 'dbo', ref.table].filter((x, i) => x || i > 0).map(q).join('.')
}

/** 실행할 때 쓰는 자리 표시 (n은 1부터). ClickHouse는 드라이버가 ?에 값을 글자로 넣는다 */
export function placeholder(d: Dialect, n: number): string {
  if (d === 'postgres' || d === 'duckdb') return '$' + n
  if (d === 'mssql') return '@p' + n
  if (d === 'oracle') return ':' + n
  return '?'
}

/** 미리 보기용 값 글자. 실제 실행은 자리 표시 + 값으로 보낸다 (ClickHouse는 드라이버가 이 함수로 넣는다) */
export function literal(d: Dialect, v: Cell): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `'${String(v)}'`
  if (typeof v === 'boolean') return d === 'postgres' || d === 'duckdb' || d === 'clickhouse' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0'
  if (isBin(v)) {
    if (d === 'postgres') return `'\\x${v.bin}'::bytea`
    if (d === 'mssql') return '0x' + v.bin
    if (d === 'oracle') return `HEXTORAW('${v.bin}')`
    if (d === 'duckdb') return `from_hex('${v.bin}')`
    if (d === 'clickhouse') return `unhex('${v.bin}')`
    return `X'${v.bin}'`
  }
  let s = v.replace(/'/g, "''")
  if (d === 'mysql' || d === 'clickhouse') s = s.replace(/\\/g, '\\\\')
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

/** 키 없는 표의 행 번호 열 이름 (결과에서 떼어 낸다) */
export const ROWID_ALIAS = '__dboard_rowid'

/** 표 데이터 한 쪽. limit보다 하나 더 가져와서 다음이 있는지 안다 */
export function selectPage(d: Dialect, ref: TableRef, q: { filter: string; order: SortKey[]; offset: number; limit: number }, withRowid: boolean): string {
  const rowid = features(d).rowid
  const alias = quoteIdent(d, ROWID_ALIAS)
  // Oracle은 * 앞에 다른 열을 쓰려면 표 별칭이 있어야 한다
  const cols = !withRowid || !rowid ? '*' : d === 'oracle' ? `ROWIDTOCHAR(t.ROWID) AS ${alias}, t.*` : `${rowid} AS ${alias}, *`
  const base = `SELECT ${cols} FROM ${qualify(d, ref)}${withRowid && d === 'oracle' ? ' t' : ''}${whereClause(q.filter)}`
  const ob = orderBy(d, q.order)
  if (d === 'mssql') {
    return `${base} ORDER BY ${ob || '(SELECT NULL)'} OFFSET ${q.offset} ROWS FETCH NEXT ${q.limit + 1} ROWS ONLY`
  }
  if (d === 'oracle') return `${base}${ob ? ' ORDER BY ' + ob : ''} OFFSET ${q.offset} ROWS FETCH NEXT ${q.limit + 1} ROWS ONLY`
  return `${base}${ob ? ' ORDER BY ' + ob : ''} LIMIT ${q.limit + 1}${q.offset ? ' OFFSET ' + q.offset : ''}`
}

export function selectAll(d: Dialect, ref: TableRef, filter: string, order: SortKey[]): string {
  const ob = orderBy(d, order)
  return `SELECT * FROM ${qualify(d, ref)}${whereClause(filter)}${ob ? ' ORDER BY ' + ob : ''}`
}

/** 탐색기 "SELECT 앞 100행" 같은 문장 */
export function selectTop(d: Dialect, name: string, n: number): string {
  if (d === 'mssql') return `SELECT TOP ${n} * FROM ${name}`
  if (d === 'oracle') return `SELECT * FROM ${name} FETCH FIRST ${n} ROWS ONLY`
  return `SELECT * FROM ${name} LIMIT ${n}`
}

export function countSql(d: Dialect, ref: TableRef, filter: string): string {
  return `SELECT COUNT(*) FROM ${qualify(d, ref)}${whereClause(filter)}`
}

/** 트랜잭션 시작 문장. Oracle은 첫 문장에서 저절로 시작, ClickHouse는 트랜잭션이 없다 ('') */
export function beginSql(d: Dialect): string {
  if (d === 'mssql') return 'BEGIN TRANSACTION'
  if (d === 'mysql') return 'START TRANSACTION'
  if (d === 'oracle' || d === 'clickhouse') return ''
  return 'BEGIN'
}

/** 한 번에 보낼 수 있는 자리 표시 수 (SQL Server는 2100개까지) */
export function maxParams(d: Dialect): number {
  if (d === 'mssql') return 2000
  if (d === 'sqlite' || d === 'oracle') return 30000
  if (d === 'clickhouse') return 20000
  return 60000
}

/** 글 열에서 값 찾기 조건 (전체 검색 — p는 '%글%' 자리, %·_·\는 \로 가림). 대소문자는 가리지 않게 */
export function likeCond(d: Dialect, col: string, p: string): string {
  if (d === 'postgres') return `${col}::text ILIKE ${p}`
  if (d === 'duckdb') return `CAST(${col} AS VARCHAR) ILIKE ${p} ESCAPE '\\'`
  if (d === 'clickhouse') return `toString(${col}) ILIKE ${p}`
  if (d === 'oracle') return `UPPER(${col}) LIKE UPPER(${p}) ESCAPE '\\'`
  if (d === 'mysql') return `${col} LIKE ${p}`
  return `${col} LIKE ${p} ESCAPE '\\'`
}

/** 이름 앞뒤 따옴표 없이 보여 줄 표 이름 (탭 제목 등) */
export function displayName(ref: TableRef): string {
  return ref.schema ? `${ref.schema}.${ref.table}` : ref.table
}
