// PostgreSQL (pg + pg-cursor, 순수 JS). 탐색기 단계는 DB → 스키마 → 표·뷰. DB마다 연결을 따로 연다.
import pg from 'pg'
import Cursor from 'pg-cursor'
import { quoteIdent } from '../../shared/dialect'
import { t } from '../../shared/i18n'
import type { Cell, ColumnInfo, DbObject, ResultColumn, StatementResult, TableRef } from '../../shared/types'
import { toCell, toParam } from '../values'
import { bool, elapsed, groupColumns, groupIndexes, Session, str, type DriverModule, type OnColumns, type OnRows, type OpenOptions, type Rows } from './base'

/**
 * 값 변환: 참·거짓과 작은 정수·실수만 JS 값으로, 나머지(날짜·bigint·numeric·json·배열 등)는 DB가 준 글자 그대로.
 * 그래야 정확도·형식이 바뀌지 않고, 고친 값을 그대로 돌려보낼 수 있다.
 */
const RAW = (v: string) => v
function getTypeParser(oid: number, format?: string): (v: string) => unknown {
  if (format === 'binary') return pg.types.getTypeParser(oid, 'binary') as (v: string) => unknown
  switch (oid) {
    case 16:
      return (v) => v === 't'
    case 21: // int2
    case 23: // int4
    case 26: // oid
    case 700: // float4
    case 701: // float8
      return (v) => Number(v)
    case 17: // bytea → Buffer
      return pg.types.getTypeParser(17, 'text') as (v: string) => unknown
    default:
      return RAW
  }
}

const KNOWN_TYPES: Record<number, string> = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid', 114: 'json', 142: 'xml',
  700: 'float4', 701: 'float8', 790: 'money', 1042: 'bpchar', 1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp',
  1184: 'timestamptz', 1186: 'interval', 1266: 'timetz', 1560: 'bit', 1562: 'varbit', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb',
  1000: '_bool', 1005: '_int2', 1007: '_int4', 1016: '_int8', 1009: '_text', 1015: '_varchar', 1021: '_float4', 1022: '_float8',
}

type Field = { name: string; dataTypeID: number }
type PgError = Error & { detail?: string; hint?: string; position?: string; where?: string }

/** 오류 메시지에 자세한 설명·힌트·위치를 붙인다 */
function pgError(e: unknown, sql?: string): Error {
  const err = e as PgError
  if (!(err instanceof Error)) return new Error(String(e))
  const parts = [err.message]
  if (err.detail) parts.push(err.detail)
  if (err.hint) parts.push(t('힌트: {hint}', { hint: err.hint }))
  if (err.position && sql) {
    const pos = Number(err.position) - 1
    const line = sql.slice(0, pos).split('\n').length
    parts.push(t('위치: {line}번째 줄', { line }))
  }
  return new Error(parts.join('\n'))
}

function clientOf(o: OpenOptions): pg.Client {
  const c = o.config
  return new pg.Client({
    host: o.endpoint.host,
    port: o.endpoint.port,
    user: c.user,
    password: o.password,
    database: o.database || 'postgres',
    ssl: c.ssl === 'off' ? false : { rejectUnauthorized: c.ssl === 'verify' },
    connectionTimeoutMillis: 15_000,
    application_name: 'DBoard',
    types: { getTypeParser } as never,
  })
}

export class PgSession extends Session {
  readonly dialect = 'postgres' as const
  private typeNames = new Map<number, string>(Object.entries(KNOWN_TYPES).map(([k, v]) => [Number(k), v]))

  constructor(private client: pg.Client, private opts: OpenOptions) {
    super()
    const die = () => {
      this.dead = true
    }
    client.on('error', die)
    client.on('end', die)
  }

  /** 모르는 타입 번호는 한 번 물어보고 기억 */
  private async columnsOf(fields: Field[]): Promise<ResultColumn[]> {
    const unknown = [...new Set(fields.map((f) => f.dataTypeID).filter((id) => !this.typeNames.has(id)))]
    if (unknown.length) {
      try {
        const r = await this.client.query({ text: 'SELECT oid, format_type(oid, NULL) FROM pg_type WHERE oid = ANY($1::oid[])', values: [unknown], rowMode: 'array' })
        for (const row of r.rows as unknown[][]) this.typeNames.set(Number(row[0]), String(row[1]))
      } catch {
        // 이름을 몰라도 결과는 보여 준다
      }
    }
    return fields.map((f) => ({ name: f.name, type: this.typeNames.get(f.dataTypeID) ?? String(f.dataTypeID) }))
  }

  protected async runRaw(sql: string, maxRows: number): Promise<StatementResult[]> {
    const t0 = performance.now()
    const cursor = this.client.query(new Cursor(sql, [], { rowMode: 'array' }))
    try {
      const { rows, result } = await new Promise<{ rows: unknown[][]; result: { fields: Field[]; rowCount: number | null; command: string | null } }>((resolve, reject) => {
        cursor.read(maxRows + 1, (err, rows, result) => (err ? reject(err) : resolve({ rows: rows as unknown[][], result: result as never })))
      })
      const ms = elapsed(t0)
      const fields = result?.fields ?? []
      if (fields.length === 0) {
        const affected = /^(INSERT|UPDATE|DELETE|MERGE|COPY|SELECT)$/.test(result?.command ?? '') ? result.rowCount : null
        return [{ sql, columns: null, rows: [], truncated: false, affected, ms }]
      }
      const columns = await this.columnsOf(fields)
      const truncated = rows.length > maxRows
      const affected = /^(INSERT|UPDATE|DELETE|MERGE)$/.test(result?.command ?? '') ? result.rowCount : null
      return [{ sql, columns, rows: rows.slice(0, maxRows).map((r) => r.map((v) => toCell(v))), truncated, affected, ms }]
    } catch (e) {
      throw pgError(e, sql)
    } finally {
      await cursor.close().catch(() => undefined)
    }
  }

  protected async queryRaw(sql: string, params: Cell[]): Promise<Rows> {
    try {
      const r = await this.client.query({ text: sql, values: params.map(toParam), rowMode: 'array' })
      return { columns: await this.columnsOf(r.fields), rows: (r.rows as unknown[][]).map((row) => row.map((v) => toCell(v))) }
    } catch (e) {
      throw pgError(e, sql)
    }
  }

  protected async execRaw(sql: string, params: Cell[]): Promise<number | null> {
    try {
      const r = await this.client.query({ text: sql, values: params.map(toParam) })
      return r.rowCount
    } catch (e) {
      throw pgError(e, sql)
    }
  }

  protected async streamRaw(sql: string, onColumns: OnColumns, onRows: OnRows): Promise<number> {
    const cursor = this.client.query(new Cursor(sql, [], { rowMode: 'array' }))
    let total = 0
    let first = true
    try {
      for (;;) {
        const { rows, result } = await new Promise<{ rows: unknown[][]; result: { fields: Field[] } }>((resolve, reject) => {
          cursor.read(1000, (err, rows, result) => (err ? reject(err) : resolve({ rows: rows as unknown[][], result: result as never })))
        })
        if (first) {
          onColumns(await this.columnsOf(result?.fields ?? []))
          first = false
        }
        if (rows.length === 0) return total
        total += rows.length
        await onRows(rows.map((r) => r.map((v) => toCell(v, Infinity))))
      }
    } catch (e) {
      throw pgError(e, sql)
    } finally {
      await cursor.close().catch(() => undefined)
    }
  }

  /** 다른 연결을 잠깐 열어 pg_cancel_backend */
  async cancel(): Promise<void> {
    const pid = (this.client as unknown as { processID?: number }).processID
    if (!pid) return
    const other = clientOf(this.opts)
    await other.connect()
    try {
      await other.query('SELECT pg_cancel_backend($1)', [pid])
    } finally {
      await other.end().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => undefined)
  }

  async useDatabase(db: string): Promise<boolean> {
    return !db || db === (this.opts.database || 'postgres')
  }

  async setSchema(schema: string): Promise<void> {
    const path = !schema || schema === 'public' ? '"$user", public' : `${quoteIdent('postgres', schema)}, public`
    await this.exec(`SET search_path TO ${path}`)
  }
}

const SYS_SCHEMA = `n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`

async function tableOid(s: Session, ref: TableRef): Promise<number> {
  const r = await s.query('SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2', [ref.schema, ref.table])
  if (!r.rows.length) throw new Error(t('표를 찾지 못했어요: {name}', { name: ref.table }))
  return Number(r.rows[0][0])
}

export const postgresDriver: DriverModule = {
  dialect: 'postgres',
  perDatabase: true,
  defaultDatabase: (c) => c.database || 'postgres',

  async open(o) {
    const client = clientOf(o)
    try {
      await client.connect()
    } catch (e) {
      await client.end().catch(() => undefined)
      throw pgError(e)
    }
    return new PgSession(client, o)
  },

  async version(s) {
    const r = await s.query('SELECT version()')
    return str(r.rows[0]?.[0]).split(' on ')[0].split(',')[0]
  },

  async databases(s, o) {
    const r = await s.query(`SELECT datname FROM pg_database WHERE datallowconn${o.showSystem ? '' : ' AND NOT datistemplate'} ORDER BY datname`)
    return { databases: r.rows.map((x) => str(x[0])), hasSchemas: true, defaultSchema: 'public' }
  },

  async schemas(s, _db, o) {
    const r = await s.query(`SELECT n.nspname FROM pg_namespace n WHERE ${o.showSystem ? 'true' : SYS_SCHEMA} ORDER BY n.nspname`)
    return r.rows.map((x) => str(x[0]))
  },

  async objects(s, _db, schema) {
    const r = await s.query(
      `SELECT c.relname, c.relkind, COALESCE(obj_description(c.oid, 'pg_class'), '')
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition ORDER BY c.relname`,
      [schema],
    )
    return r.rows.map((x): DbObject => ({ name: str(x[0]), kind: str(x[1]) === 'v' || str(x[1]) === 'm' ? 'view' : 'table', comment: str(x[2]) }))
  },

  async columns(s, ref) {
    const r = await s.query(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
         EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)),
         a.attidentity <> '' OR COALESCE(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%',
         COALESCE(col_description(c.oid, a.attnum), '')
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [ref.schema, ref.table],
    )
    return r.rows.map((x): ColumnInfo => ({
      name: str(x[0]),
      type: str(x[1]),
      nullable: bool(x[2]),
      default: x[3] === null ? null : str(x[3]),
      pk: bool(x[4]),
      autoIncrement: bool(x[5]),
      comment: str(x[6]),
    }))
  },

  async indexes(s, ref) {
    const r = await s.query(
      `SELECT ic.relname, i.indisunique, i.indisprimary, pg_get_indexdef(i.indexrelid, k.n, true)
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace ns ON ns.oid = c.relnamespace CROSS JOIN LATERAL generate_series(1, i.indnatts) AS k(n)
       WHERE ns.nspname = $1 AND c.relname = $2 ORDER BY ic.relname, k.n`,
      [ref.schema, ref.table],
    )
    return groupIndexes(r.rows)
  },

  async ddl(s, ref, kind) {
    const oid = await tableOid(s, ref)
    const name = `${quoteIdent('postgres', ref.schema)}.${quoteIdent('postgres', ref.table)}`
    if (kind === 'view') {
      const r = await s.query('SELECT pg_get_viewdef($1::oid, true), relkind FROM pg_class WHERE oid = $1::oid', [oid])
      const mat = str(r.rows[0]?.[1]) === 'm'
      return `${mat ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW'} ${name} AS\n${str(r.rows[0]?.[0]).trim().replace(/;$/, '')};`
    }
    const cols = await postgresDriver.columns(s, ref)
    const lines = cols.map((c) => `  ${quoteIdent('postgres', c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default !== null ? ' DEFAULT ' + c.default : ''}`)
    const cons = await s.query(
      `SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid = $1::oid AND contype <> 'n' ORDER BY contype = 'p' DESC, conname`,
      [oid],
    )
    for (const c of cons.rows) lines.push(`  CONSTRAINT ${quoteIdent('postgres', str(c[0]))} ${str(c[1])}`)
    const out = [`CREATE TABLE ${name} (\n${lines.join(',\n')}\n);`]
    const idx = await s.query(
      `SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid = $1::oid
         AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid) ORDER BY 1`,
      [oid],
    )
    for (const i of idx.rows) out.push(str(i[0]) + ';')
    const tc = await s.query(`SELECT obj_description($1::oid, 'pg_class')`, [oid])
    if (tc.rows[0]?.[0]) out.push(`COMMENT ON TABLE ${name} IS '${str(tc.rows[0][0]).replace(/'/g, "''")}';`)
    for (const c of cols) if (c.comment) out.push(`COMMENT ON COLUMN ${name}.${quoteIdent('postgres', c.name)} IS '${c.comment.replace(/'/g, "''")}';`)
    return out.join('\n\n')
  },

  async completion(s, _db, schema) {
    const r = await s.query(
      `SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum LIMIT 50000`,
      [schema],
    )
    return groupColumns(r.rows)
  },
}
