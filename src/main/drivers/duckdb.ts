// DuckDB: 파일 하나가 DB(카탈로그). 탐색기 단계는 DB(파일·붙인 DB) → 스키마 → 표·뷰.
// 엔진(네이티브)은 처음 쓸 때 받는다(engines.ts). 같은 파일은 한 프로세스에서 인스턴스 하나만 열 수 있어서 연결들이 나눠 쓴다.
import path from 'node:path'
import type { DuckDBConnection, DuckDBInstance, DuckDBResult } from '@duckdb/node-api'
import { quoteIdent } from '../../shared/dialect'
import { duckCatalog } from '../../shared/features'
import { t } from '../../shared/i18n'
import type { Cell, ColumnInfo, DbObject, DesignIndex, ForeignKeyInfo, IndexInfo, ResultColumn, StatementResult, TableRef } from '../../shared/types'
import { duckdbReady } from '../engines'
import { toCell, toHex, toParam } from '../values'
import { bool, elapsed, groupColumns, Session, str, type DriverModule, type OnColumns, type OnRows, type Rows } from './base'

type Api = typeof import('@duckdb/node-api')
let apiPromise: Promise<Api> | null = null

async function loadApi(): Promise<Api> {
  if (!duckdbReady()) throw new Error(t('DuckDB 엔진이 아직 없어요. 접속 설정에서 내려받아 주세요.'))
  apiPromise ??= import('@duckdb/node-api')
  return apiPromise
}

// ───────── 인스턴스 나눠 쓰기 ─────────

const instances = new Map<string, { inst: Promise<DuckDBInstance>; refs: number }>()
/** 파일 → 기본 카탈로그 이름 (DuckDB가 파일 이름에서 정한다: 'shop.duckdb' → shop) */
const catalogs = new Map<string, string>()

async function acquire(api: Api, file: string, readOnly: boolean): Promise<{ inst: DuckDBInstance; release: () => void }> {
  const key = `${path.resolve(file).toLowerCase()}|${readOnly ? 'ro' : 'rw'}`
  let e = instances.get(key)
  if (!e) {
    const inst = api.DuckDBInstance.create(file, readOnly ? { access_mode: 'READ_ONLY' } : {})
    e = { inst, refs: 0 }
    instances.set(key, e)
    inst.catch(() => instances.delete(key))
  }
  e.refs++
  const entry = e
  let inst: DuckDBInstance
  try {
    inst = await entry.inst
  } catch (err) {
    entry.refs--
    throw err
  }
  let released = false
  return {
    inst,
    release: () => {
      if (released) return
      released = true
      entry.refs--
      if (entry.refs <= 0 && instances.get(key) === entry) {
        instances.delete(key)
        try {
          inst.closeSync()
        } catch {
          // 이미 닫힘
        }
      }
    },
  }
}

const defaultCatalog = (file: string) => catalogs.get(path.resolve(file).toLowerCase()) ?? duckCatalog(file)

// ───────── 값 ─────────

function toDuckCell(api: Api, v: unknown, binLimit: number): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' || typeof v === 'string') return toCell(v)
  if (v instanceof api.DuckDBBlobValue) return { bin: toHex(v.bytes, binLimit), size: v.bytes.length }
  return String(v)
}

/** 오류 글: DuckDB는 줄을 나눠 LINE·^ 표시까지 준다 */
const duckError = (e: unknown) => new Error(e instanceof Error ? e.message : String(e))

export class DuckSession extends Session {
  readonly dialect = 'duckdb' as const

  constructor(private api: Api, private conn: DuckDBConnection, private releaseInst: () => void, public db: string) {
    super()
  }

  private params(p: Cell[]) {
    return p.map((v) => {
      const x = toParam(v)
      return Buffer.isBuffer(x) ? new this.api.DuckDBBlobValue(new Uint8Array(x)) : x
    })
  }

  private columnsOf(r: DuckDBResult): ResultColumn[] {
    return r.columnNames().map((name, i) => ({ name, type: r.columnType(i).toString() }))
  }

  private affectedOf(r: DuckDBResult): number | null {
    const S = this.api.StatementType
    return r.statementType === S.INSERT || r.statementType === S.UPDATE || r.statementType === S.DELETE ? r.rowsChanged : null
  }

  protected async runRaw(sql: string, maxRows: number): Promise<StatementResult[]> {
    const t0 = performance.now()
    const r = await this.conn.stream(sql).catch((e) => Promise.reject(duckError(e)))
    try {
      // 그냥 INSERT·UPDATE·DELETE는 CHANGED_ROWS, RETURNING이 붙으면 QUERY_RESULT(행을 보여 준다)
      if (r.returnType !== this.api.ResultReturnType.QUERY_RESULT) {
        return [{ sql, columns: null, rows: [], truncated: false, affected: this.affectedOf(r), ms: elapsed(t0) }]
      }
      const columns = this.columnsOf(r)
      const rows: Cell[][] = []
      let truncated = false
      for (;;) {
        const chunk = await r.fetchChunk()
        if (!chunk || chunk.rowCount === 0) break
        for (const row of chunk.getRows()) {
          if (rows.length >= maxRows) {
            truncated = true
            break
          }
          rows.push(row.map((v) => toDuckCell(this.api, v, 64)))
        }
        if (truncated) break
      }
      return [{ sql, columns, rows, truncated, affected: null, ms: elapsed(t0) }]
    } catch (e) {
      throw duckError(e)
    } finally {
      r.closeSync()
    }
  }

  protected async queryRaw(sql: string, params: Cell[], binLimit: number): Promise<Rows> {
    try {
      const r = await this.conn.run(sql, this.params(params))
      const columns = this.columnsOf(r)
      const rows = (await r.getRows()).map((row) => row.map((v) => toDuckCell(this.api, v, binLimit)))
      return { columns, rows }
    } catch (e) {
      throw duckError(e)
    }
  }

  protected async execRaw(sql: string, params: Cell[]): Promise<number | null> {
    try {
      const r = await this.conn.run(sql, this.params(params))
      return r.rowsChanged
    } catch (e) {
      throw duckError(e)
    }
  }

  protected async streamRaw(sql: string, onColumns: OnColumns, onRows: OnRows): Promise<number> {
    const r = await this.conn.stream(sql).catch((e) => Promise.reject(duckError(e)))
    let total = 0
    try {
      onColumns(this.columnsOf(r))
      for (;;) {
        const chunk = await r.fetchChunk()
        if (!chunk || chunk.rowCount === 0) return total
        const rows = chunk.getRows().map((row) => row.map((v) => toDuckCell(this.api, v, Infinity)))
        total += rows.length
        await onRows(rows)
      }
    } catch (e) {
      throw duckError(e)
    } finally {
      r.closeSync()
    }
  }

  async cancel(): Promise<void> {
    this.conn.interrupt()
  }

  async close(): Promise<void> {
    try {
      this.conn.closeSync()
    } catch {
      // 이미 닫힘
    }
    this.releaseInst()
  }

  async useDatabase(db: string): Promise<boolean> {
    if (db && db !== this.db) {
      await this.exec(`USE ${quoteIdent('duckdb', db)}`)
      this.db = db
    }
    return true
  }

  async setSchema(schema: string): Promise<void> {
    await this.exec(`USE ${quoteIdent('duckdb', this.db)}.${quoteIdent('duckdb', schema || 'main')}`)
  }

  /** 읽기 전용은 인스턴스를 READ_ONLY로 열어서 따로 할 일이 없다 */
  async applyReadOnly() {}
}

// ───────── 시스템 표 ─────────

const SYS_DB = `database_name NOT IN ('system', 'temp')`
const userSchemas = (alias = '') => `${alias}schema_name NOT IN ('information_schema', 'pg_catalog')`

/** duckdb_indexes().expressions: "['\"name\"', price]" → 열 이름들 (식은 '(식)') */
export function parseDuckExpressions(s: string, expr: string): string[] {
  const body = s.trim().replace(/^\[/, '').replace(/\]$/, '')
  const parts: string[] = []
  let cur = ''
  let quote = ''
  for (const c of body) {
    if (quote) {
      cur += c
      if (c === quote) quote = ''
    } else if (c === "'" || c === '"') {
      quote = c
      cur += c
    } else if (c === ',') {
      parts.push(cur.trim())
      cur = ''
    } else cur += c
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts.map((p) => {
    let x = p
    if (/^'.*'$/s.test(x)) x = x.slice(1, -1).replace(/''/g, "'")
    if (/^"(?:[^"]|"")*"$/.test(x)) return x.slice(1, -1).replace(/""/g, '"')
    return /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(x) ? x : expr
  })
}

const list = (v: Cell | undefined): string[] => {
  // 목록 값은 DuckDB 글자 모양 [a, b]로 온다
  const s = str(v)
  if (!s || s === '[]') return []
  return parseDuckExpressions(s, '')
}

async function duckColumns(s: Session, ref: TableRef): Promise<ColumnInfo[]> {
  const r = await s.query(
    `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, COALESCE(c.comment, ''),
       COALESCE(i.is_generated, 'NEVER')
     FROM duckdb_columns() c
     LEFT JOIN information_schema.columns i ON i.table_catalog = c.database_name AND i.table_schema = c.schema_name AND i.table_name = c.table_name AND i.column_name = c.column_name
     WHERE c.database_name = $1 AND c.schema_name = $2 AND c.table_name = $3 ORDER BY c.column_index`,
    [ref.db, ref.schema || 'main', ref.table],
  )
  const pk = await pkColumns(s, ref)
  return r.rows.map((x) => {
    const def = x[3] === null ? null : str(x[3])
    return {
      name: str(x[0]),
      type: str(x[1]),
      nullable: bool(x[2]),
      default: def,
      pk: pk.includes(str(x[0])),
      autoIncrement: /^nextval\(/i.test(def ?? ''),
      comment: str(x[4]),
      generated: str(x[5]) === 'ALWAYS',
    }
  })
}

async function pkColumns(s: Session, ref: TableRef): Promise<string[]> {
  const r = await s.query(
    `SELECT constraint_column_names FROM duckdb_constraints() WHERE database_name = $1 AND schema_name = $2 AND table_name = $3 AND constraint_type = 'PRIMARY KEY'`,
    [ref.db, ref.schema || 'main', ref.table],
  )
  return list(r.rows[0]?.[0])
}

async function constraints(s: Session, ref: TableRef, type: string) {
  const r = await s.query(
    `SELECT constraint_name, constraint_column_names, referenced_table, referenced_column_names FROM duckdb_constraints()
     WHERE database_name = $1 AND schema_name = $2 AND table_name = $3 AND constraint_type = $4 ORDER BY constraint_index`,
    [ref.db, ref.schema || 'main', ref.table, type],
  )
  return r.rows.map((x) => ({ name: str(x[0]), columns: list(x[1]), refTable: str(x[2]), refColumns: list(x[3]) }))
}

export const duckdbDriver: DriverModule = {
  dialect: 'duckdb',
  perDatabase: false,
  defaultDatabase: (c) => defaultCatalog(c.file),

  async open(o) {
    const api = await loadApi()
    const file = o.config.file
    const { inst, release } = await acquire(api, file, o.config.readOnly === true)
    let conn: DuckDBConnection
    try {
      conn = await inst.connect()
    } catch (e) {
      release()
      throw duckError(e)
    }
    const s = new DuckSession(api, conn, release, '')
    try {
      const r = await s.query('SELECT current_database()')
      const db = str(r.rows[0]?.[0])
      catalogs.set(path.resolve(file).toLowerCase(), db)
      s.db = db
    } catch (e) {
      await s.close()
      throw e
    }
    return s
  },

  async version(s) {
    const r = await s.query('SELECT version()')
    return 'DuckDB ' + str(r.rows[0]?.[0]).replace(/^v/, '')
  },

  async databases(s, o) {
    const r = await s.query(`SELECT database_name FROM duckdb_databases() WHERE ${o.showSystem ? 'true' : SYS_DB} ORDER BY internal, database_name`)
    return { databases: r.rows.map((x) => str(x[0])), hasSchemas: true, defaultSchema: 'main' }
  },

  async schemas(s, db, o) {
    const r = await s.query(`SELECT schema_name FROM duckdb_schemas() WHERE database_name = $1${o.showSystem ? '' : ' AND ' + userSchemas()} ORDER BY schema_name`, [db])
    return r.rows.map((x) => str(x[0]))
  },

  async objects(s, db, schema) {
    const r = await s.query(
      `SELECT table_name, 'table', COALESCE(comment, '') FROM duckdb_tables() WHERE database_name = $1 AND schema_name = $2
       UNION ALL SELECT view_name, 'view', COALESCE(comment, '') FROM duckdb_views() WHERE database_name = $1 AND schema_name = $2 AND NOT internal
       ORDER BY 1`,
      [db, schema || 'main'],
    )
    return r.rows.map((x): DbObject => ({ name: str(x[0]), kind: str(x[1]) === 'view' ? 'view' : 'table', comment: str(x[2]) }))
  },

  columns: duckColumns,

  async indexes(s, ref) {
    const out: IndexInfo[] = []
    const pk = await pkColumns(s, ref)
    if (pk.length) out.push({ name: 'PRIMARY KEY', unique: true, primary: true, columns: pk })
    for (const u of await constraints(s, ref, 'UNIQUE')) out.push({ name: u.name, unique: true, primary: false, columns: u.columns })
    const r = await s.query(
      `SELECT index_name, is_unique, expressions FROM duckdb_indexes() WHERE database_name = $1 AND schema_name = $2 AND table_name = $3 ORDER BY index_name`,
      [ref.db, ref.schema || 'main', ref.table],
    )
    for (const x of r.rows) out.push({ name: str(x[0]), unique: bool(x[1]), primary: false, columns: parseDuckExpressions(str(x[2]), t('(식)')) })
    return out
  },

  async ddl(s, ref, kind) {
    const args = [ref.db, ref.schema || 'main', ref.table]
    if (kind === 'view') {
      const r = await s.query('SELECT sql FROM duckdb_views() WHERE database_name = $1 AND schema_name = $2 AND view_name = $3', args)
      if (!r.rows.length) throw new Error(t('표를 찾지 못했어요: {name}', { name: ref.table }))
      return str(r.rows[0][0])
    }
    const r = await s.query('SELECT sql, comment FROM duckdb_tables() WHERE database_name = $1 AND schema_name = $2 AND table_name = $3', args)
    if (!r.rows.length) throw new Error(t('표를 찾지 못했어요: {name}', { name: ref.table }))
    const out = [str(r.rows[0][0])]
    const ix = await s.query('SELECT sql FROM duckdb_indexes() WHERE database_name = $1 AND schema_name = $2 AND table_name = $3 AND sql IS NOT NULL ORDER BY index_name', args)
    for (const x of ix.rows) out.push(str(x[0]))
    const name = `${quoteIdent('duckdb', ref.schema || 'main')}.${quoteIdent('duckdb', ref.table)}`
    if (r.rows[0][1]) out.push(`COMMENT ON TABLE ${name} IS '${str(r.rows[0][1]).replace(/'/g, "''")}';`)
    for (const c of await duckColumns(s, ref)) if (c.comment) out.push(`COMMENT ON COLUMN ${name}.${quoteIdent('duckdb', c.name)} IS '${c.comment.replace(/'/g, "''")}';`)
    return out.join('\n\n')
  },

  async foreignKeys(s, ref) {
    return (await constraints(s, ref, 'FOREIGN KEY')).map((f): ForeignKeyInfo => ({
      name: f.name,
      columns: f.columns,
      ref: { db: ref.db, schema: ref.schema || 'main', table: f.refTable },
      refColumns: f.refColumns,
    }))
  },

  async completion(s, db, schema) {
    const r = await s.query(
      `SELECT table_name, column_name FROM duckdb_columns() WHERE database_name = $1 AND schema_name = $2 ORDER BY table_name, column_index LIMIT 50000`,
      [db, schema || 'main'],
    )
    return groupColumns(r.rows)
  },

  async searchNames(s, db, like, o) {
    const sys = o.showSystem ? '' : ' AND ' + userSchemas()
    const objs = await s.query(
      `SELECT schema_name, table_name, 'table' FROM duckdb_tables() WHERE database_name = $1 AND table_name ILIKE $2 ESCAPE '\\'${sys}
       UNION ALL SELECT schema_name, view_name, 'view' FROM duckdb_views() WHERE database_name = $1 AND NOT internal AND view_name ILIKE $2 ESCAPE '\\'${sys}
       UNION ALL SELECT schema_name, sequence_name, 'sequence' FROM duckdb_sequences() WHERE database_name = $1 AND sequence_name ILIKE $2 ESCAPE '\\'${sys}
       ORDER BY 1, 2 LIMIT 1000`,
      [db, like],
    )
    const cols = await s.query(
      `SELECT schema_name, table_name, column_name, data_type FROM duckdb_columns() WHERE database_name = $1 AND NOT internal AND column_name ILIKE $2 ESCAPE '\\'${sys} ORDER BY 1, 2, column_index LIMIT 1000`,
      [db, like],
    )
    const fns = await s.query(
      `SELECT schema_name, function_name FROM duckdb_functions() WHERE database_name = $1 AND NOT internal AND function_name ILIKE $2 ESCAPE '\\' ORDER BY 1, 2 LIMIT 500`,
      [db, like],
    )
    return [
      ...objs.rows.map((x) => ({ db, schema: str(x[0]), kind: str(x[2]) as 'table' | 'view' | 'sequence', table: str(x[2]) === 'sequence' ? '' : str(x[1]), name: str(x[1]), extra: '' })),
      ...cols.rows.map((x) => ({ db, schema: str(x[0]), kind: 'column' as const, table: str(x[1]), name: str(x[2]), extra: str(x[3]) })),
      ...fns.rows.map((x) => ({ db, schema: str(x[0]), kind: 'function' as const, table: '', name: str(x[1]), extra: '' })),
    ]
  },

  users: null,
  stats: null,
  sessions: null,

  async extras(s, db, schema) {
    const fn = await s.query(
      `SELECT DISTINCT function_name, array_to_string(parameters, ', ') FROM duckdb_functions() WHERE database_name = $1 AND schema_name = $2 AND NOT internal AND function_type IN ('macro', 'table_macro') ORDER BY 1`,
      [db, schema || 'main'],
    )
    const sq = await s.query('SELECT sequence_name FROM duckdb_sequences() WHERE database_name = $1 AND schema_name = $2 ORDER BY 1', [db, schema || 'main'])
    return [
      ...fn.rows.map((x) => ({ kind: 'function' as const, name: str(x[0]), id: str(x[0]), table: '', args: str(x[1]) })),
      ...sq.rows.map((x) => ({ kind: 'sequence' as const, name: str(x[0]), id: str(x[0]), table: '', args: '' })),
    ]
  },

  async source(s, db, schema, kind, id) {
    const sch = schema || 'main'
    if (kind === 'sequence') {
      const r = await s.query('SELECT sql FROM duckdb_sequences() WHERE database_name = $1 AND schema_name = $2 AND sequence_name = $3', [db, sch, id])
      if (r.rows.length) return str(r.rows[0][0])
    }
    if (kind === 'function') {
      const r = await s.query(
        `SELECT function_type, array_to_string(parameters, ', '), macro_definition FROM duckdb_functions() WHERE database_name = $1 AND schema_name = $2 AND function_name = $3 AND NOT internal`,
        [db, sch, id],
      )
      if (r.rows.length) {
        const name = `${quoteIdent('duckdb', sch)}.${quoteIdent('duckdb', id)}`
        return r.rows.map((x) => `CREATE OR REPLACE MACRO ${name}(${str(x[1])}) AS ${str(x[0]) === 'table_macro' ? 'TABLE ' : ''}${str(x[2])};`).join('\n')
      }
    }
    throw new Error(t('개체를 찾지 못했어요: {name}', { name: id }))
  },

  async design(s, ref) {
    const cols = await duckColumns(s, ref)
    const r = await s.query(
      `SELECT comment FROM duckdb_tables() WHERE database_name = $1 AND schema_name = $2 AND table_name = $3`,
      [ref.db, ref.schema || 'main', ref.table],
    )
    const pk = await s.query(
      `SELECT constraint_name, constraint_column_names FROM duckdb_constraints() WHERE database_name = $1 AND schema_name = $2 AND table_name = $3 AND constraint_type = 'PRIMARY KEY'`,
      [ref.db, ref.schema || 'main', ref.table],
    )
    const ix = await s.query(
      `SELECT index_name, is_unique, expressions, sql FROM duckdb_indexes() WHERE database_name = $1 AND schema_name = $2 AND table_name = $3 ORDER BY index_name`,
      [ref.db, ref.schema || 'main', ref.table],
    )
    const indexes: DesignIndex[] = [
      ...(await constraints(s, ref, 'UNIQUE')).map((u) => ({ name: u.name, unique: true, columns: u.columns, orig: u.name, constraint: true })),
      ...ix.rows.map((x) => {
        const columns = parseDuckExpressions(str(x[2]), t('(식)'))
        return { name: str(x[0]), unique: bool(x[1]), columns, orig: str(x[0]), ...(columns.includes(t('(식)')) ? { sql: str(x[3]) } : {}) }
      }),
    ]
    const fks = await constraints(s, ref, 'FOREIGN KEY')
    return {
      name: ref.table,
      comment: str(r.rows[0]?.[0]),
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        default: c.generated ? '' : c.default ?? '',
        autoIncrement: false,
        comment: c.comment,
        generated: !!c.generated,
        orig: c.name,
      })),
      primaryKey: list(pk.rows[0]?.[1]),
      pkName: str(pk.rows[0]?.[0]),
      indexes,
      foreignKeys: fks.map((f) => ({ name: f.name, columns: f.columns, refSchema: ref.schema || 'main', refTable: f.refTable, refColumns: f.refColumns, onUpdate: 'NO ACTION', onDelete: 'NO ACTION', orig: f.name })),
      unsupported: [],
    }
  },
}
