// MySQL·MariaDB (mysql2, 순수 JS). 탐색기 단계는 DB → 표·뷰 (MySQL은 DB = 스키마)
import mysql from 'mysql2'
import type { Connection, ConnectionOptions, FieldPacket, ResultSetHeader } from 'mysql2'
import { quoteIdent } from '../../shared/dialect'
import { t } from '../../shared/i18n'
import type { Cell, ColumnInfo, DbObject, ResultColumn, StatementResult } from '../../shared/types'
import { toCell, toParam } from '../values'
import { bool, elapsed, groupColumns, groupDesignFks, groupDesignIndexes, groupForeignKeys, groupIndexes, Session, str, type DriverModule, type OnColumns, type OnRows, type OpenOptions, type Rows } from './base'

const TYPE_NAMES: Record<number, string> = {
  0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 6: 'null', 7: 'timestamp', 8: 'bigint', 9: 'mediumint',
  10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 14: 'date', 15: 'varchar', 16: 'bit', 242: 'vector', 245: 'json', 246: 'decimal',
  247: 'enum', 248: 'set', 249: 'tinyblob', 250: 'mediumblob', 251: 'longblob', 252: 'blob', 253: 'varchar', 254: 'char', 255: 'geometry',
}
const BINARY_CHARSET = 63

function typeName(f: FieldPacket): string {
  const n = f.columnType ?? f.type ?? -1
  const name = TYPE_NAMES[n] ?? String(n)
  // 글자 집합이 binary가 아니면 blob 종류는 text
  if (/blob$/.test(name) && f.characterSet !== BINARY_CHARSET) return name.replace('blob', 'text')
  if ((name === 'varchar' || name === 'char') && f.characterSet === BINARY_CHARSET) return name === 'char' ? 'binary' : 'varbinary'
  return name
}

const columnsOf = (fields: FieldPacket[]): ResultColumn[] => fields.map((f) => ({ name: f.name, type: typeName(f) }))

function optionsOf(o: OpenOptions): ConnectionOptions {
  const c = o.config
  return {
    host: o.endpoint.host,
    port: o.endpoint.port,
    user: c.user,
    password: o.password,
    database: o.database || undefined,
    ssl: c.ssl === 'off' ? undefined : { rejectUnauthorized: c.ssl === 'verify' },
    // 날짜는 DB 글자 그대로, 큰 정수·소수는 정확도를 잃지 않게 글자로
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    // 서버가 이 PC의 파일을 달라고 해도(LOAD DATA LOCAL) 주지 않음
    flags: ['-LOCAL_FILES'],
    charset: 'utf8mb4',
    connectTimeout: 15_000,
    typeCast: (field, next) => {
      if (field.type === 'BIT') {
        const b = field.buffer()
        if (!b) return null
        if (field.length === 1) return b[0]
        return BigInt('0x' + (b.toString('hex') || '0'))
      }
      return next()
    },
  }
}

function connect(o: OpenOptions): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const conn = mysql.createConnection(optionsOf(o))
    conn.connect((err) => (err ? reject(err) : resolve(conn)))
  })
}

type Raw = { res: unknown; fields: FieldPacket[] | FieldPacket[][] | undefined }

export class MysqlSession extends Session {
  readonly dialect = 'mysql' as const

  constructor(private conn: Connection, private opts: OpenOptions) {
    super()
    const die = () => {
      this.dead = true
    }
    conn.on('error', die)
    conn.on('end', die)
  }

  private q(sql: string, params?: Cell[], rowsAsArray = true): Promise<Raw> {
    return new Promise((resolve, reject) => {
      const values = params && params.length ? params.map(toParam) : undefined
      this.conn.query({ sql, values, rowsAsArray }, (err, res, fields) => (err ? reject(err) : resolve({ res, fields: fields as Raw['fields'] })))
    })
  }

  protected async runRaw(sql: string, maxRows: number): Promise<StatementResult[]> {
    const t0 = performance.now()
    // 서버 쪽에서 SELECT 결과 행 수를 제한 (하나 더 받아서 잘렸는지 안다)
    await this.q(`SET SESSION sql_select_limit = ${maxRows + 1}`)
    let raw: Raw
    try {
      raw = await this.q(sql)
    } finally {
      await this.q('SET SESSION sql_select_limit = DEFAULT').catch(() => undefined)
    }
    const ms = elapsed(t0)
    const one = (res: unknown, fields: FieldPacket[] | undefined): StatementResult => {
      if (Array.isArray(res) && fields) {
        const rows = (res as unknown[][]).slice(0, maxRows).map((r) => r.map((v) => toCell(v)))
        return { sql, columns: columnsOf(fields), rows, truncated: res.length > maxRows, affected: null, ms }
      }
      const h = res as ResultSetHeader
      return { sql, columns: null, rows: [], truncated: false, affected: typeof h?.affectedRows === 'number' ? h.affectedRows : null, ms }
    }
    const { res, fields } = raw
    // 프로시저(CALL)는 결과 표가 여러 개: res = [표1, 표2, …, 헤더], fields = [열1, 열2, …]
    if (Array.isArray(fields) && fields.length > 0 && Array.isArray(fields[0])) {
      return (res as unknown[]).map((r, i) => one(r, (fields as FieldPacket[][])[i]))
    }
    return [one(res, fields as FieldPacket[] | undefined)]
  }

  protected async queryRaw(sql: string, params: Cell[], binLimit: number): Promise<Rows> {
    const { res, fields } = await this.q(sql, params)
    if (!Array.isArray(res) || !fields) return { columns: [], rows: [] }
    return { columns: columnsOf(fields as FieldPacket[]), rows: (res as unknown[][]).map((r) => r.map((v) => toCell(v, binLimit))) }
  }

  protected async execRaw(sql: string, params: Cell[]): Promise<number | null> {
    const { res } = await this.q(sql, params)
    const h = res as ResultSetHeader
    return typeof h?.affectedRows === 'number' ? h.affectedRows : null
  }

  protected streamRaw(sql: string, onColumns: OnColumns, onRows: OnRows): Promise<number> {
    return new Promise((resolve, reject) => {
      let buf: Cell[][] = []
      let total = 0
      let waiting: Promise<void> | null = null
      const flush = () => {
        if (!buf.length) return
        const rows = buf
        buf = []
        const r = onRows(rows)
        if (r) {
          // 파일 쓰기가 끝날 때까지 서버에서 그만 받기
          this.conn.pause()
          waiting = r.then(() => {
            waiting = null
            this.conn.resume()
          })
        }
      }
      const query = this.conn.query({ sql, rowsAsArray: true })
      query.on('fields', (fields: FieldPacket[]) => onColumns(columnsOf(fields)))
      query.on('result', (row: unknown) => {
        if (!Array.isArray(row)) return
        buf.push(row.map((v) => toCell(v, Infinity)))
        total++
        if (buf.length >= 1000) flush()
      })
      query.on('error', reject)
      query.on('end', () => {
        flush()
        Promise.resolve(waiting).then(() => resolve(total), reject)
      })
    })
  }

  /** 다른 연결을 잠깐 열어 KILL QUERY */
  async cancel(): Promise<void> {
    const id = this.conn.threadId
    if (!id) return
    const other = await connect(this.opts)
    try {
      await new Promise<void>((resolve, reject) => other.query(`KILL QUERY ${Number(id)}`, (err) => (err ? reject(err) : resolve())))
    } finally {
      other.destroy()
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.conn.end(() => resolve()))
    this.conn.destroy()
  }

  async useDatabase(db: string): Promise<boolean> {
    if (db) await this.lock(() => this.q(`USE ${quoteIdent('mysql', db)}`))
    return true
  }

  async setSchema(): Promise<void> {}
}

const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

export const mysqlDriver: DriverModule = {
  dialect: 'mysql',
  perDatabase: false,
  defaultDatabase: (c) => c.database,

  async open(o) {
    return new MysqlSession(await connect(o), o)
  },

  async version(s) {
    const r = await s.query('SELECT VERSION()')
    const v = str(r.rows[0]?.[0])
    return (/mariadb/i.test(v) ? 'MariaDB ' : 'MySQL ') + v.replace(/-MariaDB.*$/i, '')
  },

  async databases(s, o) {
    const r = await s.query('SHOW DATABASES')
    return { databases: r.rows.map((x) => str(x[0])).filter((n) => o.showSystem || !SYSTEM_DBS.has(n.toLowerCase())), hasSchemas: false, defaultSchema: '' }
  },

  async schemas() {
    return []
  },

  async objects(s, db) {
    const r = await s.query('SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [db])
    return r.rows.map((x): DbObject => ({ name: str(x[0]), kind: /VIEW/i.test(str(x[1])) ? 'view' : 'table', comment: /VIEW/i.test(str(x[1])) ? '' : str(x[2]) }))
  },

  async columns(s, ref) {
    const r = await s.query(
      'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [ref.db, ref.table],
    )
    return r.rows.map((x): ColumnInfo => ({
      name: str(x[0]),
      type: str(x[1]),
      nullable: bool(x[2]),
      default: x[3] === null ? null : str(x[3]),
      pk: str(x[4]) === 'PRI',
      autoIncrement: /auto_increment/i.test(str(x[5])),
      comment: str(x[6]),
      generated: /\b(VIRTUAL|STORED) GENERATED\b/i.test(str(x[5])),
    }))
  },

  async indexes(s, ref) {
    const r = await s.query(
      "SELECT INDEX_NAME, NON_UNIQUE = 0, INDEX_NAME = 'PRIMARY', COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
      [ref.db, ref.table],
    )
    return groupIndexes(r.rows.map((x) => [x[0], x[1], x[2], x[3] === null ? t('(식)') : x[3]]))
  },

  async ddl(s, ref, kind) {
    const name = `${quoteIdent('mysql', ref.db)}.${quoteIdent('mysql', ref.table)}`
    const r = await s.query(kind === 'view' ? `SHOW CREATE VIEW ${name}` : `SHOW CREATE TABLE ${name}`)
    return str(r.rows[0]?.[1]) + ';'
  },

  async foreignKeys(s, ref) {
    const r = await s.query(
      `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [ref.db, ref.table],
    )
    return groupForeignKeys(r.rows, (db, table) => ({ db, schema: '', table }))
  },

  async completion(s, db) {
    const r = await s.query('SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 50000', [db])
    return groupColumns(r.rows)
  },

  sessions: {
    async list(s) {
      const own = Number((await s.query('SELECT CONNECTION_ID()')).rows[0]?.[0])
      const r = await s.query('SELECT ID, USER, DB, HOST, COMMAND, TIME, STATE, INFO FROM information_schema.PROCESSLIST ORDER BY ID')
      return r.rows.map((x) => ({
        id: str(x[0]),
        user: str(x[1]),
        db: str(x[2]),
        host: str(x[3]),
        app: '',
        state: [str(x[4]), str(x[6])].filter(Boolean).join(' · '),
        seconds: x[5] === null ? null : Number(x[5]),
        query: str(x[7]),
        own: Number(x[0]) === own,
      }))
    },
    async kill(s, id, queryOnly) {
      if (!/^\d+$/.test(id)) throw new Error(t('잘못된 요청'))
      await s.exec(`KILL ${queryOnly ? 'QUERY ' : ''}${id}`)
    },
  },

  async extras(s, db) {
    const routines = await s.query('SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME', [db])
    const triggers = await s.query('SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME', [db])
    const events = await s.query('SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME', [db]).catch(() => ({ rows: [] as Cell[][] }))
    return [
      ...routines.rows.map((x) => ({ kind: str(x[1]).toUpperCase() === 'PROCEDURE' ? 'procedure' as const : 'function' as const, name: str(x[0]), id: str(x[0]), table: '', args: '' })),
      ...triggers.rows.map((x) => ({ kind: 'trigger' as const, name: str(x[0]), id: str(x[0]), table: str(x[1]), args: '' })),
      ...events.rows.map((x) => ({ kind: 'event' as const, name: str(x[0]), id: str(x[0]), table: '', args: '' })),
    ]
  },

  async source(s, db, _schema, kind, id) {
    if (kind === 'sequence') throw new Error(t('개체를 찾지 못했어요: {name}', { name: id }))
    const word = { procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', event: 'EVENT' }[kind]
    const r = await s.query(`SHOW CREATE ${word} ${quoteIdent('mysql', db)}.${quoteIdent('mysql', id)}`)
    // 원본 칸: 프로시저·함수·트리거는 세 번째, 이벤트는 네 번째. 권한이 없으면 NULL
    const text = r.rows[0]?.[kind === 'event' ? 3 : 2]
    if (text === null || text === undefined) throw new Error(t('원본을 볼 수 없어요 (권한이 없거나 암호화된 개체예요)'))
    return str(text).trim() + ';'
  },

  async design(s, ref) {
    const maria = /mariadb/i.test(str((await s.query('SELECT VERSION()')).rows[0]?.[0]))
    const tb = await s.query('SELECT TABLE_COMMENT, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [ref.db, ref.table])
    if (!tb.rows.length) throw new Error(t('표를 찾지 못했어요: {name}', { name: ref.table }))
    const tableCollation = str(tb.rows[0][1])
    const cols = await s.query(
      'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, DATA_TYPE, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [ref.db, ref.table],
    )
    const stats = await s.query(
      'SELECT INDEX_NAME, NON_UNIQUE = 0, COLUMN_NAME, 0 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      [ref.db, ref.table],
    )
    const fks = await s.query(
      `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
       FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
       WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [ref.db, ref.table],
    )
    return {
      name: ref.table,
      comment: str(tb.rows[0][0]),
      columns: cols.rows.map((x) => {
        const extra = str(x[4])
        const collation = str(x[7])
        const onUpdate = /\bon update ([\w()]+)/i.exec(extra)?.[1]
        return {
          name: str(x[0]),
          type: str(x[1]),
          nullable: bool(x[2]),
          default: mysqlDefault(x[3], extra, str(x[6]), maria),
          autoIncrement: /auto_increment/i.test(extra),
          comment: str(x[5]),
          generated: /\b(VIRTUAL|STORED) GENERATED\b/i.test(extra),
          orig: str(x[0]),
          ...(collation && collation !== tableCollation ? { collation } : {}),
          ...(onUpdate ? { onUpdate } : {}),
        }
      }),
      primaryKey: stats.rows.filter((x) => str(x[0]) === 'PRIMARY').map((x) => str(x[2])),
      pkName: '',
      indexes: groupDesignIndexes(stats.rows.filter((x) => str(x[0]) !== 'PRIMARY'), t('(식)')),
      foreignKeys: groupDesignFks(fks.rows),
      unsupported: [],
    }
  },
}

const NUMERIC_TYPES = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|bool|boolean|year)$/i

/** information_schema의 기본값 → SQL 식. MariaDB는 이미 SQL 식('글자', current_timestamp()), MySQL은 글자 그대로라 따옴표를 붙인다 */
export function mysqlDefault(def: Cell, extra: string, dataType: string, maria: boolean): string {
  if (def === null || typeof def === 'object') return ''
  const v = String(def)
  if (maria) return v === 'NULL' ? '' : v
  if (/^CURRENT_TIMESTAMP(\(\d*\))?$/i.test(v) && /time|date/i.test(dataType)) return v
  if (/DEFAULT_GENERATED/i.test(extra)) return `(${v})`
  if (NUMERIC_TYPES.test(dataType)) return v
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}
