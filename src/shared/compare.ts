// 스키마 비교·데이터 옮기기에 쓰는 순수 계산: 설계 맞대기(이름이 달라도 내용이 같으면 같은 것), 바뀐 점 글, 타입 바꾸기, 표 만들 설계 바꾸기, 외래 키 순서
import { t } from './i18n'
import type { DesignColumn, DesignForeignKey, DesignIndex, Dialect, TableDesign } from './types'

const low = (s: string) => s.toLowerCase()
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => low(x) === low(b[i]))
const clone = (x: TableDesign): TableDesign => JSON.parse(JSON.stringify(x)) as TableDesign

/** 비교용 타입: 대소문자 무시, MySQL 정수 표시 폭(int(11)) 무시 (tinyint(1)은 참·거짓이라 남김) */
export function normType(type: string): string {
  const x = low(type.trim()).replace(/\s+/g, ' ')
  return /^tinyint\(1\)/.test(x) ? x : x.replace(/^(tinyint|smallint|mediumint|int|integer|bigint)\(\d+\)/, '$1')
}

const ixKey = (i: DesignIndex) => `${i.unique}|${!!i.constraint}|${i.columns.map(low).join(',')}`
/** UNIQUE 제약과 고유 인덱스는 하는 일이 같아서, 내용으로 맞댈 때는 구별하지 않는다 */
const ixBody = (i: DesignIndex) => `${i.unique}|${i.columns.map(low).join(',')}`
const fkKey = (f: DesignForeignKey) => `${f.columns.map(low).join(',')}>${low(f.refTable)}(${f.refColumns.map(low).join(',')})|${f.onDelete}|${f.onUpdate}`

/**
 * 원본 설계(src)를 대상 설계(dst)에 맞대어, designSql(dst → 결과)로 대상을 원본처럼 바꾸게 한다.
 * 열은 이름으로, 인덱스·외래 키는 이름 또는 내용(열·참조)이 같으면 같은 것으로 본다 (자동 이름이 서버마다 달라서).
 * mapSchema: 원본의 참조 스키마 → 대상 스키마
 */
export function alignDesign(src: TableDesign, dst: TableDesign, mapSchema: (s: string) => string): TableDesign {
  const after = clone(src)
  after.name = dst.name
  const dstCols = new Map(dst.columns.map((c) => [low(c.name), c]))
  after.columns = src.columns.map((c) => {
    const d = dstCols.get(low(c.name))
    // 같은 타입이면 대상 표기를 그대로 써서 표시 폭 같은 차이로 바꾸지 않게
    return { ...c, name: d ? d.name : c.name, type: d && normType(d.type) === normType(c.type) ? d.type : c.type, orig: d ? d.name : null }
  })
  const rename = (n: string) => dstCols.get(low(n))?.name ?? n
  after.primaryKey = src.primaryKey.map(rename)
  const usedIx = new Set<string>()
  after.indexes = src.indexes.map((i) => {
    const cols = i.columns.map(rename)
    const byName = dst.indexes.find((x) => low(x.name) === low(i.name) && !usedIx.has(x.name))
    const byBody = byName ?? dst.indexes.find((x) => !usedIx.has(x.name) && ixBody(x) === ixBody({ ...i, columns: cols }))
    if (byBody) usedIx.add(byBody.name)
    // 내용으로 맞댄 것은 대상의 이름·형태(제약/인덱스)를 그대로 쓴다
    if (byBody && !byName) return { ...i, columns: cols, name: byBody.name, constraint: byBody.constraint, orig: byBody.name, sql: byBody.sql }
    return { ...i, columns: cols, orig: byBody ? byBody.name : null, sql: byBody?.sql }
  })
  const usedFk = new Set<string>()
  after.foreignKeys = src.foreignKeys.map((f) => {
    const g: DesignForeignKey = { ...f, columns: f.columns.map(rename), refSchema: mapSchema(f.refSchema) }
    const byName = dst.foreignKeys.find((x) => low(x.name) === low(f.name) && !usedFk.has(x.name))
    const byBody = byName ?? dst.foreignKeys.find((x) => !usedFk.has(x.name) && fkKey(x) === fkKey(g))
    if (byBody) usedFk.add(byBody.name)
    return { ...g, name: byBody && !byName ? byBody.name : g.name, orig: byBody ? byBody.name : null }
  })
  after.pkName = dst.pkName || src.pkName
  after.unsupported = dst.unsupported
  after.options = dst.options
  after.triggers = dst.triggers
  return after
}

/** 대상(before) → 맞댄 원본(after)의 바뀐 점 (사람이 읽는 글). 없으면 빈 배열 */
export function describeDiff(before: TableDesign, after: TableDesign, d: Dialect): string[] {
  const out: string[] = []
  const bCol = new Map(before.columns.map((c) => [c.name, c]))
  const kept = new Set(after.columns.filter((c) => c.orig !== null).map((c) => c.orig!))
  for (const c of after.columns) {
    if (c.orig === null) {
      out.push(t('열 추가: {name} {type}', { name: c.name, type: c.type }))
      continue
    }
    const b = bCol.get(c.orig)!
    const parts: string[] = []
    if (normType(b.type) !== normType(c.type)) parts.push(`${b.type} → ${c.type}`)
    if (b.nullable !== c.nullable) parts.push(c.nullable ? 'NULL' : 'NOT NULL')
    if (b.default.trim() !== c.default.trim()) parts.push(t('기본값 {a} → {b}', { a: b.default || '-', b: c.default || '-' }))
    if (b.autoIncrement !== c.autoIncrement) parts.push(c.autoIncrement ? t('자동 증가') : t('자동 증가 끔'))
    if (d !== 'sqlite' && b.comment !== c.comment) parts.push(t('설명'))
    if (parts.length) out.push(t('열 바뀜: {name} ({what})', { name: c.name, what: parts.join(', ') }))
  }
  for (const c of before.columns) if (!kept.has(c.name)) out.push(t('열 지우기: {name}', { name: c.name }))
  if (!same(before.primaryKey, after.primaryKey)) out.push(t('기본 키: ({a}) → ({b})', { a: before.primaryKey.join(', '), b: after.primaryKey.join(', ') }))
  const ixSame = (a: DesignIndex, b: DesignIndex) => ixKey(a) === ixKey(b) && a.name === b.name
  for (const i of after.indexes) {
    const b = i.orig !== null ? before.indexes.find((x) => x.name === i.orig) : undefined
    if (!b) out.push(t('인덱스 추가: {name}', { name: i.name }))
    else if (!ixSame(b, i)) out.push(t('인덱스 바뀜: {name}', { name: i.name }))
  }
  for (const b of before.indexes) if (!after.indexes.some((i) => i.orig === b.name)) out.push(t('인덱스 지우기: {name}', { name: b.name }))
  const fkSame = (a: DesignForeignKey, b: DesignForeignKey) => fkKey(a) === fkKey(b) && a.name === b.name && low(a.refSchema) === low(b.refSchema)
  for (const f of after.foreignKeys) {
    const b = f.orig !== null ? before.foreignKeys.find((x) => x.name === f.orig) : undefined
    if (!b) out.push(t('외래 키 추가: {name}', { name: f.name || f.columns.join(', ') }))
    else if (!fkSame(b, f)) out.push(t('외래 키 바뀜: {name}', { name: f.name || f.columns.join(', ') }))
  }
  for (const b of before.foreignKeys) if (!after.foreignKeys.some((f) => f.orig === b.name)) out.push(t('외래 키 지우기: {name}', { name: b.name || b.columns.join(', ') }))
  if (d !== 'sqlite' && before.comment !== after.comment) out.push(t('표 설명'))
  return out
}

/** 뷰 정의 비교용: 공백·대소문자·DB/스키마 이름·DEFINER 무시 */
export function normViewSql(sql: string): string {
  return low(sql)
    .replace(/definer\s*=\s*\S+/g, '')
    .replace(/(`[^`]*`|"[^"]*"|\[[^\]]*\])\s*\.\s*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;=])\s*/g, '$1')
    .replace(/;$/, '')
    .trim()
}

// ───────── 데이터 옮기기: 다른 종류 DB로 타입 바꾸기 ─────────

type Kind = 'tinyint' | 'smallint' | 'int' | 'bigint' | 'bool' | 'decimal' | 'real' | 'double' | 'varchar' | 'char' | 'text' | 'date' | 'time' | 'datetime' | 'tz' | 'binary' | 'json' | 'uuid' | 'other'

/** ClickHouse 타입 이름 (Int8 = 1바이트 — PostgreSQL int8과 다르다) */
const CH_KIND: Record<string, Kind> = {
  int8: 'tinyint', uint8: 'smallint', int16: 'smallint', uint16: 'int', int32: 'int', uint32: 'bigint', int64: 'bigint',
  uint64: 'decimal', int128: 'decimal', uint128: 'decimal', int256: 'decimal', uint256: 'decimal',
  float32: 'real', float64: 'double', bool: 'bool', string: 'text', fixedstring: 'char', uuid: 'uuid',
  date: 'date', date32: 'date', datetime: 'datetime', datetime64: 'datetime', decimal: 'decimal', decimal32: 'decimal', decimal64: 'decimal', decimal128: 'decimal', decimal256: 'decimal',
  enum8: 'varchar', enum16: 'varchar', json: 'json', ipv4: 'varchar', ipv6: 'varchar',
}

function kindOf(from: Dialect, type: string): { kind: Kind; args: string } {
  let x = low(type.trim()).replace(/\s+/g, ' ')
  if (from === 'clickhouse') {
    // Nullable(…)·LowCardinality(…)는 벗기고
    for (;;) {
      const w = /^(nullable|lowcardinality)\((.*)\)$/.exec(x)
      if (!w) break
      x = w[2].trim()
    }
    const c = /^([a-z0-9]+)\s*(?:\((.*)\))?$/.exec(x)
    const k = c ? CH_KIND[c[1]] : undefined
    if (!c || !k) return { kind: 'other', args: '' }
    if (k === 'varchar') return { kind: 'varchar', args: '255' }
    if (k === 'decimal') {
      const bits: Record<string, string> = { uint64: '20,0', int128: '39,0', uint128: '39,0', int256: '77,0', uint256: '78,0', decimal32: '9', decimal64: '18', decimal128: '38', decimal256: '76' }
      const p = bits[c[1]]
      // DecimalN(s)는 자릿수가 정해져 있다
      if (p && /^decimal\d+$/.test(c[1])) return { kind: k, args: `${p},${(c[2] ?? '0').trim()}` }
      return { kind: k, args: p ?? (c[2] ?? '').trim() }
    }
    if (k === 'char') return { kind: k, args: (c[2] ?? '1').trim() }
    return { kind: k, args: '' }
  }
  // Oracle: VARCHAR2(10 CHAR), TIMESTAMP(6) WITH TIME ZONE
  if (from === 'oracle') {
    x = x.replace(/\(\s*(\d+)\s+(char|byte)\s*\)/, '($1)').replace(/^timestamp(\s*\(\d+\))?\s+with\s+(local\s+)?time\s+zone$/, 'timestamp with time zone')
    const num = /^number(?:\((\d+|\*)(?:\s*,\s*(-?\d+))?\))?$/.exec(x)
    if (num) {
      const p = num[1] === '*' || num[1] === undefined ? 0 : Number(num[1])
      const sc = num[2] === undefined ? (num[1] ? 0 : -1) : Number(num[2])
      if (sc === 0 && p > 0) return { kind: p <= 4 ? 'smallint' : p <= 9 ? 'int' : p <= 18 ? 'bigint' : 'decimal', args: p > 18 ? `${p},0` : '' }
      return { kind: 'decimal', args: p ? `${p},${Math.max(0, sc)}` : '' }
    }
    const ora: Record<string, Kind> = { integer: 'bigint', int: 'bigint', smallint: 'bigint', date: 'datetime', binary_float: 'real', binary_double: 'double', long: 'text', nclob: 'text', raw: 'binary', 'long raw': 'binary', 'timestamp with time zone': 'tz', nvarchar2: 'varchar', boolean: 'bool', rowid: 'varchar', urowid: 'varchar' }
    const b = /^([a-z_ 0-9]+?)\s*(?:\(([^)]*)\))?$/.exec(x)
    if (b && ora[b[1].trim()]) return { kind: ora[b[1].trim()], args: (b[2] ?? '').trim() }
    if (b && b[1].trim() === 'float') return { kind: 'double', args: '' }
  }
  if (from === 'duckdb') {
    const duck: Record<string, Kind> = { float: 'real', hugeint: 'decimal', uhugeint: 'decimal', ubigint: 'decimal', uinteger: 'bigint', usmallint: 'int', utinyint: 'smallint', timestamp_s: 'datetime', timestamp_ms: 'datetime', timestamp_ns: 'datetime', 'timestamp with time zone': 'tz', interval: 'varchar' }
    const k = duck[x]
    if (k) return { kind: k, args: k === 'decimal' ? (x === 'ubigint' ? '20,0' : '38,0') : k === 'varchar' ? '100' : '' }
  }
  const m = /^([a-z][a-z0-9_ ]*?)\s*(?:\(([^)]*)\))?\s*(unsigned|signed)?\s*(\[\])?$/.exec(x)
  if (!m || m[4]) return { kind: 'other', args: '' }
  const base = m[1].trim()
  const args = (m[2] ?? '').trim()
  if (from === 'mysql' && base === 'tinyint' && args === '1') return { kind: 'bool', args: '' }
  if (from === 'mysql' && base === 'bit' && (args === '1' || !args)) return { kind: 'bool', args: '' }
  const table: Record<string, Kind> = {
    tinyint: 'tinyint', smallint: 'smallint', int2: 'smallint', smallserial: 'smallint', mediumint: 'int', int: 'int', integer: 'int', int4: 'int', serial: 'int',
    bigint: 'bigint', int8: 'bigint', bigserial: 'bigint', boolean: 'bool', bool: 'bool', bit: 'bool',
    decimal: 'decimal', numeric: 'decimal', money: 'decimal', smallmoney: 'decimal', number: 'decimal',
    real: 'real', float4: 'real', double: 'double', 'double precision': 'double', float8: 'double', float: 'double',
    varchar: 'varchar', 'character varying': 'varchar', nvarchar: 'varchar', varchar2: 'varchar', char: 'char', character: 'char', nchar: 'char', bpchar: 'char',
    text: 'text', tinytext: 'text', mediumtext: 'text', longtext: 'text', ntext: 'text', clob: 'text', citext: 'text', xml: 'text', enum: 'varchar', set: 'varchar',
    date: 'date', time: 'time', 'time without time zone': 'time', datetime: 'datetime', datetime2: 'datetime', smalldatetime: 'datetime', timestamp: 'datetime', 'timestamp without time zone': 'datetime',
    timestamptz: 'tz', 'timestamp with time zone': 'tz', datetimeoffset: 'tz',
    blob: 'binary', tinyblob: 'binary', mediumblob: 'binary', longblob: 'binary', bytea: 'binary', varbinary: 'binary', binary: 'binary', image: 'binary',
    json: 'json', jsonb: 'json', uuid: 'uuid', uniqueidentifier: 'uuid',
  }
  let kind = table[base] ?? 'other'
  if (from === 'sqlite') {
    // SQLite 타입 이름 규칙 (INT가 들어가면 정수 등)
    if (kind === 'other') kind = /int/.test(base) ? 'bigint' : /char|clob|text/.test(base) ? 'text' : /blob/.test(base) ? 'binary' : /real|floa|doub/.test(base) ? 'double' : 'decimal'
    if (kind === 'int') kind = 'bigint'
  }
  if (base === 'enum' || base === 'set') return { kind: 'varchar', args: '255' }
  if ((kind === 'varchar' || kind === 'char') && (args === 'max' || args === '-1' || !args)) return { kind: kind === 'char' && !args ? 'char' : 'text', args: kind === 'char' && !args ? '1' : '' }
  return { kind, args }
}

/** 타입을 다른 종류 DB 이름으로. 같은 방언이면 그대로 */
export function mapType(from: Dialect, to: Dialect, type: string): string {
  if (from === to) return type
  const { kind, args } = kindOf(from, type)
  const n = Number.parseInt(args, 10)
  const dec = args && /^\d+\s*(,\s*\d+)?$/.test(args) ? `(${args.replace(/\s+/g, '')})` : ''
  switch (to) {
    case 'sqlite':
      return { tinyint: 'INTEGER', smallint: 'INTEGER', int: 'INTEGER', bigint: 'INTEGER', bool: 'INTEGER', decimal: 'NUMERIC', real: 'REAL', double: 'REAL', binary: 'BLOB' }[kind as string] ?? 'TEXT'
    case 'mysql':
      if (kind === 'varchar') return n > 16000 ? 'longtext' : `varchar(${n || 255})`
      if (kind === 'char') return n > 255 ? `varchar(${n})` : `char(${n || 1})`
      if (kind === 'decimal') return `decimal${dec || '(38,10)'}`
      return { tinyint: 'tinyint', smallint: 'smallint', int: 'int', bigint: 'bigint', bool: 'tinyint(1)', real: 'float', double: 'double', text: 'longtext', date: 'date', time: 'time', datetime: 'datetime(6)', tz: 'datetime(6)', binary: 'longblob', json: 'json', uuid: 'char(36)' }[kind as string] ?? 'longtext'
    case 'postgres':
      if (kind === 'varchar') return `varchar(${n || 255})`
      if (kind === 'char') return `char(${n || 1})`
      if (kind === 'decimal') return `numeric${dec}`
      return { tinyint: 'smallint', smallint: 'smallint', int: 'integer', bigint: 'bigint', bool: 'boolean', real: 'real', double: 'double precision', text: 'text', date: 'date', time: 'time', datetime: 'timestamp', tz: 'timestamptz', binary: 'bytea', json: 'jsonb', uuid: 'uuid' }[kind as string] ?? 'text'
    case 'oracle':
      if (kind === 'varchar') return n > 4000 ? 'CLOB' : `VARCHAR2(${n || 255} CHAR)`
      if (kind === 'char') return n > 2000 ? 'CLOB' : `CHAR(${n || 1} CHAR)`
      if (kind === 'decimal') return `NUMBER${dec}`
      return { tinyint: 'NUMBER(3)', smallint: 'NUMBER(5)', int: 'NUMBER(10)', bigint: 'NUMBER(19)', bool: 'NUMBER(1)', real: 'BINARY_FLOAT', double: 'BINARY_DOUBLE', text: 'CLOB', date: 'DATE', time: 'VARCHAR2(20)', datetime: 'TIMESTAMP(6)', tz: 'TIMESTAMP(6) WITH TIME ZONE', binary: 'BLOB', json: 'CLOB', uuid: 'VARCHAR2(36)' }[kind as string] ?? 'CLOB'
    case 'clickhouse':
      if (kind === 'decimal') return `Decimal${dec || '(38,10)'}`
      if (kind === 'char' && n > 0) return 'String'
      return { tinyint: 'Int8', smallint: 'Int16', int: 'Int32', bigint: 'Int64', bool: 'Bool', real: 'Float32', double: 'Float64', date: 'Date32', datetime: 'DateTime64(6)', tz: 'DateTime64(6)', uuid: 'UUID' }[kind as string] ?? 'String'
    case 'duckdb':
      if (kind === 'varchar' || kind === 'char') return 'VARCHAR'
      if (kind === 'decimal') return `DECIMAL${dec || '(38,10)'}`
      return { tinyint: 'TINYINT', smallint: 'SMALLINT', int: 'INTEGER', bigint: 'BIGINT', bool: 'BOOLEAN', real: 'FLOAT', double: 'DOUBLE', text: 'VARCHAR', date: 'DATE', time: 'TIME', datetime: 'TIMESTAMP', tz: 'TIMESTAMPTZ', binary: 'BLOB', json: 'VARCHAR', uuid: 'UUID' }[kind as string] ?? 'VARCHAR'
    default:
      if (kind === 'varchar') return n > 4000 ? 'nvarchar(max)' : `nvarchar(${n || 255})`
      if (kind === 'char') return n > 4000 ? 'nvarchar(max)' : `nchar(${n || 1})`
      if (kind === 'decimal') return `decimal${dec || '(38,10)'}`
      return { tinyint: 'tinyint', smallint: 'smallint', int: 'int', bigint: 'bigint', bool: 'bit', real: 'real', double: 'float', text: 'nvarchar(max)', date: 'date', time: 'time', datetime: 'datetime2', tz: 'datetimeoffset', binary: 'varbinary(max)', json: 'nvarchar(max)', uuid: 'uniqueidentifier' }[kind as string] ?? 'nvarchar(max)'
  }
}

/** 기본값을 다른 DB로: 숫자·글자·현재 시각만 옮기고 나머지는 뺀다 */
export function mapDefault(expr: string, to: Dialect): string {
  let e = expr.trim()
  while (/^\(.*\)$/s.test(e)) e = e.slice(1, -1).trim()
  e = e.replace(/::[\w\s]+(\[\])?$/i, '').trim()
  if (/^[+-]?\d+(\.\d+)?$/.test(e)) return e
  const str = /^N?'((?:[^']|'')*)'$/s.exec(e)
  if (str) return to === 'mssql' ? `N'${str[1]}'` : `'${str[1]}'`
  if (/^(now\(\)|now64\(\d*\)|current_timestamp(\(\d*\))?|getdate\(\)|sysdatetime\(\)|localtimestamp(\(\d*\))?|datetime\('now'\)|sysdate|systimestamp)$/i.test(e)) return to === 'clickhouse' ? 'now64(6)' : 'CURRENT_TIMESTAMP'
  if (/^(true|false)$/i.test(e)) return to === 'postgres' || to === 'duckdb' || to === 'clickhouse' ? low(e) : low(e) === 'true' ? '1' : '0'
  return ''
}

/** 데이터 옮기기에서 대상에 만들 표 설계: 타입·기본값을 대상 DB에 맞추고, 외래 키·계산 열은 뺀다 */
export function convertDesign(src: TableDesign, from: Dialect, to: Dialect): TableDesign {
  const keyCols = new Set([...src.primaryKey, ...src.indexes.flatMap((i) => i.columns)].map(low))
  const columns: DesignColumn[] = src.columns.filter((c) => !c.generated).map((c) => {
    let type = mapType(from, to, c.type)
    // 키·인덱스 열은 길이 없는 글 타입이 안 되는 DB가 있다
    if (keyCols.has(low(c.name))) {
      if (to === 'mysql' && /^(long|medium|tiny)?text$/i.test(type)) type = 'varchar(255)'
      if (to === 'mssql' && /^nvarchar\(max\)$/i.test(type)) type = 'nvarchar(450)'
      if (to === 'oracle' && type === 'CLOB') type = 'VARCHAR2(1000 CHAR)'
    }
    const serial = /^nextval\(/i.test(c.default.trim())
    return {
      name: c.name,
      type,
      nullable: c.nullable,
      default: from === to ? c.default : serial ? '' : mapDefault(c.default, to),
      autoIncrement: c.autoIncrement || serial,
      comment: to === 'sqlite' ? '' : c.comment,
      generated: false,
      orig: null,
    }
  })
  const names = new Set(columns.map((c) => low(c.name)))
  const primaryKey = src.primaryKey.filter((n) => names.has(low(n)))
  // SQLite 자동 증가는 INTEGER 기본 키 하나에만
  if (to === 'sqlite') {
    const ok = primaryKey.length === 1 && columns.some((c) => low(c.name) === low(primaryKey[0]) && c.type === 'INTEGER')
    for (const c of columns) if (c.autoIncrement && !(ok && low(c.name) === low(primaryKey[0]))) c.autoIncrement = false
  }
  // DuckDB·ClickHouse에는 자동 증가가 없다 (옮기는 값은 그대로 들어간다)
  if (to === 'duckdb' || to === 'clickhouse') for (const c of columns) c.autoIncrement = false
  // ClickHouse 정렬 키(기본 키) 열은 NULL일 수 없다
  if (to === 'clickhouse') for (const c of columns) if (primaryKey.some((p) => low(p) === low(c.name))) c.nullable = false
  for (const c of columns) if (c.autoIncrement && to !== 'mysql') c.default = ''
  const indexes = to === 'clickhouse' ? [] : src.indexes
    .filter((i) => i.columns.every((c) => names.has(low(c))))
    .map((i) => ({ name: i.name.startsWith('sqlite_') ? `uq_${src.name}_${i.columns.join('_')}` : i.name, columns: i.columns, unique: i.unique, orig: null, ...(i.constraint && to !== 'sqlite' ? { constraint: true } : {}) }))
  return {
    name: src.name,
    comment: to === 'sqlite' ? '' : src.comment,
    columns,
    primaryKey,
    pkName: '',
    indexes,
    foreignKeys: [],
    unsupported: [],
    ...(from === to && src.options ? { options: src.options } : {}),
  }
}

/** 외래 키 부모가 먼저 오게 (이름 목록 안에서만, 고리는 원래 순서대로) */
export function orderByParents(names: string[], parentsOf: (name: string) => string[]): string[] {
  const set = new Set(names)
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (n: string, stack: Set<string>) => {
    if (seen.has(n) || stack.has(n)) return
    stack.add(n)
    for (const p of parentsOf(n)) if (set.has(p) && p !== n) visit(p, stack)
    stack.delete(n)
    seen.add(n)
    out.push(n)
  }
  for (const n of names) visit(n, new Set())
  return out
}
