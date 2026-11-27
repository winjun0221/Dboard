// SQLite: 파일 하나가 DB. 탐색기 단계는 DB(main·붙인 DB) → 표·뷰 (스키마 단계 없음)
import { Worker } from 'node:worker_threads'
import { quoteIdent } from '../../shared/dialect'
import { getLang, t } from '../../shared/i18n'
import { mask } from '../../shared/sql'
import type { Cell, ColumnInfo, DbObject, StatementResult, TableDesign } from '../../shared/types'
import { bool, fkAction, groupColumns, groupForeignKeys, Session, str, type DriverModule, type OnColumns, type OnRows, type Rows } from './base'
import { dispatch, SqliteEngine, type EngineOpenOptions } from './sqlite-engine'

/** 앱에서는 작업 스레드 코드(dist/main/sqlite-worker.cjs 내용)를 넣어 준다. null이면 같은 스레드에서 실행(테스트) */
let workerCode: string | null = null
export function setSqliteWorkerCode(code: string | null) {
  workerCode = code
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class SqliteSession extends Session {
  readonly dialect = 'sqlite' as const
  private engine: SqliteEngine | null = null
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private seq = 0

  constructor(private opts: EngineOpenOptions) {
    super()
  }

  async init(): Promise<void> {
    if (workerCode) await this.startWorker()
    else this.engine = new SqliteEngine(this.opts)
    // 처음 한 번만 파일을 만들고, 다시 열 때(취소 뒤)는 있는 파일만
    this.opts = { ...this.opts, create: false }
  }

  private failAll(e: Error) {
    const list = [...this.pending.values()]
    this.pending.clear()
    for (const p of list) p.reject(e)
  }

  private async startWorker(): Promise<void> {
    const w = new Worker(workerCode!, { eval: true, workerData: { lang: getLang() } })
    w.on('message', (m: { id: number; ok: boolean; data?: unknown; error?: string }) => {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.ok) p.resolve(m.data)
      else p.reject(new Error(m.error))
    })
    w.on('error', (e) => this.failAll(e instanceof Error ? e : new Error(String(e))))
    w.on('exit', () => {
      if (this.worker !== w) return
      this.worker = null
      this.dead = true
      this.failAll(new Error(t('SQLite 작업 스레드가 끝났어요')))
    })
    this.worker = w
    await this.call('open', [this.opts])
  }

  private call<T>(op: string, args: unknown[]): Promise<T> {
    if (this.engine) {
      const engine = this.engine
      return Promise.resolve().then(() => dispatch(engine, op, args) as T)
    }
    const w = this.worker
    if (!w) return Promise.reject(new Error(t('연결이 끊겼어요')))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      w.postMessage({ id, op, args })
    })
  }

  protected async runRaw(sql: string, maxRows: number): Promise<StatementResult[]> {
    return [await this.call<StatementResult>('run', [sql, maxRows])]
  }

  protected queryRaw(sql: string, params: Cell[], binLimit: number): Promise<Rows> {
    return this.call<Rows>('query', [sql, params, binLimit])
  }

  protected execRaw(sql: string, params: Cell[]): Promise<number | null> {
    return this.call<number>('exec', [sql, params])
  }

  protected async streamRaw(sql: string, onColumns: OnColumns, onRows: OnRows): Promise<number> {
    const { id, columns } = await this.call<{ id: number; columns: Rows['columns'] }>('openCursor', [sql])
    onColumns(columns)
    let total = 0
    try {
      for (;;) {
        const { rows, done } = await this.call<{ rows: Cell[][]; done: boolean }>('next', [id, 1000])
        total += rows.length
        if (rows.length) await onRows(rows)
        if (done) return total
      }
    } catch (e) {
      await this.call('closeCursor', [id]).catch(() => undefined)
      throw e
    }
  }

  /** 작업 스레드를 끝내고 새로 연다 (진행 중이던 트랜잭션은 되돌려진다) */
  async cancel(): Promise<void> {
    const w = this.worker
    if (!w) return
    this.worker = null
    this.failAll(new Error(t('취소했어요')))
    await w.terminate()
    await this.startWorker()
  }

  async close(): Promise<void> {
    if (this.engine) {
      this.engine.close()
      this.engine = null
      return
    }
    const w = this.worker
    if (!w) return
    await this.call('close', []).catch(() => undefined)
    this.worker = null
    await w.terminate()
  }

  async useDatabase(): Promise<boolean> {
    return true
  }

  async setSchema(): Promise<void> {}
}

const q = (n: string) => quoteIdent('sqlite', n)

export const sqliteDriver: DriverModule = {
  dialect: 'sqlite',
  perDatabase: false,
  defaultDatabase: () => 'main',

  async open(o) {
    const s = new SqliteSession({ file: o.config.file, create: false })
    await s.init()
    return s
  },

  async version(s) {
    const r = await s.query('SELECT sqlite_version()')
    return 'SQLite ' + str(r.rows[0]?.[0])
  },

  async databases(s, o) {
    const r = await s.query('PRAGMA database_list')
    const names = r.rows.map((row) => str(row[1])).filter((n) => o.showSystem || n !== 'temp')
    return { databases: names, hasSchemas: false, defaultSchema: '' }
  },

  async schemas() {
    return []
  },

  async objects(s, db, _schema, o) {
    const sys = o.showSystem ? '' : ` AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`
    const r = await s.query(`SELECT name, type FROM ${q(db)}.sqlite_master WHERE type IN ('table', 'view')${sys} ORDER BY name`)
    return r.rows.map((row): DbObject => ({ name: str(row[0]), kind: str(row[1]) === 'view' ? 'view' : 'table', comment: '' }))
  },

  async columns(s, ref) {
    const r = await s.query('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid', [ref.table, ref.db])
    const pkCount = r.rows.filter((row) => Number(row[4]) > 0).length
    return r.rows
      .filter((row) => Number(row[5]) === 0 || Number(row[5]) >= 2) // 1 = 가상 표의 숨은 열
      .map((row): ColumnInfo => {
        const type = str(row[1])
        const pk = Number(row[4]) > 0
        return {
          name: str(row[0]),
          type,
          nullable: !bool(row[2]) && !pk,
          default: row[3] === null ? null : str(row[3]),
          pk,
          // INTEGER PRIMARY KEY 하나면 rowid 별칭 = 자동 번호
          autoIncrement: pk && pkCount === 1 && type.toUpperCase() === 'INTEGER',
          comment: '',
          // 2 = VIRTUAL, 3 = STORED 계산 열
          generated: Number(row[5]) >= 2,
        }
      })
  },

  async indexes(s, ref) {
    const list = await s.query('SELECT name, "unique", origin FROM pragma_index_list(?, ?)', [ref.table, ref.db])
    const out = []
    for (const row of list.rows) {
      const name = str(row[0])
      const cols = await s.query('SELECT name FROM pragma_index_info(?, ?) ORDER BY seqno', [name, ref.db])
      out.push({ name, unique: bool(row[1]), primary: str(row[2]) === 'pk', columns: cols.rows.map((c) => str(c[0]) || t('(식)')) })
    }
    // INTEGER PRIMARY KEY(rowid 별칭)는 인덱스 목록에 안 나와서 기본 키 열로 채운다
    if (!out.some((i) => i.primary)) {
      const pk = await s.query('SELECT name FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk', [ref.table, ref.db])
      if (pk.rows.length) out.push({ name: 'PRIMARY KEY', unique: true, primary: true, columns: pk.rows.map((c) => str(c[0])) })
    }
    return out.sort((a, b) => Number(b.primary) - Number(a.primary) || (a.name < b.name ? -1 : 1))
  },

  async ddl(s, ref) {
    const r = await s.query(
      `SELECT sql FROM ${q(ref.db)}.sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
      [ref.table],
    )
    return r.rows.map((row) => str(row[0]).trim() + ';').join('\n\n')
  },

  async foreignKeys(s, ref) {
    const r = await s.query('SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq', [ref.table, ref.db])
    const rows: Cell[][] = []
    for (const x of r.rows) {
      let to = str(x[4])
      // REFERENCES 부모 (열 없이) = 부모의 기본 키
      if (!to) {
        const pk = await s.query('SELECT name FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk', [str(x[2]), ref.db])
        to = str(pk.rows[Number(x[1])]?.[0])
      }
      rows.push([`fk_${str(x[0])}`, x[3], '', x[2], to])
    }
    return groupForeignKeys(rows, (_s, table) => ({ db: ref.db, schema: '', table }))
  },

  async completion(s, db) {
    const r = await s.query(
      `SELECT m.name, p.name FROM ${q(db)}.sqlite_master m JOIN pragma_table_info(m.name, ?) p WHERE m.type IN ('table', 'view') ORDER BY m.name, p.cid`,
      [db],
    )
    return groupColumns(r.rows)
  },

  sessions: null,

  async extras(s, db) {
    const r = await s.query(`SELECT name, tbl_name FROM ${q(db)}.sqlite_master WHERE type = 'trigger' ORDER BY name`)
    return r.rows.map((x) => ({ kind: 'trigger' as const, name: str(x[0]), id: str(x[0]), table: str(x[1]), args: '' }))
  },

  async source(s, db, _schema, kind, id) {
    const r = await s.query(`SELECT sql FROM ${q(db)}.sqlite_master WHERE type = ? AND name = ?`, [kind, id])
    if (!r.rows.length) throw new Error(t('개체를 찾지 못했어요: {name}', { name: id }))
    return str(r.rows[0][0]).trim() + ';'
  },

  async design(s, ref) {
    const master = await s.query(`SELECT type, name, sql FROM ${q(ref.db)}.sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL`, [ref.table])
    const create = str(master.rows.find((r) => str(r[0]) === 'table')?.[2])
    if (!create) throw new Error(t('표를 찾지 못했어요: {name}', { name: ref.table }))
    const masked = mask(create, 'sqlite')
    const unsupported: string[] = []
    if (/\bCHECK\s*\(/i.test(masked)) unsupported.push('CHECK')
    if (/\bCOLLATE\b/i.test(masked)) unsupported.push('COLLATE')
    if (/\bGENERATED\b|\bAS\s*\(/i.test(masked)) unsupported.push(t('계산 열'))
    if (/\bON\s+CONFLICT\b/i.test(masked)) unsupported.push('ON CONFLICT')
    if (/\bDEFERRABLE\b/i.test(masked)) unsupported.push('DEFERRABLE')
    const close = masked.lastIndexOf(')')
    const options = close >= 0 ? create.slice(close + 1).replace(/;\s*$/, '').trimEnd() : ''
    const cols = await sqliteDriver.columns(s, ref)
    const pk = await s.query('SELECT name FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk', [ref.table, ref.db])
    const primaryKey = pk.rows.map((r) => str(r[0]))
    const autoinc = /\bAUTOINCREMENT\b/i.test(masked)
    const list = await s.query('SELECT name, "unique", origin FROM pragma_index_list(?, ?)', [ref.table, ref.db])
    const indexes = []
    for (const row of list.rows) {
      const name = str(row[0])
      if (str(row[2]) === 'pk') continue
      const ic = await s.query('SELECT name FROM pragma_index_info(?, ?) ORDER BY seqno', [name, ref.db])
      const sql = str(master.rows.find((r) => str(r[0]) === 'index' && str(r[1]) === name)?.[2])
      indexes.push({ name, columns: ic.rows.map((c) => str(c[0]) || t('(식)')), unique: bool(row[1]), orig: name, constraint: str(row[2]) === 'u' || undefined, sql: sql || undefined })
    }
    const fkRows = await s.query('SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq', [ref.table, ref.db])
    const fks = new Map<string, TableDesign['foreignKeys'][number]>()
    for (const x of fkRows.rows) {
      const id = str(x[0])
      let to = str(x[4])
      if (!to) {
        const rp = await s.query('SELECT name FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk', [str(x[2]), ref.db])
        to = str(rp.rows[Number(x[1])]?.[0])
      }
      const fk = fks.get(id) ?? { name: '', columns: [], refSchema: '', refTable: str(x[2]), refColumns: [], onDelete: fkAction(str(x[6])), onUpdate: fkAction(str(x[5])), orig: '' }
      fk.columns.push(str(x[3]))
      fk.refColumns.push(to)
      fks.set(id, fk)
    }
    // SQLite 외래 키는 이름이 없어서 차례 번호로 구별한다 (SQL에는 이름을 쓰지 않음)
    const foreignKeys = [...fks.values()].map((f, i) => ({ ...f, name: `#${i + 1}`, orig: `#${i + 1}` }))
    return {
      name: ref.table,
      comment: '',
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        default: c.default ?? '',
        autoIncrement: autoinc && c.autoIncrement,
        comment: '',
        generated: !!c.generated,
        orig: c.name,
      })),
      primaryKey,
      pkName: '',
      indexes,
      foreignKeys,
      unsupported,
      options,
      triggers: master.rows.filter((r) => str(r[0]) === 'trigger').map((r) => str(r[2])),
    }
  },
}
