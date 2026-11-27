// Oracle (oracledb Thin 모드 — 순수 JS, Instant Client 필요 없음). 탐색기 단계는 서비스(DB 하나) → 스키마(사용자) → 표·뷰.
// 문장 끝의 ;는 빼고 보낸다(PL/SQL 블록만 END;까지). 트랜잭션은 저절로 열리고, 자동 커밋은 우리가 문장마다 정한다.
import oracledb from 'oracledb'
import { designSql } from '../../shared/alter'
import { quoteIdent } from '../../shared/dialect'
import { t } from '../../shared/i18n'
import { isPlsql } from '../../shared/sql'
import type { Cell, ColumnInfo, DbObject, DesignIndex, IndexInfo, ResultColumn, SearchKind, StatementResult, TableDesign, TableRef } from '../../shared/types'
import { toCell, toParam } from '../values'
import { bool, elapsed, fkAction, groupColumns, groupForeignKeys, Session, str, type DriverModule, type OnColumns, type OnRows, type OpenOptions, type Rows } from './base'

const q = (n: string) => quoteIdent('oracle', n)
const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Oracle DATE·TIMESTAMP는 드라이버가 이 PC 시간대의 Date로 준다 → 그 시간대 기준 글자로 */
function formatLocal(d: Date, withMs: boolean): string {
  const ms = d.getMilliseconds()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${withMs && ms ? '.' + pad(ms, 3) : ''}`
}

function oraCell(v: unknown, binLimit: number, dbType?: string): Cell {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    if (dbType === 'TIMESTAMP WITH TIME ZONE' || dbType === 'TIMESTAMP WITH LOCAL TIME ZONE') {
      const off = -v.getTimezoneOffset()
      return `${formatLocal(v, true)} ${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
    }
    return formatLocal(v, dbType !== 'DATE')
  }
  // VECTOR(23ai)는 숫자 배열로
  if (v instanceof Float32Array || v instanceof Float64Array || v instanceof Int8Array) return JSON.stringify(Array.from(v))
  return toCell(v, binLimit)
}

/** NUMBER는 글자로 받아(정확도) 안전한 정수만 숫자로. CLOB은 글자, BLOB은 바이트 */
const fetchTypeHandler = (meta: oracledb.Metadata<unknown>): oracledb.FetchTypeResponse | undefined => {
  if (meta.dbType === oracledb.DB_TYPE_NUMBER) return { type: oracledb.STRING, converter: (v: unknown) => (typeof v === 'string' && /^-?\d{1,15}$/.test(v) ? Number(v) : v) }
  if (meta.dbType === oracledb.DB_TYPE_CLOB || meta.dbType === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING }
  if (meta.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER }
  return undefined
}

/** 자리 표시 값: 참거짓은 1/0(19c까지 SQL에 BOOLEAN이 없다), 긴 글·바이트는 LOB으로 */
function bindOf(v: Cell): oracledb.BindParameter | string | number | null | Buffer {
  const x = toParam(v)
  if (typeof x === 'boolean') return x ? 1 : 0
  if (typeof x === 'string' && Buffer.byteLength(x) > 32767) return { val: x, type: oracledb.DB_TYPE_CLOB }
  if (Buffer.isBuffer(x) && x.length > 32767) return { val: x, type: oracledb.DB_TYPE_BLOB }
  return x
}

type OraError = Error & { offset?: number; errorNum?: number }

function oraError(e: unknown, sql?: string): Error {
  const err = e as OraError
  if (!(err instanceof Error)) return new Error(String(e))
  const msg = err.message.replace(/\nHelp: https:\/\/docs\.oracle\.com\/\S+/g, '')
  if (sql && typeof err.offset === 'number' && err.offset > 0) {
    const line = sql.slice(0, err.offset).split('\n').length
    return new Error(`${msg}\n${t('위치: {line}번째 줄', { line })}`)
  }
  return new Error(msg)
}

/** 편집기 글 → 보낼 문장: SQL은 끝의 ;와 / 줄을 빼고, PL/SQL은 END;의 ;가 있어야 한다 */
export function oracleStatement(sql: string): string {
  let s = sql.trim().replace(/\n\s*\/\s*$/, '').trim()
  if (isPlsql(s)) return /;\s*$/.test(s) ? s : s + ';'
  s = s.replace(/;+\s*$/, '')
  return s
}

const connectString = (o: OpenOptions) => {
  const svc = o.database || o.config.database
  // ( 로 시작하면 TNS 설명 전체
  if (svc.trim().startsWith('(')) return svc.trim()
  return `${o.config.ssl === 'off' ? '' : 'tcps://'}${o.endpoint.host}:${o.endpoint.port}/${svc}`
}

export class OracleSession extends Session {
  readonly dialect = 'oracle' as const

  constructor(private conn: oracledb.Connection, readonly service: string) {
    super()
  }

  get serverVersion() {
    return this.conn.oracleServerVersionString
  }

  private get autoCommit() {
    return !(this.manualCommit || this.inTransaction)
  }

  private columnsOf(meta: oracledb.Metadata<unknown[]>[] | undefined): ResultColumn[] {
    return (meta ?? []).map((m) => ({ name: m.name, type: m.dbTypeName ?? '' }))
  }

  private rowsOf(meta: oracledb.Metadata<unknown[]>[] | undefined, rows: unknown[][], binLimit: number): Cell[][] {
    const types = (meta ?? []).map((m) => m.dbTypeName)
    return rows.map((r) => r.map((v, i) => oraCell(v, binLimit, types[i])))
  }

  protected async runRaw(sql: string, maxRows: number): Promise<StatementResult[]> {
    const t0 = performance.now()
    const text = oracleStatement(sql)
    try {
      const r = await this.conn.execute<unknown[]>(text, [], { resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, fetchTypeHandler, autoCommit: this.autoCommit })
      if (!r.resultSet) return [{ sql, columns: null, rows: [], truncated: false, affected: r.rowsAffected ?? null, ms: elapsed(t0) }]
      try {
        const rows = await r.resultSet.getRows(maxRows + 1)
        const truncated = rows.length > maxRows
        return [{ sql, columns: this.columnsOf(r.metaData), rows: this.rowsOf(r.metaData, rows.slice(0, maxRows), 64), truncated, affected: null, ms: elapsed(t0) }]
      } finally {
        await r.resultSet.close().catch(() => undefined)
      }
    } catch (e) {
      throw oraError(e, text)
    }
  }

  protected async queryRaw(sql: string, params: Cell[], binLimit: number): Promise<Rows> {
    try {
      const r = await this.conn.execute<unknown[]>(oracleStatement(sql), params.map(bindOf), { outFormat: oracledb.OUT_FORMAT_ARRAY, fetchTypeHandler, autoCommit: this.autoCommit })
      return { columns: this.columnsOf(r.metaData), rows: this.rowsOf(r.metaData, r.rows ?? [], binLimit) }
    } catch (e) {
      throw oraError(e, sql)
    }
  }

  protected async execRaw(sql: string, params: Cell[]): Promise<number | null> {
    try {
      const r = await this.conn.execute(oracleStatement(sql), params.map(bindOf), { autoCommit: this.autoCommit })
      return r.rowsAffected ?? null
    } catch (e) {
      throw oraError(e, sql)
    }
  }

  protected async streamRaw(sql: string, onColumns: OnColumns, onRows: OnRows): Promise<number> {
    const text = oracleStatement(sql)
    let total = 0
    try {
      const r = await this.conn.execute<unknown[]>(text, [], { resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, fetchTypeHandler, autoCommit: this.autoCommit })
      onColumns(this.columnsOf(r.metaData))
      if (!r.resultSet) return 0
      try {
        for (;;) {
          const rows = await r.resultSet.getRows(1000)
          if (!rows.length) return total
          total += rows.length
          await onRows(this.rowsOf(r.metaData, rows, Infinity))
        }
      } finally {
        await r.resultSet.close().catch(() => undefined)
      }
    } catch (e) {
      throw oraError(e, text)
    }
  }

  /** 여러 행 넣기: executeMany (19c까지는 여러 행 VALUES가 없다). 열마다 값 모양을 보고 묶는 타입을 정한다 */
  protected async insertManyRaw(ref: TableRef, columns: string[], rows: Cell[][]): Promise<number> {
    if (!columns.length || !rows.length) return 0
    const sql = `INSERT INTO ${q(ref.schema)}.${q(ref.table)} (${columns.map(q).join(', ')}) VALUES (${columns.map((_, i) => ':' + (i + 1)).join(', ')})`
    const binds = rows.map((r) => columns.map((_, i) => {
      const x = toParam(r[i] ?? null)
      return typeof x === 'boolean' ? (x ? 1 : 0) : x
    }))
    const bindDefs = columns.map((_, i) => {
      let bin = false
      let str = false
      let size = 1
      for (const r of binds) {
        const v = r[i]
        if (v === null) continue
        if (Buffer.isBuffer(v)) {
          bin = true
          size = Math.max(size, v.length)
        } else {
          str = true
          size = Math.max(size, Buffer.byteLength(String(v)))
        }
      }
      if (bin && !str) return size > 32767 ? { type: oracledb.DB_TYPE_BLOB } : { type: oracledb.BUFFER, maxSize: size }
      return size > 32767 ? { type: oracledb.DB_TYPE_CLOB } : { type: oracledb.STRING, maxSize: size }
    })
    // 글자로 묶은 열에 숫자가 섞이면 글자로 (Oracle이 열 타입으로 바꾼다)
    for (const r of binds) {
      r.forEach((v, i) => {
        if (v !== null && !Buffer.isBuffer(v) && bindDefs[i].type !== oracledb.BUFFER && bindDefs[i].type !== oracledb.DB_TYPE_BLOB) r[i] = String(v)
      })
    }
    try {
      const r = await this.conn.executeMany(sql, binds, { autoCommit: this.autoCommit, bindDefs })
      return r.rowsAffected ?? rows.length
    } catch (e) {
      throw oraError(e)
    }
  }

  async cancel(): Promise<void> {
    await this.conn.break().catch(() => undefined)
  }

  async close(): Promise<void> {
    await this.conn.close().catch(() => undefined)
  }

  async useDatabase(db: string): Promise<boolean> {
    return !db || db.toUpperCase() === this.service.toUpperCase()
  }

  async setSchema(schema: string): Promise<void> {
    if (schema) await this.exec(`ALTER SESSION SET CURRENT_SCHEMA = ${q(schema)}`)
  }
}

/** 열 타입 글자: VARCHAR2(100) · NUMBER(10,2) · TIMESTAMP(6) … */
function typeText(x: Cell[]): string {
  const type = str(x[0])
  const len = Number(x[1])
  const prec = x[2] === null ? null : Number(x[2])
  const scale = x[3] === null ? null : Number(x[3])
  const charLen = Number(x[4])
  const charUsed = str(x[5])
  if (/^(N?VARCHAR2|N?CHAR)$/.test(type)) return `${type}(${charLen || len}${charUsed === 'C' && !type.startsWith('N') ? ' CHAR' : ''})`
  if (type === 'NUMBER') {
    if (prec === null) return scale === 0 ? 'INTEGER' : 'NUMBER'
    return scale ? `NUMBER(${prec},${scale})` : `NUMBER(${prec})`
  }
  if (type === 'FLOAT') return prec ? `FLOAT(${prec})` : 'FLOAT'
  if (type === 'RAW') return `RAW(${len})`
  return type
}

const COLS_SQL = `SELECT c.data_type, c.data_length, c.data_precision, c.data_scale, c.char_length, c.char_used,
    c.column_name, c.nullable, c.data_default, c.identity_column, c.virtual_column, cm.comments
  FROM all_tab_cols c
  LEFT JOIN all_col_comments cm ON cm.owner = c.owner AND cm.table_name = c.table_name AND cm.column_name = c.column_name
  WHERE c.owner = :1 AND c.table_name = :2 AND c.hidden_column = 'NO' ORDER BY c.column_id`

async function pkOf(s: Session, ref: TableRef): Promise<{ name: string; columns: string[] }> {
  const r = await s.query(
    `SELECT c.constraint_name, cc.column_name FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
     WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'P' ORDER BY cc.position`,
    [ref.schema, ref.table],
  )
  return { name: str(r.rows[0]?.[0]), columns: r.rows.map((x) => str(x[1])) }
}

async function oraColumns(s: Session, ref: TableRef): Promise<ColumnInfo[]> {
  const r = await s.query(COLS_SQL, [ref.schema, ref.table])
  const pk = (await pkOf(s, ref)).columns
  return r.rows.map((x) => {
    const ident = str(x[9]) === 'YES'
    const def = x[8] === null ? null : str(x[8]).trim() || null
    return {
      name: str(x[6]),
      type: typeText(x),
      nullable: str(x[7]) === 'Y',
      default: ident ? null : def,
      pk: pk.includes(str(x[6])),
      autoIncrement: ident,
      comment: str(x[11]),
      generated: str(x[10]) === 'YES',
    }
  })
}

/** 인덱스 행 [이름, 고유, 열, 식] — 함수 기반 인덱스는 숨은 열 이름 대신 식 */
async function oraIndexRows(s: Session, ref: TableRef) {
  const r = await s.query(
    `SELECT i.index_name, i.uniqueness, ic.column_name, ie.column_expression, ic.column_position
     FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
     LEFT JOIN all_ind_expressions ie ON ie.index_owner = ic.index_owner AND ie.index_name = ic.index_name AND ie.column_position = ic.column_position
     WHERE i.table_owner = :1 AND i.table_name = :2 AND i.index_type NOT IN ('LOB') ORDER BY i.index_name, ic.column_position`,
    [ref.schema, ref.table],
  )
  return r.rows
}

const SYS_USERS = `oracle_maintained = 'N'`

export const oracleDriver: DriverModule = {
  dialect: 'oracle',
  perDatabase: false,
  defaultDatabase: (c) => c.database,

  async open(o) {
    let conn: oracledb.Connection
    try {
      conn = await oracledb.getConnection({ user: o.config.user, password: o.password, connectString: connectString(o), connectTimeout: 15 })
    } catch (e) {
      throw oraError(e)
    }
    const s = new OracleSession(conn, o.config.database || o.database)
    try {
      // 날짜를 글자로 넣고 비교할 때 쓰는 모양 (화면에 보여 주는 모양과 같게)
      await s.exec(`ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF' NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM' NLS_NUMERIC_CHARACTERS = '.,'`)
    } catch (e) {
      await s.close()
      throw e
    }
    return s
  },

  async version(s) {
    const v = s instanceof OracleSession ? s.serverVersion : ''
    try {
      const r = await s.query(`SELECT banner FROM v$version WHERE ROWNUM = 1`)
      return str(r.rows[0]?.[0]).replace(/\s*-\s*(Production|Develop).*$/i, '').trim() || 'Oracle ' + v
    } catch {
      return 'Oracle ' + v
    }
  },

  async databases(s) {
    const r = await s.query(`SELECT sys_context('USERENV', 'CURRENT_SCHEMA') FROM dual`)
    const name = s instanceof OracleSession ? s.service : ''
    return { databases: [name], hasSchemas: true, defaultSchema: str(r.rows[0]?.[0]) }
  },

  async schemas(s, _db, o) {
    const r = await s.query(`SELECT username FROM all_users${o.showSystem ? '' : ' WHERE ' + SYS_USERS} ORDER BY username`)
    return r.rows.map((x) => str(x[0]))
  },

  async objects(s, _db, schema) {
    const r = await s.query(
      `SELECT t.table_name, 'table', c.comments FROM all_tables t
         LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
       WHERE t.owner = :1 AND t.nested = 'NO' AND t.secondary = 'N' AND t.dropped = 'NO' AND (t.iot_type IS NULL OR t.iot_type = 'IOT')
         AND NOT EXISTS (SELECT 1 FROM all_mviews m WHERE m.owner = t.owner AND m.mview_name = t.table_name)
       UNION ALL
       SELECT v.view_name, 'view', c.comments FROM all_views v LEFT JOIN all_tab_comments c ON c.owner = v.owner AND c.table_name = v.view_name WHERE v.owner = :2
       UNION ALL
       SELECT m.mview_name, 'view', NULL FROM all_mviews m WHERE m.owner = :3
       ORDER BY 1`,
      [schema, schema, schema],
    )
    return r.rows.map((x): DbObject => ({ name: str(x[0]), kind: str(x[1]) === 'view' ? 'view' : 'table', comment: str(x[2]) }))
  },

  columns: oraColumns,

  async indexes(s, ref) {
    const pk = await pkOf(s, ref)
    const rows = await oraIndexRows(s, ref)
    const map = new Map<string, IndexInfo>()
    for (const x of rows) {
      const name = str(x[0])
      let ix = map.get(name)
      if (!ix) {
        ix = { name, unique: str(x[1]) === 'UNIQUE', primary: false, columns: [] }
        map.set(name, ix)
      }
      ix.columns.push(x[3] !== null ? str(x[3]) : str(x[2]))
    }
    const out = [...map.values()]
    // 기본 키 인덱스: 이름이 제약 이름과 같거나, 기본 키 열과 똑같은 고유 인덱스
    const pkIx = out.find((i) => i.name === pk.name) ?? out.find((i) => i.unique && i.columns.join() === pk.columns.join())
    if (pkIx) pkIx.primary = true
    else if (pk.columns.length) out.unshift({ name: pk.name, unique: true, primary: true, columns: pk.columns })
    return out.sort((a, b) => Number(b.primary) - Number(a.primary) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  },

  async ddl(s, ref, kind) {
    if (kind === 'view') {
      const v = await s.query('SELECT text FROM all_views WHERE owner = :1 AND view_name = :2', [ref.schema, ref.table])
      if (v.rows.length) return `CREATE OR REPLACE VIEW ${q(ref.schema)}.${q(ref.table)} AS\n${str(v.rows[0][0]).trim()};`
      const m = await s.query('SELECT query FROM all_mviews WHERE owner = :1 AND mview_name = :2', [ref.schema, ref.table])
      if (m.rows.length) return `CREATE MATERIALIZED VIEW ${q(ref.schema)}.${q(ref.table)} AS\n${str(m.rows[0][0]).trim()};`
      throw new Error(t('표를 찾지 못했어요: {name}', { name: ref.table }))
    }
    try {
      // 저장소 설정(TABLESPACE 등)은 빼고
      await s.exec(`BEGIN
  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE);
  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', FALSE);
  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);
  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'PRETTY', TRUE);
END;`)
      const out = [str((await s.query(`SELECT DBMS_METADATA.GET_DDL('TABLE', :1, :2) FROM dual`, [ref.table, ref.schema])).rows[0]?.[0]).trim()]
      // 기본 키·UNIQUE 제약의 인덱스는 CREATE TABLE 안에 이미 있다
      const ix = await s.query(
        `SELECT i.index_name FROM all_indexes i WHERE i.table_owner = :1 AND i.table_name = :2 AND i.index_type <> 'LOB'
           AND NOT EXISTS (SELECT 1 FROM all_constraints c WHERE c.owner = i.table_owner AND c.table_name = i.table_name AND c.index_name = i.index_name) ORDER BY 1`,
        [ref.schema, ref.table],
      )
      for (const x of ix.rows) out.push(str((await s.query(`SELECT DBMS_METADATA.GET_DDL('INDEX', :1, :2) FROM dual`, [str(x[0]), ref.schema])).rows[0]?.[0]).trim())
      try {
        out.push(str((await s.query(`SELECT DBMS_METADATA.GET_DEPENDENT_DDL('COMMENT', :1, :2) FROM dual`, [ref.table, ref.schema])).rows[0]?.[0]).trim())
      } catch {
        // ORA-31608: 설명이 없음
      }
      return out.filter(Boolean).join('\n\n')
    } catch {
      // DBMS_METADATA 권한이 없으면 설계 정보로 만든다
      const x = await oracleDriver.design(s, ref)
      return designSql('oracle', { db: ref.db, schema: ref.schema }, null, x).statements.map((st) => st + ';').join('\n\n')
    }
  },

  async foreignKeys(s, ref) {
    const r = await s.query(
      `SELECT c.constraint_name, cc.column_name, rc.owner, rc.table_name, rcc.column_name
       FROM all_constraints c
       JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
       JOIN all_constraints rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
       JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
       WHERE c.constraint_type = 'R' AND c.owner = :1 AND c.table_name = :2 ORDER BY c.constraint_name, cc.position`,
      [ref.schema, ref.table],
    )
    return groupForeignKeys(r.rows, (schema, table) => ({ db: ref.db, schema, table }))
  },

  async completion(s, _db, schema) {
    const r = await s.query(
      `SELECT table_name, column_name FROM all_tab_columns WHERE owner = :1 AND table_name NOT LIKE 'BIN$%' ORDER BY table_name, column_id FETCH FIRST 50000 ROWS ONLY`,
      [schema],
    )
    return groupColumns(r.rows)
  },

  async searchNames(s, db, like, o) {
    const sys = o.showSystem ? '' : ` AND owner IN (SELECT username FROM all_users WHERE ${SYS_USERS})`
    const kinds: Record<string, string> = { TABLE: 'table', VIEW: 'view', 'MATERIALIZED VIEW': 'view', PROCEDURE: 'procedure', FUNCTION: 'function', PACKAGE: 'package', TRIGGER: 'trigger', SEQUENCE: 'sequence' }
    const objs = await s.query(
      `SELECT owner, object_name, object_type FROM all_objects
       WHERE object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'SEQUENCE') AND object_name NOT LIKE 'BIN$%'
         AND UPPER(object_name) LIKE UPPER(:1) ESCAPE '\\'${sys} ORDER BY 1, 2 FETCH FIRST 1000 ROWS ONLY`,
      [like],
    )
    const cols = await s.query(
      `SELECT owner, table_name, column_name, data_type FROM all_tab_columns WHERE UPPER(column_name) LIKE UPPER(:1) ESCAPE '\\' AND table_name NOT LIKE 'BIN$%'${sys}
       ORDER BY 1, 2, column_id FETCH FIRST 1000 ROWS ONLY`,
      [like],
    )
    return [
      ...objs.rows.map((x) => {
        const kind = (kinds[str(x[2])] ?? 'table') as SearchKind
        return { db, schema: str(x[0]), kind, table: kind === 'table' || kind === 'view' ? str(x[1]) : '', name: str(x[1]), extra: '' }
      }),
      ...cols.rows.map((x) => ({ db, schema: str(x[0]), kind: 'column' as const, table: str(x[1]), name: str(x[2]), extra: str(x[3]) })),
    ]
  },

  users: {
    async list(s) {
      const r = await s.query(`SELECT username, oracle_maintained FROM all_users ORDER BY username`)
      // DBA 권한이 있으면 상태(잠김 등)도
      const status = new Map<string, string>()
      try {
        const d = await s.query(`SELECT username, account_status FROM dba_users`)
        for (const x of d.rows) status.set(str(x[0]), str(x[1]))
      } catch {
        // 일반 사용자는 dba_users를 못 본다
      }
      return r.rows.map((x) => {
        const st = status.get(str(x[0])) ?? ''
        return { name: str(x[0]), host: '', login: !/LOCKED/.test(st), superuser: false, attrs: [str(x[1]) === 'Y' ? 'ORACLE_MAINTAINED' : '', st && st !== 'OPEN' ? st : ''].filter(Boolean) }
      })
    },
    async grants(s, name) {
      const out: string[] = []
      const tryQ = async (sql: string, fmt: (x: Cell[]) => string) => {
        try {
          for (const x of (await s.query(sql, [name])).rows) out.push(fmt(x))
          return true
        } catch {
          return false
        }
      }
      if (!(await tryQ(`SELECT granted_role FROM dba_role_privs WHERE grantee = :1 ORDER BY 1`, (x) => `ROLE ${str(x[0])}`))) {
        await tryQ(`SELECT granted_role FROM user_role_privs WHERE username = :1 ORDER BY 1`, (x) => `ROLE ${str(x[0])}`)
      }
      if (!(await tryQ(`SELECT privilege FROM dba_sys_privs WHERE grantee = :1 ORDER BY 1`, (x) => str(x[0])))) {
        await tryQ(`SELECT privilege FROM user_sys_privs WHERE username = :1 ORDER BY 1`, (x) => str(x[0]))
      }
      // 다른 사용자가 준 권한(GRANT ANY OBJECT PRIVILEGE)은 all_tab_privs에 안 보여서 DBA 보기 먼저
      const objPrivs = (view: string, owner: string) =>
        `SELECT LISTAGG(privilege, ', ') WITHIN GROUP (ORDER BY privilege), ${owner} || '.' || table_name FROM ${view} WHERE grantee = :1 GROUP BY ${owner}, table_name ORDER BY 2 FETCH FIRST 2000 ROWS ONLY`
      if (!(await tryQ(objPrivs('dba_tab_privs', 'owner'), (x) => `${str(x[0])} ON ${str(x[1])}`))) {
        await tryQ(objPrivs('all_tab_privs', 'table_schema'), (x) => `${str(x[0])} ON ${str(x[1])}`)
      }
      return out
    },
  },

  stats: async (s) => {
    const r = await s.query(
      `SELECT (SELECT COUNT(*) FROM v$session WHERE type = 'USER'),
         (SELECT COUNT(*) FROM v$session WHERE type = 'USER' AND status = 'ACTIVE'),
         (SELECT COUNT(*) FROM v$session WHERE blocking_session IS NOT NULL),
         (SELECT value FROM v$sysstat WHERE name = 'execute count'),
         (SELECT SUM(value) FROM v$sysstat WHERE name IN ('user commits', 'user rollbacks')),
         (SELECT value FROM v$sysstat WHERE name = 'session logical reads'),
         (SELECT ROUND((SYSDATE - startup_time) * 86400) FROM v$instance)
       FROM dual`,
    )
    const x = r.rows[0] ?? []
    return {
      gauges: { connections: Number(x[0]), active: Number(x[1]), lockWaits: Number(x[2]) },
      counters: { queries: Number(x[3]), transactions: Number(x[4]), rowsRead: Number(x[5]) },
      info: { uptime: str(x[6]) },
    }
  },

  sessions: {
    async list(s) {
      const r = await s.query(
        `SELECT s.sid || ',' || s.serial#, NVL(s.username, ''), NVL(s.schemaname, ''), NVL(s.machine, ''), NVL(s.program, ''), s.status, s.last_call_et,
           (SELECT q.sql_text FROM v$sql q WHERE q.sql_id = s.sql_id AND q.child_number = s.sql_child_number), CASE WHEN s.sid = SYS_CONTEXT('USERENV', 'SID') THEN 1 ELSE 0 END
         FROM v$session s WHERE s.type = 'USER' ORDER BY s.sid`,
      )
      return r.rows.map((x) => ({ id: str(x[0]), user: str(x[1]), db: str(x[2]), host: str(x[3]), app: str(x[4]), state: str(x[5]), seconds: x[6] === null ? null : Number(x[6]), query: str(x[7]), own: bool(x[8]) }))
    },
    async kill(s, id, queryOnly) {
      if (!/^\d+,\d+$/.test(id)) throw new Error(t('잘못된 요청'))
      await s.exec(queryOnly ? `ALTER SYSTEM CANCEL SQL '${id}'` : `ALTER SYSTEM KILL SESSION '${id}' IMMEDIATE`)
    },
  },

  async extras(s, _db, schema) {
    const r = await s.query(
      `SELECT object_type, object_name FROM all_objects WHERE owner = :1 AND object_type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'SEQUENCE') ORDER BY object_name`,
      [schema],
    )
    const tr = await s.query('SELECT trigger_name, table_name FROM all_triggers WHERE owner = :1', [schema])
    const tables = new Map(tr.rows.map((x) => [str(x[0]), str(x[1])]))
    const kinds = { PROCEDURE: 'procedure', FUNCTION: 'function', PACKAGE: 'package', TRIGGER: 'trigger', SEQUENCE: 'sequence' } as const
    return r.rows
      .filter((x) => !(str(x[0]) === 'SEQUENCE' && /^ISEQ\$\$_/.test(str(x[1])))) // IDENTITY 열이 만든 시퀀스
      .map((x) => ({ kind: kinds[str(x[0]) as keyof typeof kinds], name: str(x[1]), id: str(x[1]), table: tables.get(str(x[1])) ?? '', args: '' }))
  },

  async source(s, _db, schema, kind, id) {
    if (kind === 'sequence') {
      const r = await s.query('SELECT min_value, max_value, increment_by, cycle_flag, cache_size, last_number FROM all_sequences WHERE sequence_owner = :1 AND sequence_name = :2', [schema, id])
      const x = r.rows[0]
      if (!x) throw new Error(t('개체를 찾지 못했어요: {name}', { name: id }))
      return `CREATE SEQUENCE ${q(schema)}.${q(id)} START WITH ${str(x[5])} INCREMENT BY ${str(x[2])} MINVALUE ${str(x[0])} MAXVALUE ${str(x[1])} ${Number(x[4]) > 0 ? 'CACHE ' + str(x[4]) : 'NOCACHE'} ${str(x[3]) === 'Y' ? 'CYCLE' : 'NOCYCLE'};`
    }
    const types = kind === 'package' ? ['PACKAGE', 'PACKAGE BODY'] : [kind.toUpperCase()]
    const parts: string[] = []
    for (const type of types) {
      const r = await s.query('SELECT text FROM all_source WHERE owner = :1 AND name = :2 AND type = :3 ORDER BY line', [schema, id, type])
      if (!r.rows.length) continue
      const text = r.rows.map((x) => str(x[0])).join('').trim()
      // all_source는 "PROCEDURE p …"부터 → 이름에 스키마를 붙여 CREATE OR REPLACE로
      parts.push('CREATE OR REPLACE ' + text.replace(/^(\s*(?:PACKAGE\s+BODY|PACKAGE|PROCEDURE|FUNCTION|TRIGGER)\s+)("?[\w$#]+"?)/i, (_m, head: string, name: string) => `${head}${q(schema)}.${name.startsWith('"') ? name : q(name.toUpperCase())}`) + '\n/')
    }
    if (!parts.length) throw new Error(t('개체를 찾지 못했어요: {name}', { name: id }))
    return parts.join('\n\n')
  },

  async design(s, ref): Promise<TableDesign> {
    const r = await s.query(COLS_SQL, [ref.schema, ref.table])
    if (!r.rows.length) throw new Error(t('표를 찾지 못했어요: {name}', { name: ref.table }))
    const pk = await pkOf(s, ref)
    // UNIQUE 제약(그 인덱스와 같은 이름)은 제약으로, 기본 키 인덱스는 빼고
    const uq = await s.query(`SELECT constraint_name, index_name FROM all_constraints WHERE owner = :1 AND table_name = :2 AND constraint_type IN ('U', 'P')`, [ref.schema, ref.table])
    const consIx = new Map(uq.rows.map((x) => [str(x[1]), str(x[0])]))
    const pkIndex = uq.rows.find((x) => str(x[0]) === pk.name)?.[1]
    const map = new Map<string, DesignIndex & { parts: string[] }>()
    for (const x of await oraIndexRows(s, ref)) {
      const name = str(x[0])
      if (name === str(pkIndex ?? '')) continue
      let ix = map.get(name)
      if (!ix) {
        const cons = consIx.get(name)
        ix = { name: cons ?? name, unique: str(x[1]) === 'UNIQUE', columns: [], orig: cons ?? name, parts: [], ...(cons ? { constraint: true } : {}) }
        map.set(name, ix)
      }
      ix.columns.push(x[3] !== null ? t('(식)') : str(x[2]))
      ix.parts.push(x[3] !== null ? str(x[3]) : q(str(x[2])))
    }
    // 식 인덱스는 원래 모양 그대로 다시 만든다
    const indexes: DesignIndex[] = [...map.values()].map(({ parts, ...ix }) =>
      ix.columns.includes(t('(식)')) ? { ...ix, sql: `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ref.schema)}.${q(ix.name)} ON ${q(ref.schema)}.${q(ref.table)} (${parts.join(', ')})` } : ix)
    const fk = await s.query(
      `SELECT c.constraint_name, cc.column_name, rc.owner, rc.table_name, rcc.column_name, 'NO ACTION', c.delete_rule
       FROM all_constraints c
       JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
       JOIN all_constraints rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
       JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
       WHERE c.constraint_type = 'R' AND c.owner = :1 AND c.table_name = :2 ORDER BY c.constraint_name, cc.position`,
      [ref.schema, ref.table],
    )
    const fks = new Map<string, TableDesign['foreignKeys'][number]>()
    for (const x of fk.rows) {
      const name = str(x[0])
      let f = fks.get(name)
      if (!f) {
        f = { name, columns: [], refSchema: str(x[2]), refTable: str(x[3]), refColumns: [], onUpdate: 'NO ACTION', onDelete: fkAction(str(x[6])), orig: name }
        fks.set(name, f)
      }
      f.columns.push(str(x[1]))
      f.refColumns.push(str(x[4]))
    }
    const tc = await s.query('SELECT comments FROM all_tab_comments WHERE owner = :1 AND table_name = :2', [ref.schema, ref.table])
    return {
      name: ref.table,
      comment: str(tc.rows[0]?.[0]),
      columns: r.rows.map((x) => {
        const ident = str(x[9]) === 'YES'
        const generated = str(x[10]) === 'YES'
        return {
          name: str(x[6]),
          type: typeText(x),
          nullable: str(x[7]) === 'Y',
          default: ident || generated || x[8] === null ? '' : str(x[8]).trim(),
          autoIncrement: ident,
          comment: str(x[11]),
          generated,
          orig: str(x[6]),
        }
      }),
      primaryKey: pk.columns,
      pkName: pk.name,
      indexes,
      foreignKeys: [...fks.values()],
      unsupported: [],
    }
  },
}
