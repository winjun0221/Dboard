// 드라이버 공통 틀: DB 연결 하나(Session)와 DB 종류별 모듈(DriverModule — 연결 열기 + 시스템 표 읽기)
// 새 DB 종류를 붙이려면 이 두 가지를 구현하고 drivers/index.ts에 등록한다.
import { beginSql } from '../../shared/dialect'
import { buildInsertMany } from '../../shared/edit'
import { features } from '../../shared/features'
import { t } from '../../shared/i18n'
import { firstKeyword, mask } from '../../shared/sql'
import type {
  DbUser,
  Cell, ColumnInfo, ConnectionConfig, DatabaseList, DbObject, DesignForeignKey, DesignIndex, Dialect, ExtraKind, ExtraObject, FkAction, SearchHit, ServerSession, ServerStats, ForeignKeyInfo, IndexInfo, ObjectKind, ResultColumn, StatementResult, TableDesign, TableRef,
} from '../../shared/types'

/** 사용자가 직접 쓴 트랜잭션 문장 (수동 커밋에서 감싸지 않고 그대로) */
const TX_WORDS = new Set(['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'END', 'ABORT', 'SAVEPOINT', 'RELEASE'])

export interface Endpoint {
  host: string
  port: number
}

export interface OpenOptions {
  config: ConnectionConfig
  /** SSH 터널을 쓰면 127.0.0.1:터널 포트 */
  endpoint: Endpoint
  password: string
  /** '' = 기본 DB */
  database: string
}

export interface Rows {
  columns: ResultColumn[]
  rows: Cell[][]
}

export type OnColumns = (columns: ResultColumn[]) => void
/** 행 묶음. Promise를 돌려주면 끝날 때까지 다음 묶음을 기다린다(파일 쓰기 속도에 맞춤) */
export type OnRows = (rows: Cell[][]) => void | Promise<void>

export interface Tx {
  exec(sql: string, params?: Cell[]): Promise<number | null>
  query(sql: string, params?: Cell[]): Promise<Rows>
  /** 여러 행 넣기 (가져오기·데이터 옮기기). 넣은 행 수 */
  insertMany(ref: TableRef, columns: string[], rows: Cell[][]): Promise<number>
}

/** DB 연결 하나. 한 번에 한 작업만(차례대로) — SQL Server 드라이버는 동시에 두 요청을 못 보낸다 */
export abstract class Session {
  abstract readonly dialect: Dialect
  /** 연결이 끊겼으면 true (다음에 새로 연다) */
  dead = false
  private chain: Promise<unknown> = Promise.resolve()
  /** 수동 커밋 (편집기 연결만). MySQL autocommit=0, SQL Server IMPLICIT_TRANSACTIONS, PostgreSQL·SQLite는 우리가 BEGIN */
  private manual = false
  /** PostgreSQL·SQLite·DuckDB: 우리가 연 트랜잭션이 열려 있는지 */
  private txOpen = false
  /** transaction() 안 (Oracle 드라이버가 문장마다 자동 커밋하지 않게) */
  protected inTransaction = false

  protected lock<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.chain.then(fn, fn)
    this.chain = r.catch(() => undefined)
    return r
  }

  /** 문장 하나(SQL Server는 배치 하나) 실행. 결과 표는 maxRows까지 */
  protected abstract runRaw(sql: string, maxRows: number): Promise<StatementResult[]>
  /** binLimit: 바이너리를 앞 몇 바이트까지 (화면 표는 64, 값 보기는 전부) */
  protected abstract queryRaw(sql: string, params: Cell[], binLimit: number): Promise<Rows>
  /** 바뀐 행 수 */
  protected abstract execRaw(sql: string, params: Cell[]): Promise<number | null>
  protected abstract streamRaw(sql: string, onColumns: OnColumns, onRows: OnRows): Promise<number>
  /** 여러 행 INSERT. 기본은 여러 행 VALUES 문장들 (Oracle은 executeMany로 바꿔 쓴다) */
  protected async insertManyRaw(ref: TableRef, columns: string[], rows: Cell[][]): Promise<number> {
    let n = 0
    for (const b of buildInsertMany(this.dialect, ref, columns, rows)) {
      await this.execRaw(b.sql, b.params)
      n += b.rows ?? 0
    }
    return n
  }
  /** 실행 중인 문장 취소 (차례를 기다리지 않음) */
  abstract cancel(): Promise<void>
  abstract close(): Promise<void>
  /** 기본 DB 바꾸기. 못 하면 false (PostgreSQL — 새로 연결해야 함) */
  abstract useDatabase(db: string): Promise<boolean>
  /** 기본 스키마 (PostgreSQL search_path). 나머지는 아무것도 안 함 */
  abstract setSchema(schema: string): Promise<void>

  run(sql: string, maxRows: number) {
    return this.lock(() => this.runRaw(sql, maxRows))
  }

  get manualCommit() {
    return this.manual
  }

  /** 수동 커밋 켜고 끄기. 끌 때 남은 트랜잭션은 되돌린다 (화면이 먼저 커밋·롤백을 묻는다) */
  async setManualCommit(on: boolean) {
    if (on === this.manual) return
    if (on && !features(this.dialect).transactions) throw new Error(t('이 DB는 트랜잭션이 없어서 수동 커밋을 쓸 수 없어요'))
    await this.lock(async () => {
      if (this.dialect === 'oracle') {
        // Oracle은 트랜잭션이 저절로 열린다: 드라이버가 수동이면 자동 커밋을 끈다
        if (!on) await this.execRaw('ROLLBACK', [])
      } else if (this.dialect === 'mysql') {
        if (!on) await this.execRaw('ROLLBACK', [])
        await this.execRaw(`SET autocommit = ${on ? 0 : 1}`, [])
      } else if (this.dialect === 'mssql') {
        if (!on) await this.execRaw('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION', [])
        await this.execRaw(`SET IMPLICIT_TRANSACTIONS ${on ? 'ON' : 'OFF'}`, [])
      } else if (!on && this.txOpen) {
        await this.execRaw('ROLLBACK', [])
        this.txOpen = false
      }
      this.manual = on
    })
  }

  /** 편집기 실행. 수동 커밋이면 PostgreSQL·SQLite·DuckDB는 트랜잭션을 열고,
   *  PostgreSQL은 문장마다 SAVEPOINT로 감싸 오류가 나도 앞의 작업이 살아 있게 한다 (오류 = 트랜잭션 전체 중단을 막음) */
  runManaged(sql: string, maxRows: number) {
    if (!this.manual || (this.dialect !== 'postgres' && this.dialect !== 'sqlite' && this.dialect !== 'duckdb')) return this.run(sql, maxRows)
    return this.lock(async () => {
      const kw = firstKeyword(sql, this.dialect)
      if (TX_WORDS.has(kw)) {
        const r = await this.runRaw(sql, maxRows)
        if (kw === 'BEGIN' || kw === 'START') this.txOpen = true
        else if ((kw === 'COMMIT' || kw === 'END' || kw === 'ABORT' || kw === 'ROLLBACK') && !/\bTO\b/i.test(mask(sql, this.dialect))) this.txOpen = false
        return r
      }
      if (!this.txOpen) {
        await this.execRaw('BEGIN', [])
        this.txOpen = true
      }
      if (this.dialect !== 'postgres') return this.runRaw(sql, maxRows)
      await this.execRaw('SAVEPOINT dboard_sp', [])
      try {
        const r = await this.runRaw(sql, maxRows)
        await this.execRaw('RELEASE SAVEPOINT dboard_sp', [])
        return r
      } catch (e) {
        await this.execRaw('ROLLBACK TO SAVEPOINT dboard_sp', []).catch(() => undefined)
        await this.execRaw('RELEASE SAVEPOINT dboard_sp', []).catch(() => undefined)
        throw e
      }
    })
  }

  /** 수동 커밋의 트랜잭션 확정(commit) 또는 되돌리기 */
  endTransaction(commit: boolean) {
    return this.lock(async () => {
      const word = commit ? 'COMMIT' : 'ROLLBACK'
      if (this.dialect === 'mssql') await this.execRaw(`IF @@TRANCOUNT > 0 ${word} TRANSACTION`, [])
      else if (this.dialect === 'mysql' || this.dialect === 'oracle') await this.execRaw(word, [])
      else if (this.dialect === 'clickhouse') return
      else if (this.txOpen) {
        await this.execRaw(word, [])
        this.txOpen = false
      }
    })
  }

  /** 읽기 전용 접속: 서버 쪽에서도 막는다 (SQL Server·Oracle은 세션 설정이 없어 메인의 문장 검사만, ClickHouse·DuckDB는 드라이버가 따로) */
  async applyReadOnly() {
    const sql: Partial<Record<Dialect, string>> = { mysql: 'SET SESSION TRANSACTION READ ONLY', postgres: 'SET default_transaction_read_only = on', sqlite: 'PRAGMA query_only = ON' }
    const s = sql[this.dialect]
    if (s) await this.exec(s)
  }

  query(sql: string, params: Cell[] = [], binLimit = 64) {
    return this.lock(() => this.queryRaw(sql, params, binLimit))
  }

  exec(sql: string, params: Cell[] = []) {
    return this.lock(() => this.execRaw(sql, params))
  }

  stream(sql: string, onColumns: OnColumns, onRows: OnRows) {
    return this.lock(() => this.streamRaw(sql, onColumns, onRows))
  }

  /** 여러 문장을 한 트랜잭션으로. 실패하면 되돌린다 (ClickHouse는 트랜잭션이 없어 그냥 차례로) */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.lock(async () => {
      const tx: Tx = {
        exec: (s, p) => this.execRaw(s, p ?? []),
        query: (s, p) => this.queryRaw(s, p ?? [], 64),
        insertMany: (ref, cols, rows) => this.insertManyRaw(ref, cols, rows),
      }
      if (!features(this.dialect).transactions) return fn(tx)
      const begin = beginSql(this.dialect)
      if (begin) await this.execRaw(begin, [])
      this.inTransaction = true
      try {
        const r = await fn(tx)
        await this.execRaw('COMMIT', [])
        return r
      } catch (e) {
        try {
          await this.execRaw('ROLLBACK', [])
        } catch {
          // 연결이 끊긴 경우 등 — 원래 오류를 알려 준다
        }
        throw e
      } finally {
        this.inTransaction = false
      }
    })
  }
}

export interface MetaOptions {
  showSystem: boolean
}

export interface DriverModule {
  dialect: Dialect
  /** PostgreSQL: DB마다 연결을 따로 열어야 함 */
  perDatabase: boolean
  /** 연결의 기본 DB 이름 (탐색기·편집기 처음 값) */
  defaultDatabase(config: ConnectionConfig): string
  open(o: OpenOptions): Promise<Session>
  version(s: Session): Promise<string>
  databases(s: Session, o: MetaOptions): Promise<DatabaseList>
  schemas(s: Session, db: string, o: MetaOptions): Promise<string[]>
  objects(s: Session, db: string, schema: string, o: MetaOptions): Promise<DbObject[]>
  columns(s: Session, ref: TableRef): Promise<ColumnInfo[]>
  indexes(s: Session, ref: TableRef): Promise<IndexInfo[]>
  ddl(s: Session, ref: TableRef, kind: ObjectKind): Promise<string>
  foreignKeys(s: Session, ref: TableRef): Promise<ForeignKeyInfo[]>
  completion(s: Session, db: string, schema: string): Promise<Record<string, string[]>>
  /** 이름 찾기 (DB 하나 안에서). like = '%글%' (\\로 % _ 가림) */
  searchNames(s: Session, db: string, like: string, o: MetaOptions): Promise<SearchHit[]>
  /** 사용자·권한 (SQLite는 null) */
  users: null | {
    list(s: Session): Promise<DbUser[]>
    grants(s: Session, name: string, host: string, db: string): Promise<string[]>
  }
  /** 서버 상태 (SQLite는 null) */
  stats: null | ((s: Session) => Promise<Omit<ServerStats, 'at'>>)
  /** 세션 관리자 (SQLite는 없음: null) */
  sessions: null | {
    list(s: Session): Promise<ServerSession[]>
    /** queryOnly: 실행 중인 쿼리만 취소 (SQL Server는 못 함) */
    kill(s: Session, id: string, queryOnly: boolean): Promise<void>
  }
  /** 표·뷰 말고 다른 개체 (프로시저·함수·트리거·시퀀스·이벤트) */
  extras(s: Session, db: string, schema: string): Promise<ExtraObject[]>
  /** 개체 원본 (CREATE 문). id는 extras가 준 값 */
  source(s: Session, db: string, schema: string, kind: ExtraKind, id: string): Promise<string>
  /** 표 설계 화면: 열(기본값은 SQL 식)·기본 키·인덱스(기본 키 말고)·외래 키(ON DELETE·UPDATE) */
  design(s: Session, ref: TableRef): Promise<TableDesign>
}

/** 시스템 표의 참조 동작 글자(NO_ACTION, SET NULL, c 등) → FkAction */
export function fkAction(v: string): FkAction {
  const u = v.trim().toUpperCase().replace(/_/g, ' ')
  const code: Record<string, FkAction> = { A: 'NO ACTION', R: 'RESTRICT', C: 'CASCADE', N: 'SET NULL', D: 'SET DEFAULT' }
  if (code[u]) return code[u]
  return (['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'] as const).find((a) => a === u) ?? 'NO ACTION'
}

/** 행 하나의 n번째 칸을 글자로 (시스템 표 읽을 때) */
export const str = (v: Cell | undefined): string => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v))
export const bool = (v: Cell | undefined): boolean => v === true || v === 1 || v === '1' || v === 'YES' || v === 't' || v === 'true'

/** 표 이름 → 열 이름들 (행: [표, 열]) */
export function groupColumns(rows: Cell[][]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const r of rows) (out[str(r[0])] ??= []).push(str(r[1]))
  return out
}

/** 외래 키 행들([이름, 열, 참조 스키마(MySQL은 DB), 참조 표, 참조 열]) → ForeignKeyInfo[] */
export function groupForeignKeys(rows: Cell[][], target: (schemaOrDb: string, table: string) => TableRef): ForeignKeyInfo[] {
  const map = new Map<string, ForeignKeyInfo>()
  for (const r of rows) {
    const name = str(r[0])
    let fk = map.get(name)
    if (!fk) {
      fk = { name, columns: [], ref: target(str(r[2]), str(r[3])), refColumns: [] }
      map.set(name, fk)
    }
    fk.columns.push(str(r[1]))
    fk.refColumns.push(str(r[4]))
  }
  return [...map.values()]
}

/** 설계용 외래 키 행들([이름, 열, 참조 스키마(MySQL은 DB), 참조 표, 참조 열, ON UPDATE, ON DELETE]) → DesignForeignKey[] */
export function groupDesignFks(rows: Cell[][]): DesignForeignKey[] {
  const map = new Map<string, DesignForeignKey>()
  for (const r of rows) {
    const name = str(r[0])
    let fk = map.get(name)
    if (!fk) {
      fk = { name, columns: [], refSchema: str(r[2]), refTable: str(r[3]), refColumns: [], onUpdate: fkAction(str(r[5])), onDelete: fkAction(str(r[6])), orig: name }
      map.set(name, fk)
    }
    fk.columns.push(str(r[1]))
    fk.refColumns.push(str(r[4]))
  }
  return [...map.values()]
}

/** 설계용 인덱스 행들([이름, unique, 열, UNIQUE 제약인지]) → DesignIndex[] (기본 키는 빼고 넘길 것) */
export function groupDesignIndexes(rows: Cell[][], expr: string): DesignIndex[] {
  const map = new Map<string, DesignIndex>()
  for (const r of rows) {
    const name = str(r[0])
    let ix = map.get(name)
    if (!ix) {
      ix = { name, unique: bool(r[1]), columns: [], orig: name, ...(bool(r[3]) ? { constraint: true } : {}) }
      map.set(name, ix)
    }
    ix.columns.push(r[2] === null ? expr : str(r[2]))
  }
  return [...map.values()]
}

/** 인덱스 행들([이름, unique, primary, 열]) → IndexInfo[] */
export function groupIndexes(rows: Cell[][]): IndexInfo[] {
  const map = new Map<string, IndexInfo>()
  for (const r of rows) {
    const name = str(r[0])
    let ix = map.get(name)
    if (!ix) {
      ix = { name, unique: bool(r[1]), primary: bool(r[2]), columns: [] }
      map.set(name, ix)
    }
    ix.columns.push(str(r[3]))
  }
  return [...map.values()].sort((a, b) => Number(b.primary) - Number(a.primary) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export const elapsed = (t0: number) => Math.round((performance.now() - t0) * 10) / 10
