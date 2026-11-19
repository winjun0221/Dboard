// SQL Server (tedious, 순수 JS). 탐색기 단계는 DB → 스키마 → 표·뷰. 한 연결에서 [DB].sys… 세 부분 이름으로 다른 DB도 읽는다.
import { Connection, Request, TYPES } from 'tedious'
import { quoteIdent } from '../../shared/dialect'
import { t } from '../../shared/i18n'
import { firstKeyword, splitSql } from '../../shared/sql'
import type { Cell, ColumnInfo, DbObject, ResultColumn, StatementResult, TableRef } from '../../shared/types'
import { formatUtc, toCell, toParam } from '../values'
import { bool, elapsed, groupColumns, groupIndexes, Session, str, type DriverModule, type OnColumns, type OnRows, type OpenOptions, type Rows } from './base'

type Meta = { colName: string; type: { name: string }; dataLength?: number; precision?: number; scale?: number }
type ColValue = { value: unknown; metadata: Meta }

const INT_BY_SIZE: Record<number, string> = { 1: 'tinyint', 2: 'smallint', 4: 'int', 8: 'bigint' }

/** 드라이버의 타입 이름(IntN·NVarChar…) → SQL 타입 이름 */
function typeLabel(m: Meta): string {
  let n = m.type.name.toLowerCase()
  if (n === 'intn') n = INT_BY_SIZE[m.dataLength ?? 4] ?? 'int'
  else if (n === 'floatn') n = m.dataLength === 4 ? 'real' : 'float'
  else if (n === 'moneyn') n = m.dataLength === 4 ? 'smallmoney' : 'money'
  else if (n === 'datetimen') n = m.dataLength === 4 ? 'smalldatetime' : 'datetime'
  else if (n === 'bitn') n = 'bit'
  else if (n === 'decimaln' || n === 'numericn') n = n.slice(0, -1)
  if (n === 'decimal' || n === 'numeric') return `${n}(${m.precision},${m.scale})`
  if (/^(n?(var)?char|(var)?binary)$/.test(n)) {
    const len = m.dataLength
    const max = len === undefined || len === 65535 || len > 8000
    return `${n}(${max ? 'max' : n.startsWith('n') ? len / 2 : len})`
  }
  return n
}

const columnsOf = (meta: Meta[]): ResultColumn[] => meta.map((m) => ({ name: m.colName, type: typeLabel(m) }))

/** 날짜·시간은 형식에 맞춰 글자로 (드라이버는 UTC 기준 Date를 준다) */
function value(c: ColValue, binLimit: number): Cell {
  const v = c.value
  if (v instanceof Date) {
    const n = c.metadata.type.name.toLowerCase()
    if (n === 'date') return formatUtc(v, 'date')
    if (n === 'time') return formatUtc(v, 'time')
    if (n === 'datetimeoffset') return formatUtc(v) + ' +00:00'
    return formatUtc(v)
  }
  return toCell(v, binLimit)
}

function paramType(v: string | number | boolean | null) {
  if (typeof v === 'boolean') return TYPES.Bit
  if (typeof v === 'number') return Number.isInteger(v) ? TYPES.BigInt : TYPES.Float
  return TYPES.NVarChar
}

type TdsError = Error & { code?: string; lineNumber?: number; errors?: Error[] }

function mssqlError(e: unknown): Error {
  const err = e as TdsError
  if (!(err instanceof Error)) return new Error(String(e))
  // 여러 오류가 한꺼번에 오면 모두 보여 준다 (AggregateError)
  const msgs = err.errors?.length ? err.errors.map((x) => x.message) : [err.message]
  const line = err.lineNumber ? '\n' + t('위치: {line}번째 줄', { line: err.lineNumber }) : ''
  const out = new Error(msgs.join('\n') + line) as TdsError
  out.code = err.code
  return out
}

function connect(o: OpenOptions): Promise<Connection> {
  const c = o.config
  return new Promise((resolve, reject) => {
    const conn = new Connection({
      server: o.endpoint.host,
      authentication: { type: 'default', options: { userName: c.user, password: o.password } },
      options: {
        port: o.endpoint.port,
        database: o.database || undefined,
        encrypt: c.ssl !== 'off',
        trustServerCertificate: c.ssl !== 'verify',
        rowCollectionOnRequestCompletion: false,
        useColumnNames: false,
        useUTC: true,
        connectTimeout: 15_000,
        // 오래 걸리는 쿼리도 끊지 않음 (취소 버튼으로 멈춘다)
        requestTimeout: 0,
        appName: 'DBoard',
      },
    })
    conn.once('connect', (err) => {
      if (err) {
        conn.close()
        reject(mssqlError(err))
      } else resolve(conn)
    })
    conn.connect()
  })
}

export class MssqlSession extends Session {
  readonly dialect = 'mssql' as const

  constructor(private conn: Connection) {
    super()
    const die = () => {
      this.dead = true
    }
    conn.on('end', die)
    conn.on('error', die)
  }

  /** 요청 하나. 결과 표마다 columnMetadata → row… → done 순서로 온다 */
  private request(sql: string, params: Cell[], h: {
    onMeta?: (m: Meta[]) => void
    onRow?: (r: ColValue[], req: Request) => void
    onDone?: (rowCount: number | undefined) => void
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = new Request(sql, (err) => {
        if (err && (err as TdsError).code !== 'ECANCEL') reject(mssqlError(err))
        else resolve()
      })
      if (h.onMeta) req.on('columnMetadata', (m) => h.onMeta!(m as unknown as Meta[]))
      if (h.onRow) req.on('row', (r) => h.onRow!(r as unknown as ColValue[], req))
      const done = (rowCount: number | undefined) => h.onDone?.(rowCount)
      req.on('done', done)
      req.on('doneInProc', done)
      if (params.length) {
        params.forEach((p, i) => {
          const v = toParam(p)
          req.addParameter('p' + (i + 1), paramType(v), v)
        })
        this.conn.execSql(req)
      } else this.conn.execSqlBatch(req)
    })
  }

  protected async runRaw(sql: string, maxRows: number): Promise<StatementResult[]> {
    const t0 = performance.now()
    const out: StatementResult[] = []
    let cur: StatementResult | null = null
    // SELECT 문장 하나뿐이면 다 받았을 때 취소해서 나머지를 안 받는다 (배치에 문장이 더 있으면 끝까지 받고 버림)
    const single = splitSql(sql, 'mssql', { semicolon: true }).length === 1 && ['SELECT', 'WITH'].includes(firstKeyword(sql, 'mssql'))
    let cancelled = false
    await this.request(sql, [], {
      onMeta: (m) => {
        cur = { sql, columns: columnsOf(m), rows: [], truncated: false, affected: null, ms: 0 }
        out.push(cur)
      },
      onRow: (r) => {
        if (!cur) return
        if (cur.rows.length >= maxRows) {
          cur.truncated = true
          if (single && !cancelled) {
            cancelled = true
            this.conn.cancel()
          }
          return
        }
        cur.rows.push(r.map((c) => value(c, 64)))
      },
      onDone: (rowCount) => {
        if (cur) cur = null
        else if (rowCount !== undefined) out.push({ sql, columns: null, rows: [], truncated: false, affected: rowCount, ms: 0 })
      },
    })
    const ms = elapsed(t0)
    for (const r of out) r.ms = ms
    return out.length ? out : [{ sql, columns: null, rows: [], truncated: false, affected: null, ms }]
  }

  protected async queryRaw(sql: string, params: Cell[]): Promise<Rows> {
    let columns: ResultColumn[] = []
    const rows: Cell[][] = []
    let got = false
    await this.request(sql, params, {
      onMeta: (m) => {
        if (got) return
        columns = columnsOf(m)
      },
      onRow: (r) => {
        if (!got) rows.push(r.map((c) => value(c, 64)))
      },
      onDone: () => {
        if (columns.length) got = true
      },
    })
    return { columns, rows }
  }

  protected async execRaw(sql: string, params: Cell[]): Promise<number | null> {
    let total: number | null = null
    await this.request(sql, params, {
      onDone: (rowCount) => {
        if (rowCount !== undefined) total = (total ?? 0) + rowCount
      },
    })
    return total
  }

  /** 첫 결과 표만 조금씩 (CSV 내보내기) */
  protected async streamRaw(sql: string, onColumns: OnColumns, onRows: OnRows): Promise<number> {
    let buf: Cell[][] = []
    let total = 0
    let phase = 0 // 0: 표 전, 1: 첫 표, 2: 끝
    let waiting: Promise<void> | null = null
    const flush = (req: Request | null) => {
      if (!buf.length) return
      const rows = buf
      buf = []
      const r = onRows(rows)
      if (r && req) {
        req.pause()
        waiting = r.then(() => {
          waiting = null
          req.resume()
        })
      } else if (r) waiting = r.then(() => undefined)
    }
    await this.request(sql, [], {
      onMeta: (m) => {
        if (phase !== 0) return
        onColumns(columnsOf(m))
        phase = 1
      },
      onRow: (r, req) => {
        if (phase !== 1) return
        buf.push(r.map((c) => value(c, Infinity)))
        total++
        if (buf.length >= 1000) flush(req)
      },
      onDone: () => {
        if (phase === 1) phase = 2
      },
    })
    flush(null)
    await waiting
    return total
  }

  async cancel(): Promise<void> {
    this.conn.cancel()
  }

  async close(): Promise<void> {
    this.conn.close()
  }

  async useDatabase(db: string): Promise<boolean> {
    if (db) await this.exec(`USE ${quoteIdent('mssql', db)}`)
    return true
  }

  async setSchema(): Promise<void> {}
}

const q = (n: string) => quoteIdent('mssql', n)

/** sys 표 이름: [db].sys.xxx */
const sys = (db: string, name: string) => `${q(db)}.sys.${name}`

function sqlType(name: string, maxLength: number, precision: number, scale: number): string {
  const n = name.toLowerCase()
  if (n === 'nvarchar' || n === 'nchar') return `${n}(${maxLength === -1 ? 'max' : maxLength / 2})`
  if (n === 'varchar' || n === 'char' || n === 'varbinary' || n === 'binary') return `${n}(${maxLength === -1 ? 'max' : maxLength})`
  if (n === 'decimal' || n === 'numeric') return `${n}(${precision},${scale})`
  if (n === 'datetime2' || n === 'time' || n === 'datetimeoffset') return `${n}(${scale})`
  return n
}

async function columnRows(s: Session, ref: TableRef) {
  const db = ref.db
  return s.query(
    `SELECT c.name, t.name, c.max_length, c.precision, c.scale, c.is_nullable, dc.definition,
       CASE WHEN EXISTS (SELECT 1 FROM ${sys(db, 'index_columns')} ic JOIN ${sys(db, 'indexes')} i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
         WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END,
       c.is_identity, CAST(ISNULL(ep.value, '') AS nvarchar(4000)), CAST(idc.seed_value AS bigint), CAST(idc.increment_value AS bigint)
     FROM ${sys(db, 'columns')} c JOIN ${sys(db, 'objects')} o ON o.object_id = c.object_id JOIN ${sys(db, 'schemas')} s ON s.schema_id = o.schema_id
     JOIN ${sys(db, 'types')} t ON t.user_type_id = c.user_type_id
     LEFT JOIN ${sys(db, 'default_constraints')} dc ON dc.object_id = c.default_object_id
     LEFT JOIN ${sys(db, 'identity_columns')} idc ON idc.object_id = c.object_id AND idc.column_id = c.column_id
     LEFT JOIN ${sys(db, 'extended_properties')} ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.class = 1 AND ep.name = 'MS_Description'
     WHERE s.name = @p1 AND o.name = @p2 ORDER BY c.column_id`,
    [ref.schema || 'dbo', ref.table],
  )
}

export const mssqlDriver: DriverModule = {
  dialect: 'mssql',
  perDatabase: false,
  defaultDatabase: (c) => c.database || 'master',

  async open(o) {
    return new MssqlSession(await connect(o))
  },

  async version(s) {
    const r = await s.query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(100)), CAST(SERVERPROPERTY('Edition') AS nvarchar(200))")
    return `SQL Server ${str(r.rows[0]?.[0])} (${str(r.rows[0]?.[1])})`
  },

  async databases(s, o) {
    const r = await s.query(`SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' AND HAS_DBACCESS(name) = 1${o.showSystem ? '' : ' AND database_id > 4'} ORDER BY name`)
    return { databases: r.rows.map((x) => str(x[0])), hasSchemas: true, defaultSchema: 'dbo' }
  },

  async schemas(s, db, o) {
    const filter = o.showSystem ? '1 = 1' : `s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') AND s.name NOT LIKE 'db[_]%'`
    const r = await s.query(`SELECT s.name FROM ${sys(db, 'schemas')} s WHERE ${filter} ORDER BY s.name`)
    return r.rows.map((x) => str(x[0]))
  },

  async objects(s, db, schema) {
    const r = await s.query(
      `SELECT o.name, RTRIM(o.type), CAST(ISNULL(ep.value, '') AS nvarchar(4000))
       FROM ${sys(db, 'objects')} o JOIN ${sys(db, 'schemas')} s ON s.schema_id = o.schema_id
       LEFT JOIN ${sys(db, 'extended_properties')} ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description'
       WHERE s.name = @p1 AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0 ORDER BY o.name`,
      [schema],
    )
    return r.rows.map((x): DbObject => ({ name: str(x[0]), kind: str(x[1]) === 'V' ? 'view' : 'table', comment: str(x[2]) }))
  },

  async columns(s, ref) {
    const r = await columnRows(s, ref)
    return r.rows.map((x): ColumnInfo => ({
      name: str(x[0]),
      type: sqlType(str(x[1]), Number(x[2]), Number(x[3]), Number(x[4])),
      nullable: bool(x[5]),
      default: x[6] === null ? null : str(x[6]),
      pk: bool(x[7]),
      autoIncrement: bool(x[8]),
      comment: str(x[9]),
    }))
  },

  async indexes(s, ref) {
    const db = ref.db
    const r = await s.query(
      `SELECT i.name, i.is_unique, i.is_primary_key, col.name
       FROM ${sys(db, 'indexes')} i JOIN ${sys(db, 'index_columns')} ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN ${sys(db, 'columns')} col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
       JOIN ${sys(db, 'objects')} o ON o.object_id = i.object_id JOIN ${sys(db, 'schemas')} s ON s.schema_id = o.schema_id
       WHERE s.name = @p1 AND o.name = @p2 AND i.name IS NOT NULL
       ORDER BY i.name, CASE WHEN ic.key_ordinal = 0 THEN 1 ELSE 0 END, ic.key_ordinal, ic.index_column_id`,
      [ref.schema || 'dbo', ref.table],
    )
    return groupIndexes(r.rows)
  },

  async ddl(s, ref, kind) {
    const db = ref.db
    const schema = ref.schema || 'dbo'
    const name = `${q(schema)}.${q(ref.table)}`
    if (kind === 'view') {
      const r = await s.query(
        `SELECT m.definition FROM ${sys(db, 'sql_modules')} m JOIN ${sys(db, 'objects')} o ON o.object_id = m.object_id
         JOIN ${sys(db, 'schemas')} s ON s.schema_id = o.schema_id WHERE s.name = @p1 AND o.name = @p2`,
        [schema, ref.table],
      )
      return str(r.rows[0]?.[0]).trim()
    }
    const cols = await columnRows(s, ref)
    const lines = cols.rows.map((x) => {
      const ident = bool(x[8]) ? ` IDENTITY(${str(x[10]) || 1},${str(x[11]) || 1})` : ''
      return `  ${q(str(x[0]))} ${sqlType(str(x[1]), Number(x[2]), Number(x[3]), Number(x[4]))}${ident}${bool(x[5]) ? ' NULL' : ' NOT NULL'}${x[6] !== null ? ' DEFAULT ' + str(x[6]) : ''}`
    })
    const ix = await mssqlDriver.indexes(s, ref)
    const pk = ix.find((i) => i.primary)
    if (pk) lines.push(`  CONSTRAINT ${q(pk.name)} PRIMARY KEY (${pk.columns.map(q).join(', ')})`)
    const fks = await s.query(
      `SELECT fk.name, pc.name, rs.name, rt.name, rc.name
       FROM ${sys(db, 'foreign_keys')} fk JOIN ${sys(db, 'foreign_key_columns')} fkc ON fkc.constraint_object_id = fk.object_id
       JOIN ${sys(db, 'columns')} pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN ${sys(db, 'objects')} rt ON rt.object_id = fkc.referenced_object_id JOIN ${sys(db, 'schemas')} rs ON rs.schema_id = rt.schema_id
       JOIN ${sys(db, 'columns')} rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
       JOIN ${sys(db, 'objects')} o ON o.object_id = fk.parent_object_id JOIN ${sys(db, 'schemas')} s ON s.schema_id = o.schema_id
       WHERE s.name = @p1 AND o.name = @p2 ORDER BY fk.name, fkc.constraint_column_id`,
      [schema, ref.table],
    )
    const byFk = new Map<string, { cols: string[]; ref: string; refCols: string[] }>()
    for (const f of fks.rows) {
      const k = str(f[0])
      const e = byFk.get(k) ?? { cols: [], ref: `${q(str(f[2]))}.${q(str(f[3]))}`, refCols: [] }
      e.cols.push(q(str(f[1])))
      e.refCols.push(q(str(f[4])))
      byFk.set(k, e)
    }
    for (const [k, e] of byFk) lines.push(`  CONSTRAINT ${q(k)} FOREIGN KEY (${e.cols.join(', ')}) REFERENCES ${e.ref} (${e.refCols.join(', ')})`)
    const out = [`CREATE TABLE ${name} (\n${lines.join(',\n')}\n);`]
    for (const i of ix.filter((x) => !x.primary)) out.push(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${name} (${i.columns.map(q).join(', ')});`)
    return out.join('\n\nGO\n\n')
  },

  async completion(s, db, schema) {
    const r = await s.query(
      `SELECT TOP 50000 o.name, c.name FROM ${sys(db, 'columns')} c JOIN ${sys(db, 'objects')} o ON o.object_id = c.object_id
       JOIN ${sys(db, 'schemas')} s ON s.schema_id = o.schema_id WHERE s.name = @p1 AND o.type IN ('U', 'V') ORDER BY o.name, c.column_id`,
      [schema || 'dbo'],
    )
    return groupColumns(r.rows)
  },
}
