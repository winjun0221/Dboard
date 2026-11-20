// 화면 ↔ 메인 프로세스가 주고받는 모양. Api의 메서드 이름 = IPC 채널 이름 (API_METHODS와 main.ts의 handlers가 같은 목록)
import type { LangSetting } from './i18n'

/** 접속 종류. mariadb는 mysql 드라이버를 쓰고, MySQL·PostgreSQL 호환 DB(TiDB·CockroachDB 등)도 같은 종류로 붙는다 */
export type DriverKind = 'sqlite' | 'mysql' | 'mariadb' | 'postgres' | 'mssql'
/** SQL 방언 (따옴표·페이지·시스템 표 읽는 방법) */
export type Dialect = 'sqlite' | 'mysql' | 'postgres' | 'mssql'
export const DRIVER_KINDS: readonly DriverKind[] = ['sqlite', 'mysql', 'mariadb', 'postgres', 'mssql']
export const dialectOf = (k: DriverKind): Dialect => (k === 'mariadb' ? 'mysql' : k)

/** off: 암호화 안 함 · require: 암호화(인증서 확인 안 함) · verify: 암호화 + 인증서 확인 */
export type SslMode = 'off' | 'require' | 'verify'

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  auth: 'password' | 'key'
  /** 개인 키 파일 경로 (auth = key) */
  keyFile: string
}

export interface ConnectionConfig {
  /** 새로 만들 때는 '' */
  id: string
  name: string
  driver: DriverKind
  /** 탐색기 표시 색 ('' = 기본) */
  color: string
  host: string
  port: number
  /** 처음 열 DB (비우면 서버 기본값) */
  database: string
  user: string
  /** SQLite 파일 경로 */
  file: string
  /** 비밀번호를 Windows 암호화(DPAPI)로 저장. 끄면 연결할 때마다 묻는다 */
  savePassword: boolean
  ssl: SslMode
  /** 시스템 DB·스키마도 보이기 (information_schema, pg_catalog, master 등) */
  showSystem: boolean
  ssh: SshConfig
}

/** 화면이 보내는 비밀 값. 없는 칸(undefined)은 저장된 값을 그대로 쓴다. 화면으로는 절대 돌려주지 않는다 */
export interface SecretsInput {
  password?: string
  sshPassword?: string
  sshPassphrase?: string
}
export type SecretName = keyof SecretsInput

/** 화면에 보여 주는 접속 정보 (비밀 값 대신 저장돼 있는지만) */
export interface ConnectionInfo extends ConnectionConfig {
  saved: Record<SecretName, boolean>
}

/** need: 물어봐야 하는 비밀 값. newHostKey: 처음 본 SSH 호스트 키를 기억했으면 그 지문 */
export type ConnectResult = { ok: true; version: string; newHostKey: string | null } | { ok: false; need: SecretName[] }

export interface TestResult {
  version: string
  ms: number
}

// ───────── 결과 ─────────

/** 칸 값. 날짜·큰 정수·소수는 DB가 준 글자 그대로(string), 바이너리는 앞부분 16진수와 크기 */
export type Cell = null | string | number | boolean | BinCell
export interface BinCell {
  bin: string
  size: number
}
export const isBin = (v: Cell): v is BinCell => typeof v === 'object' && v !== null

export interface ResultColumn {
  name: string
  type: string
}

export interface StatementResult {
  /** 실행한 문장 */
  sql: string
  /** null = 결과 표가 없는 문장 (INSERT·CREATE 등) */
  columns: ResultColumn[] | null
  rows: Cell[][]
  /** 최대 행 수에서 끊었는지 */
  truncated: boolean
  /** 바뀐 행 수 (알 수 없으면 null) */
  affected: number | null
  ms: number
}

// ───────── 탐색기 ─────────

export interface DatabaseList {
  databases: string[]
  /** DB 아래에 스키마 단계가 있는지 (PostgreSQL·SQL Server) */
  hasSchemas: boolean
  /** 새 SQL 편집기에서 처음 고를 스키마 */
  defaultSchema: string
}

export type ObjectKind = 'table' | 'view'

export interface DbObject {
  name: string
  kind: ObjectKind
  comment: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  default: string | null
  pk: boolean
  autoIncrement: boolean
  comment: string
  /** 계산 열(GENERATED·AS 식) — 값을 넣을 수 없음 */
  generated?: boolean
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
}

export interface TableRef {
  db: string
  /** 스키마가 없는 DB(SQLite·MySQL)는 '' */
  schema: string
  table: string
}

// ───────── 표 데이터 보기·고치기 ─────────

export interface SortKey {
  column: string
  desc: boolean
}

export interface DataQuery {
  /** WHERE 뒤에 들어갈 조건 (사용자가 쓴 SQL) */
  filter: string
  order: SortKey[]
  offset: number
  limit: number
}

/** 행을 찾는 열: 기본 키 → (SQLite) rowid → 모든 열 */
export interface TableKey {
  kind: 'pk' | 'rowid' | 'all'
  columns: string[]
}

export interface TableData {
  columns: ResultColumn[]
  rows: Cell[][]
  /** key.kind = rowid일 때 행마다 rowid */
  rowids: Cell[] | null
  hasMore: boolean
  key: TableKey
  ms: number
}

/** 저장할 바뀜 하나. key는 TableKey.columns 순서의 원래 값 (rowid면 [rowid]) */
export type RowChange =
  | { op: 'update'; key: Cell[]; values: Record<string, Cell> }
  | { op: 'insert'; values: Record<string, Cell> }
  | { op: 'delete'; key: Cell[] }

// ───────── CSV ─────────

export type CsvDelimiter = ',' | ';' | '\t' | '|'
export const CSV_DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t', '|']

export interface CsvWriteOptions {
  delimiter: CsvDelimiter
  header: boolean
  /** 엑셀이 한글을 바로 읽게 UTF-8 BOM */
  bom: boolean
  /** NULL을 쓸 글자 (기본 빈칸) */
  nullText: string
}

export type CsvEncoding = 'utf8' | 'euc-kr'

export interface CsvReadOptions {
  delimiter: CsvDelimiter | 'auto'
  header: boolean
  encoding: CsvEncoding | 'auto'
}

export interface CsvPreview {
  path: string
  name: string
  encoding: CsvEncoding
  delimiter: CsvDelimiter
  headers: string[]
  rows: string[][]
  total: number
}

export interface ImportOptions extends CsvReadOptions {
  /** CSV 열마다 넣을 표의 열 (null = 넣지 않음) */
  mapping: (string | null)[]
  /** 빈칸은 NULL로 */
  emptyAsNull: boolean
}

export interface ExportResult {
  path: string
  rows: number
}

// ───────── SQL 덤프·SQL 파일 실행 ─────────

export interface DumpOptions {
  /** CREATE 문 (표·뷰·인덱스) */
  structure: boolean
  /** INSERT 문 (표만) */
  data: boolean
  /** 맨 앞에 DROP … IF EXISTS */
  drop: boolean
  /** INSERT 한 문장에 넣을 행 수 (SQL Server는 1000까지) */
  batch: number
}

export interface DumpObject {
  name: string
  kind: ObjectKind
}

export interface DumpResult {
  path: string
  tables: number
  views: number
  rows: number
}

export interface SqlFileResult {
  statements: number
  ms: number
}

// ───────── 실행 기록·설정·업데이트 ─────────

export interface HistoryEntry {
  id: number
  at: number
  connId: string
  connName: string
  db: string
  sql: string
  ms: number
  rows: number | null
  error: string | null
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  language: LangSetting
  /** 0 = 자동 */
  zoom: number
  autoUpdate: boolean
  /** SQL 편집기 결과 최대 행 수 */
  maxRows: number
  /** 표 데이터 한 번에 가져올 행 수 */
  pageSize: number
  editorFontSize: number
  /** WHERE 없는 UPDATE·DELETE는 실행 전에 묻기 */
  confirmDangerous: boolean
}

export interface UpdateStatus {
  current: string
  state: 'idle' | 'disabled' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error'
  message: string | null
  newVersion: string | null
  progress: number | null
  checkedAt: number | null
}

export interface AppInfo {
  version: string
  /** Windows 암호화로 비밀번호를 저장할 수 있는지 */
  secureStorage: boolean
}

export interface Api {
  // 접속 정보
  listConnections(): Promise<ConnectionInfo[]>
  saveConnection(config: ConnectionConfig, secrets: SecretsInput): Promise<ConnectionInfo>
  deleteConnection(id: string): Promise<void>
  duplicateConnection(id: string): Promise<ConnectionInfo>
  moveConnection(id: string, toIndex: number): Promise<void>
  testConnection(config: ConnectionConfig, secrets: SecretsInput): Promise<TestResult>
  connect(id: string, prompt: SecretsInput | null): Promise<ConnectResult>
  disconnect(id: string): Promise<void>
  connectedIds(): Promise<string[]>
  pickSqliteFile(mode: 'open' | 'create'): Promise<string | null>
  pickKeyFile(): Promise<string | null>
  forgetHostKey(host: string, port: number): Promise<void>

  // 탐색기
  databases(connId: string): Promise<DatabaseList>
  schemas(connId: string, db: string): Promise<string[]>
  objects(connId: string, db: string, schema: string): Promise<DbObject[]>
  columns(connId: string, ref: TableRef): Promise<ColumnInfo[]>
  indexes(connId: string, ref: TableRef): Promise<IndexInfo[]>
  ddl(connId: string, ref: TableRef, kind: ObjectKind): Promise<string>
  /** 자동 완성용: 표 이름 → 열 이름들 */
  completion(connId: string, db: string, schema: string): Promise<Record<string, string[]>>

  // SQL 편집기 (탭마다 DB 연결 하나: tabKey는 화면이 정한 탭 이름)
  runSql(connId: string, tabKey: string, db: string, schema: string, sql: string, maxRows: number): Promise<StatementResult[]>
  cancelSql(tabKey: string): Promise<void>
  closeSession(tabKey: string): Promise<void>
  history(search: string, limit: number): Promise<HistoryEntry[]>
  clearHistory(): Promise<void>

  // 표 데이터
  tableData(connId: string, ref: TableRef, q: DataQuery): Promise<TableData>
  countRows(connId: string, ref: TableRef, filter: string): Promise<number>
  applyChanges(connId: string, ref: TableRef, changes: RowChange[]): Promise<number>

  // CSV
  saveCsv(defaultName: string, columns: string[], rows: Cell[][], o: CsvWriteOptions): Promise<ExportResult | null>
  exportQueryCsv(connId: string, tabKey: string, db: string, schema: string, sql: string, o: CsvWriteOptions, defaultName: string): Promise<ExportResult | null>
  exportTableCsv(connId: string, ref: TableRef, filter: string, order: SortKey[], o: CsvWriteOptions): Promise<ExportResult | null>
  pickCsv(): Promise<string | null>
  /** 표·뷰를 구조(DDL)·데이터(INSERT)로 .sql 파일에 쓰기. tabKey로 취소(cancelSql) */
  exportDump(connId: string, tabKey: string, db: string, schema: string, objects: DumpObject[], o: DumpOptions, name: string): Promise<DumpResult | null>
  pickSqlFile(): Promise<string | null>
  /** .sql 파일을 문장마다 차례로 실행 (오류 나면 멈춤). tabKey로 취소 */
  runSqlFile(connId: string, tabKey: string, db: string, schema: string, path: string): Promise<SqlFileResult>
  previewCsv(path: string, o: CsvReadOptions): Promise<CsvPreview>
  importCsv(connId: string, ref: TableRef, path: string, o: ImportOptions): Promise<number>

  // 앱
  settings(): Promise<AppSettings>
  saveSettings(s: AppSettings): Promise<AppSettings>
  appInfo(): Promise<AppInfo>
  copyText(text: string): Promise<void>
  updateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  installUpdate(): Promise<void>
  openUrl(url: string): Promise<void>
}

export const API_METHODS = [
  'listConnections', 'saveConnection', 'deleteConnection', 'duplicateConnection', 'moveConnection', 'testConnection', 'connect',
  'disconnect', 'connectedIds', 'pickSqliteFile', 'pickKeyFile', 'forgetHostKey',
  'databases', 'schemas', 'objects', 'columns', 'indexes', 'ddl', 'completion',
  'runSql', 'cancelSql', 'closeSession', 'history', 'clearHistory',
  'tableData', 'countRows', 'applyChanges',
  'saveCsv', 'exportQueryCsv', 'exportTableCsv', 'pickCsv', 'previewCsv', 'importCsv', 'exportDump', 'pickSqlFile', 'runSqlFile',
  'settings', 'saveSettings', 'appInfo', 'copyText', 'updateStatus', 'checkForUpdates', 'installUpdate', 'openUrl',
] as const satisfies readonly (keyof Api)[]

// API_METHODS에 빠진 메서드가 있으면 여기서 타입 오류
type Missing = Exclude<keyof Api, (typeof API_METHODS)[number]>
export const API_COMPLETE: Missing extends never ? true : Missing = true

export const DEFAULT_PORTS: Record<DriverKind, number> = { sqlite: 0, mysql: 3306, mariadb: 3306, postgres: 5432, mssql: 1433 }

export function newConnection(driver: DriverKind = 'postgres'): ConnectionConfig {
  return {
    id: '',
    name: '',
    driver,
    color: '',
    host: driver === 'sqlite' ? '' : 'localhost',
    port: DEFAULT_PORTS[driver],
    database: '',
    user: driver === 'postgres' ? 'postgres' : driver === 'mssql' ? 'sa' : driver === 'sqlite' ? '' : 'root',
    file: '',
    savePassword: true,
    ssl: driver === 'mssql' ? 'require' : 'off',
    showSystem: false,
    ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password', keyFile: '' },
  }
}
