// 드라이버 공통 틀: DB 연결 하나(Session)와 DB 종류별 모듈(DriverModule — 연결 열기 + 시스템 표 읽기)
// 새 DB 종류를 붙이려면 이 두 가지를 구현하고 drivers/index.ts에 등록한다.
import { beginSql } from '../../shared/dialect'
import type {
  Cell, ColumnInfo, ConnectionConfig, DatabaseList, DbObject, Dialect, IndexInfo, ObjectKind, ResultColumn, StatementResult, TableRef,
} from '../../shared/types'

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
}

/** DB 연결 하나. 한 번에 한 작업만(차례대로) — SQL Server 드라이버는 동시에 두 요청을 못 보낸다 */
export abstract class Session {
  abstract readonly dialect: Dialect
  /** 연결이 끊겼으면 true (다음에 새로 연다) */
  dead = false
  private chain: Promise<unknown> = Promise.resolve()

  protected lock<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.chain.then(fn, fn)
    this.chain = r.catch(() => undefined)
    return r
  }

  /** 문장 하나(SQL Server는 배치 하나) 실행. 결과 표는 maxRows까지 */
  protected abstract runRaw(sql: string, maxRows: number): Promise<StatementResult[]>
  protected abstract queryRaw(sql: string, params: Cell[]): Promise<Rows>
  /** 바뀐 행 수 */
  protected abstract execRaw(sql: string, params: Cell[]): Promise<number | null>
  protected abstract streamRaw(sql: string, onColumns: OnColumns, onRows: OnRows): Promise<number>
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

  query(sql: string, params: Cell[] = []) {
    return this.lock(() => this.queryRaw(sql, params))
  }

  exec(sql: string, params: Cell[] = []) {
    return this.lock(() => this.execRaw(sql, params))
  }

  stream(sql: string, onColumns: OnColumns, onRows: OnRows) {
    return this.lock(() => this.streamRaw(sql, onColumns, onRows))
  }

  /** 여러 문장을 한 트랜잭션으로. 실패하면 되돌린다 */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.lock(async () => {
      await this.execRaw(beginSql(this.dialect), [])
      try {
        const r = await fn({ exec: (s, p) => this.execRaw(s, p ?? []), query: (s, p) => this.queryRaw(s, p ?? []) })
        await this.execRaw('COMMIT', [])
        return r
      } catch (e) {
        try {
          await this.execRaw('ROLLBACK', [])
        } catch {
          // 연결이 끊긴 경우 등 — 원래 오류를 알려 준다
        }
        throw e
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
  completion(s: Session, db: string, schema: string): Promise<Record<string, string[]>>
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
