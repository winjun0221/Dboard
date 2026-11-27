// ClickHouse (@clickhouse/client, HTTP — 순수 JS). 탐색기 단계는 DB → 표·뷰 (스키마 단계 없음).
// 트랜잭션·외래 키가 없고, 행 하나만 정확히 고치는 방법이 없어서 표 데이터 고치기는 막는다(features.ts).
// 값 자리(?)는 드라이버가 글자로 넣는다(literal). 연결마다 HTTP 세션(session_id)을 둬서 SET·임시 표가 이어진다.
import https from 'node:https'
import { ClickHouseLogLevel, createClient, type ClickHouseClient, type ClickHouseSettings } from '@clickhouse/client'
import { literal, quoteIdent } from '../../shared/dialect'
import { t } from '../../shared/i18n'
import { firstKeyword, mask } from '../../shared/sql'
import type { Cell, ColumnInfo, DbObject, IndexInfo, ResultColumn, StatementResult, TableRef } from '../../shared/types'
import { chUnwrap } from '../../shared/alter'
import { toCell } from '../values'
import { bool, elapsed, groupColumns, Session, str, type DriverModule, type OnColumns, type OnRows, type OpenOptions, type Rows } from './base'

const q = (n: string) => quoteIdent('clickhouse', n)
const FORMAT = 'JSONCompactEachRowWithNamesAndTypes'
/** 결과를 돌려주는 문장 (나머지는 command로 — query로 보내면 FORMAT이 붙어 문법 오류) */
const ROW_WORDS = new Set(['SELECT', 'WITH', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'EXISTS', 'CHECK', 'VALUES'])

/** ? 자리에 값을 글자로 (문자열·주석 안의 ?는 그대로) */
export function bindClickhouse(sql: string, params: Cell[]): string {
  if (!params.length) return sql
  const m = mask(sql, 'clickhouse')
  let out = ''
  let k = 0
  for (let i = 0; i < sql.length; i++) {
    if (m[i] === '?' && k < params.length) out += literal('clickhouse', params[k++])
    else out += sql[i]
  }
  if (k !== params.length) throw new Error(t('값 자리 수가 맞지 않아요'))
  return out
}

const BASE_SETTINGS: ClickHouseSettings = {
  output_format_json_quote_decimals: 1,
  output_format_json_quote_64bit_integers: 1,
  date_time_output_format: 'simple',
}

type ChError = Error & { code?: string; type?: string }
const chError = (e: unknown): Error => {
  const err = e as ChError
  if (!(err instanceof Error)) return new Error(String(e))
  return new Error(err.type ? `${err.message.trim()}\n(${err.type})` : err.message)
}

function clientOf(o: OpenOptions, database: string, sessionId: string): ClickHouseClient {
  const c = o.config
  const secure = c.ssl !== 'off'
  return createClient({
    url: `${secure ? 'https' : 'http'}://${o.endpoint.host}:${o.endpoint.port}`,
    username: c.user || 'default',
    password: o.password,
    database: database || 'default',
    session_id: sessionId || undefined,
    application: 'DBoard',
    request_timeout: 24 * 3600_000,
    log: { level: ClickHouseLogLevel.OFF },
    clickhouse_settings: { ...BASE_SETTINGS, ...(c.readOnly === true ? { readonly: '2' } : {}) },
    // 인증서를 확인하지 않는 암호화(require)
    ...(secure && c.ssl === 'require' ? { http_agent: new https.Agent({ rejectUnauthorized: false, keepAlive: true }), set_basic_auth_header: true } : {}),
  })
}

const randomId = () => `dboard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export class ClickHouseSession extends Session {
  readonly dialect = 'clickhouse' as const
  private client: ClickHouseClient
  private current: { id: string; abort: AbortController } | null = null

  constructor(private opts: OpenOptions, public db: string, private sessionId = randomId()) {
    super()
    this.client = clientOf(opts, db, sessionId)
  }

  /** 세션이 아직 앞 요청(취소된 것)을 잡고 있으면 잠깐 기다렸다가 다시 */
  private async call<T>(fn: (o: { query_id: string; abort_signal: AbortSignal }) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const cur = { id: randomId(), abort: new AbortController() }
      this.current = cur
      try {
        return await fn({ query_id: cur.id, abort_signal: cur.abort.signal })
      } catch (e) {
        const err = e as ChError
        if (err.type === 'SESSION_IS_LOCKED' && attempt < 20) {
          await new Promise((ok) => setTimeout(ok, 250))
          continue
        }
        if (cur.abort.signal.aborted) throw new Error(t('취소했어요'))
        throw chError(e)
      } finally {
        if (this.current === cur) this.current = null
      }
    }
  }

  private isQuery(sql: string) {
    return ROW_WORDS.has(firstKeyword(sql, 'clickhouse'))
  }

  private async select(sql: string, settings: ClickHouseSettings = {}): Promise<{ columns: ResultColumn[]; rows: unknown[][] }> {
    return this.call(async (o) => {
      const rs = await this.client.query({ query: sql, format: FORMAT, clickhouse_settings: settings, ...o })
      const all = (await rs.json()) as unknown as unknown[][]
      const names = (all[0] ?? []) as string[]
      const types = (all[1] ?? []) as string[]
      return { columns: names.map((name, i) => ({ name, type: types[i] ?? '' })), rows: all.slice(2) }
    })
  }

  private command(sql: string): Promise<number | null> {
    return this.call(async (o) => {
      const r = await this.client.command({ query: sql, ...o })
      return firstKeyword(sql, 'clickhouse') === 'INSERT' ? Number(r.summary?.written_rows ?? 0) : null
    })
  }

  protected async runRaw(sql: string, maxRows: number): Promise<StatementResult[]> {
    const t0 = performance.now()
    if (!this.isQuery(sql)) return [{ sql, columns: null, rows: [], truncated: false, affected: await this.command(sql), ms: elapsed(t0) }]
    // 넘치면 덩어리 단위로 멈춘다 (오류 대신 앞부분)
    const r = await this.select(sql, { max_result_rows: String(maxRows + 1), result_overflow_mode: 'break' })
    return [{ sql, columns: r.columns, rows: r.rows.slice(0, maxRows).map((x) => x.map((v) => toCell(v))), truncated: r.rows.length > maxRows, affected: null, ms: elapsed(t0) }]
  }

  protected async queryRaw(sql: string, params: Cell[], binLimit: number): Promise<Rows> {
    const text = bindClickhouse(sql, params)
    if (!this.isQuery(text)) {
      await this.command(text)
      return { columns: [], rows: [] }
    }
    const r = await this.select(text)
    return { columns: r.columns, rows: r.rows.map((x) => x.map((v) => toCell(v, binLimit))) }
  }

  protected async execRaw(sql: string, params: Cell[]): Promise<number | null> {
    const text = bindClickhouse(sql, params)
    if (this.isQuery(text)) {
      await this.select(text)
      return null
    }
    return this.command(text)
  }

  protected async streamRaw(sql: string, onColumns: OnColumns, onRows: OnRows): Promise<number> {
    return this.call(async (o) => {
      const rs = await this.client.query({ query: sql, format: FORMAT, ...o })
      let total = 0
      let head: unknown[][] = []
      for await (const batch of rs.stream()) {
        let rows = (batch as { json: () => unknown }[]).map((r) => r.json() as unknown[])
        // 처음 두 줄은 열 이름·타입
        if (head.length < 2) {
          const need = 2 - head.length
          head = head.concat(rows.slice(0, need))
          rows = rows.slice(need)
          if (head.length === 2) onColumns((head[0] as string[]).map((name, i) => ({ name, type: String((head[1] as string[])[i] ?? '') })))
        }
        if (!rows.length) continue
        total += rows.length
        await onRows(rows.map((x) => x.map((v) => toCell(v, Infinity))))
      }
      if (head.length < 2) onColumns([])
      return total
    })
  }

  /** 요청을 끊고, 서버에서도 그 쿼리를 멈춘다 (끝날 때까지 기다려야 세션이 풀린다) */
  async cancel(): Promise<void> {
    const cur = this.current
    if (!cur) return
    cur.abort.abort()
    const other = clientOf(this.opts, this.db, '')
    try {
      await other.command({ query: `KILL QUERY WHERE query_id = ${literal('clickhouse', cur.id)} SYNC` }).catch(() => undefined)
    } finally {
      await other.close().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined)
  }

  /** DB 바꾸기 = 같은 세션 이름으로 클라이언트를 새로 (HTTP 요청마다 database가 붙는다) */
  async useDatabase(db: string): Promise<boolean> {
    if (!db || db === this.db) return true
    await this.client.close().catch(() => undefined)
    this.client = clientOf(this.opts, db, this.sessionId)
    this.db = db
    return true
  }

  async setSchema(): Promise<void> {}

  /** 읽기 전용은 요청마다 readonly=2 설정으로 (clientOf) */
  async applyReadOnly() {}
}

const SYS_DB = `name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')`
const VIEW_ENGINES = new Set(['View', 'MaterializedView', 'LiveView', 'WindowView'])

/** system.tables.engine_full에서 엔진 부분만 (ORDER BY 등 앞까지) */
export function engineOf(full: string): string {
  return full.split(/\s+(?=PARTITION BY|ORDER BY|PRIMARY KEY|SAMPLE BY|TTL|SETTINGS|COMMENT)\b/)[0].trim()
}

async function chColumns(s: Session, ref: TableRef): Promise<ColumnInfo[]> {
  const r = await s.query(
    `SELECT name, type, default_kind, default_expression, comment, is_in_primary_key FROM system.columns WHERE database = ? AND table = ? ORDER BY position`,
    [ref.db, ref.table],
  )
  return r.rows.map((x) => ({
    name: str(x[0]),
    type: str(x[1]),
    nullable: /^Nullable\(/.test(str(x[1])),
    default: str(x[2]) === 'DEFAULT' ? str(x[3]) : null,
    pk: bool(x[5]),
    autoIncrement: false,
    comment: str(x[4]),
    generated: str(x[2]) === 'MATERIALIZED' || str(x[2]) === 'ALIAS',
  }))
}

async function tableRow(s: Session, ref: TableRef) {
  const r = await s.query(`SELECT engine, engine_full, primary_key, sorting_key, comment FROM system.tables WHERE database = ? AND name = ?`, [ref.db, ref.table])
  if (!r.rows.length) throw new Error(t('표를 찾지 못했어요: {name}', { name: ref.table }))
  const x = r.rows[0]
  const split = (v: Cell) => str(v).split(',').map((p) => p.trim()).filter(Boolean)
  return { engine: str(x[0]), engineFull: str(x[1]), primaryKey: split(x[2]), sortingKey: split(x[3]), comment: str(x[4]) }
}

export const clickhouseDriver: DriverModule = {
  dialect: 'clickhouse',
  perDatabase: false,
  defaultDatabase: (c) => c.database || 'default',

  async open(o) {
    const s = new ClickHouseSession(o, o.database || o.config.database || 'default')
    try {
      await s.query('SELECT 1')
    } catch (e) {
      await s.close()
      throw e
    }
    return s
  },

  async version(s) {
    const r = await s.query('SELECT version()')
    return 'ClickHouse ' + str(r.rows[0]?.[0])
  },

  async databases(s, o) {
    const r = await s.query(`SELECT name FROM system.databases${o.showSystem ? '' : ' WHERE ' + SYS_DB} ORDER BY name`)
    return { databases: r.rows.map((x) => str(x[0])), hasSchemas: false, defaultSchema: '' }
  },

  async schemas() {
    return []
  },

  async objects(s, db) {
    const r = await s.query(`SELECT name, engine, comment FROM system.tables WHERE database = ? AND NOT is_temporary ORDER BY name`, [db])
    return r.rows.map((x): DbObject => ({ name: str(x[0]), kind: VIEW_ENGINES.has(str(x[1])) ? 'view' : 'table', comment: str(x[2]) }))
  },

  columns: chColumns,

  async indexes(s, ref) {
    const tr = await tableRow(s, ref)
    const out: IndexInfo[] = []
    if (tr.primaryKey.length) out.push({ name: 'PRIMARY KEY', unique: false, primary: true, columns: tr.primaryKey })
    if (tr.sortingKey.length && tr.sortingKey.join() !== tr.primaryKey.join()) out.push({ name: 'ORDER BY', unique: false, primary: false, columns: tr.sortingKey })
    const r = await s.query(`SELECT name, type, expr FROM system.data_skipping_indices WHERE database = ? AND table = ? ORDER BY name`, [ref.db, ref.table])
    for (const x of r.rows) out.push({ name: str(x[0]), unique: false, primary: false, columns: [`${str(x[2])} (${str(x[1])})`] })
    return out
  },

  async ddl(s, ref) {
    const r = await s.query(`SHOW CREATE TABLE ${q(ref.db)}.${q(ref.table)}`)
    return str(r.rows[0]?.[0]).trim() + ';'
  },

  async foreignKeys() {
    return []
  },

  async completion(s, db) {
    const r = await s.query(`SELECT table, name FROM system.columns WHERE database = ? ORDER BY table, position LIMIT 50000`, [db])
    return groupColumns(r.rows)
  },

  async searchNames(s, db, like) {
    const objs = await s.query(`SELECT name, engine FROM system.tables WHERE database = ? AND name ILIKE ? ORDER BY name LIMIT 1000`, [db, like])
    const cols = await s.query(`SELECT table, name, type FROM system.columns WHERE database = ? AND name ILIKE ? ORDER BY table, position LIMIT 1000`, [db, like])
    return [
      ...objs.rows.map((x) => ({ db, schema: '', kind: (VIEW_ENGINES.has(str(x[1])) ? 'view' : 'table') as 'view' | 'table', table: str(x[0]), name: str(x[0]), extra: '' })),
      ...cols.rows.map((x) => ({ db, schema: '', kind: 'column' as const, table: str(x[0]), name: str(x[1]), extra: str(x[2]) })),
    ]
  },

  users: {
    async list(s) {
      const r = await s.query(`SELECT name, arrayStringConcat(host_ip, ', '), arrayStringConcat(host_names, ', '), auth_type FROM system.users ORDER BY name`)
      return r.rows.map((x) => ({
        name: str(x[0]),
        host: '',
        login: true,
        superuser: false,
        attrs: [str(x[1]) && str(x[1]) !== '::/0' ? 'HOST IP ' + str(x[1]) : '', str(x[2]) ? 'HOST NAME ' + str(x[2]) : ''].filter(Boolean),
      }))
    },
    async grants(s, name) {
      const r = await s.query(`SHOW GRANTS FOR ${q(name)}`)
      return r.rows.map((x) => str(x[0]))
    },
  },

  stats: async (s) => {
    const m = await s.query(`SELECT metric, value FROM system.metrics WHERE metric IN ('TCPConnection', 'HTTPConnection', 'MySQLConnection', 'PostgreSQLConnection', 'InterserverConnection', 'Query')`)
    const e = await s.query(`SELECT event, value FROM system.events WHERE event IN ('Query', 'InsertQuery', 'SelectedRows', 'InsertedRows')`)
    const up = await s.query('SELECT uptime()')
    const metric = Object.fromEntries(m.rows.map((x) => [str(x[0]), Number(x[1])]))
    const event = Object.fromEntries(e.rows.map((x) => [str(x[0]), Number(x[1])]))
    const conns = ['TCPConnection', 'HTTPConnection', 'MySQLConnection', 'PostgreSQLConnection'].reduce((a, k) => a + (metric[k] ?? 0), 0)
    return {
      gauges: { connections: conns, active: Math.max(0, (metric.Query ?? 0) - 1), lockWaits: 0 },
      counters: { queries: event.Query ?? 0, rowsRead: event.SelectedRows ?? 0, rowsWritten: event.InsertedRows ?? 0 },
      info: { uptime: str(up.rows[0]?.[0]) },
    }
  },

  sessions: {
    async list(s) {
      const r = await s.query(
        `SELECT query_id, user, current_database, toString(address), if(client_name != '', client_name, http_user_agent), if(is_cancelled, 'cancelled', 'running'), toUInt64(elapsed), query, query_id = queryID()
         FROM system.processes ORDER BY elapsed DESC`,
      )
      return r.rows.map((x) => ({ id: str(x[0]), user: str(x[1]), db: str(x[2]), host: str(x[3]), app: str(x[4]), state: str(x[5]), seconds: x[6] === null ? null : Number(x[6]), query: str(x[7]), own: bool(x[8]) }))
    },
    async kill(s, id) {
      await s.exec(`KILL QUERY WHERE query_id = ? SYNC`, [id])
    },
  },

  async extras() {
    return []
  },

  async source(_s, _db, _schema, _kind, id) {
    throw new Error(t('개체를 찾지 못했어요: {name}', { name: id }))
  },

  async design(s, ref) {
    const tr = await tableRow(s, ref)
    const cols = await chColumns(s, ref)
    const names = new Set(cols.map((c) => c.name))
    return {
      name: ref.table,
      comment: tr.comment,
      columns: cols.map((c) => {
        const u = chUnwrap(c.type)
        return { name: c.name, type: u.type, nullable: u.nullable, default: c.default ?? '', autoIncrement: false, comment: c.comment, generated: !!c.generated, orig: c.name }
      }),
      // 식으로 된 정렬 키(toDate(ts) 등)는 열 목록에 못 넣는다
      primaryKey: tr.primaryKey.filter((k) => names.has(k)),
      pkName: '',
      indexes: [],
      foreignKeys: [],
      unsupported: [],
      options: engineOf(tr.engineFull) || tr.engine,
    }
  },
}
