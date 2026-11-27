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
  /** 운영 DB: 편집기 기본이 수동 커밋, 데이터를 바꾸는 문장은 실행 전에 한 번 더 묻기, 탭·상태 줄에 빨간 표시 (예전 접속 정보엔 없음 = false) */
  production?: boolean
  /** 읽기 전용: 바꾸는 문장·데이터 고치기·가져오기를 막는다 (MySQL·PostgreSQL·SQLite는 서버 설정으로도) */
  readOnly?: boolean
  /** 탐색기에서 묶어 보여 줄 폴더 ('' = 없음) */
  folder?: string
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

/** 실행 계획: 글(나무 모양) 또는 표 (MariaDB 등) */
export interface ExplainResult {
  text: string | null
  result: StatementResult | null
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

/** 표·뷰 말고 탐색기에 보여 줄 개체 */
export type ExtraKind = 'procedure' | 'function' | 'trigger' | 'sequence' | 'event'
export const EXTRA_KINDS: readonly ExtraKind[] = ['procedure', 'function', 'trigger', 'sequence', 'event']

export interface ExtraObject {
  kind: ExtraKind
  name: string
  /** 원본을 찾을 때 쓰는 값 (PostgreSQL·SQL Server는 oid·object_id, 나머지는 이름) */
  id: string
  /** 트리거가 걸린 표 */
  table: string
  /** PostgreSQL 함수 인자 (같은 이름 함수 구별·지울 때) */
  args: string
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

/** 외래 키: columns → ref 표의 refColumns */
export interface ForeignKeyInfo {
  name: string
  columns: string[]
  ref: TableRef
  refColumns: string[]
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

// ───────── 표 설계 ─────────

export type FkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'
export const FK_ACTIONS: readonly FkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']

/** orig: 원래 이름 (새로 넣은 것은 null) — 원래 설계와 비교해 ALTER 문을 만든다 */
export interface DesignColumn {
  name: string
  type: string
  nullable: boolean
  /** 기본값 SQL 식 ('' = 없음). 글자는 따옴표까지: 'abc' */
  default: string
  autoIncrement: boolean
  comment: string
  /** 계산 열: 설계 화면에서 고칠 수 없음 */
  generated: boolean
  orig: string | null
  /** MySQL: 열 정렬 규칙(표 기본과 다를 때)·ON UPDATE 식 — 다시 쓸 때 잃지 않게 */
  collation?: string
  onUpdate?: string
}

export interface DesignIndex {
  name: string
  columns: string[]
  unique: boolean
  orig: string | null
  /** UNIQUE 제약(인덱스가 아니라 제약으로 지운다: PostgreSQL·SQL Server) */
  constraint?: boolean
  /** 원래 CREATE INDEX 문 (식·조건 인덱스를 표를 다시 만들 때 그대로 살린다: SQLite) */
  sql?: string
}

export interface DesignForeignKey {
  name: string
  columns: string[]
  /** 참조 표의 스키마 (MySQL은 DB, SQLite는 '') */
  refSchema: string
  refTable: string
  refColumns: string[]
  onDelete: FkAction
  onUpdate: FkAction
  orig: string | null
}

export interface TableDesign {
  name: string
  comment: string
  columns: DesignColumn[]
  /** 기본 키 열 (순서대로) */
  primaryKey: string[]
  /** 기본 키 제약 이름 ('' = 이름 없음·DB가 정함) */
  pkName: string
  indexes: DesignIndex[]
  foreignKeys: DesignForeignKey[]
  /** 설계 화면이 다루지 않는 설정(SQLite CHECK·COLLATE 등) — 있으면 표를 다시 만들어야 하는 바뀜은 막는다 */
  unsupported: string[]
  /** SQLite: 표를 다시 만들 때 살릴 것 — 닫는 괄호 뒤 옵션(WITHOUT ROWID·STRICT), 트리거 CREATE 문 */
  options?: string
  triggers?: string[]
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

export type ExportFormat = 'csv' | 'json' | 'md' | 'xlsx' | 'sql'
export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'xlsx', 'json', 'md', 'sql']

/** 내보내기 설정 (CSV 말고 다른 형식도: format) */
export interface CsvWriteOptions {
  format: ExportFormat
  /** SQL(INSERT) 형식에서 넣을 표 이름과 따옴표 방식 */
  table: string
  dialect: Dialect
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
  /** 엑셀 시트 (0부터) */
  sheet?: number
}

export interface CsvPreview {
  /** 파일 종류 (확장자로): CSV · 엑셀 · JSON */
  format: 'csv' | 'xlsx' | 'json'
  /** 엑셀 시트 이름들 */
  sheets?: string[]
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

// ───────── ER 다이어그램 ─────────

export interface ErTable {
  name: string
  comment: string
  columns: { name: string; type: string; pk: boolean; nullable: boolean }[]
}

/** 외래 키 선: from 표의 열 → to 표의 열 (같은 스키마 안) */
export interface ErLink {
  name: string
  from: string
  fromColumns: string[]
  to: string
  toColumns: string[]
}

export interface ErModel {
  tables: ErTable[]
  links: ErLink[]
  /** 표가 너무 많아 앞쪽만 담았는지 */
  truncated: boolean
}

// ───────── 스키마 비교·데이터 옮기기 ─────────

/** same 같음 · changed 다름 · source 원본에만 · target 대상에만 */
export type CompareStatus = 'same' | 'changed' | 'source' | 'target'

export interface CompareItem {
  name: string
  kind: ObjectKind
  status: CompareStatus
  /** 사람이 읽는 바뀐 점 */
  changes: string[]
  /** 대상을 원본처럼 만드는 문장 (뷰는 없음) */
  statements: string[]
  warnings: string[]
  /** SQL을 만들지 못한 이유 */
  error: string | null
}

export interface CompareResult {
  dialect: Dialect
  /** 순서대로 실행하면 된다: 새 표(외래 키 부모 먼저) → 바뀐 표 → 대상에만 있는 것 → 뷰 */
  items: CompareItem[]
}

export interface TransferOptions {
  /** 대상에 표가 없으면 만들기 (타입을 대상 DB에 맞춤, 외래 키는 빼고) */
  create: boolean
  /** 옮기기 전에 대상 표 비우기 */
  truncate: boolean
  /** INSERT 한 번에 넣을 행 수 */
  batch: number
  /** 표 하나가 실패하면 멈추기 (아니면 다음 표로) */
  stopOnError: boolean
}

export interface TransferResult {
  tables: { name: string; rows: number; created: boolean; error: string | null }[]
  ms: number
}

// ───────── 전체 검색 ─────────

export type SearchKind = 'table' | 'view' | 'column' | ExtraKind

/** 이름 찾기 결과: column이면 table이 그 열의 표 */
export interface SearchHit {
  db: string
  schema: string
  kind: SearchKind
  table: string
  name: string
  /** 열 타입 등 */
  extra: string
}

/** 데이터 찾기 결과: 그 값이 들어 있는 행 수 */
export interface DataHit {
  table: string
  columns: string[]
  count: number
  error: string | null
}

// ───────── 서버 상태 ─────────

/** gauges: 지금 값(연결 수 등), counters: 쌓이는 값(쿼리 수 등 — 화면이 차이로 초당 값을 낸다), info: 글 */
export interface ServerStats {
  at: number
  gauges: Record<string, number>
  counters: Record<string, number>
  info: Record<string, string>
}

// ───────── 사용자·권한 ─────────

export interface DbUser {
  name: string
  /** MySQL 접속할 수 있는 곳 (그 밖에는 '') */
  host: string
  login: boolean
  superuser: boolean
  attrs: string[]
}

export type UserAction =
  | { kind: 'create'; name: string; host: string; password: string; login: boolean }
  | { kind: 'drop'; name: string; host: string }
  | { kind: 'password'; name: string; host: string; password: string }
  | { kind: 'grant' | 'revoke'; name: string; host: string; privileges: string[]; db: string; schema: string; table: string }

// ───────── 세션 관리자 ─────────

/** 서버에 붙어 있는 연결 하나 */
export interface ServerSession {
  id: string
  user: string
  db: string
  host: string
  app: string
  /** 실행 중·쉬는 중 등 서버가 주는 글자 */
  state: string
  /** 지금 상태로 지난 초 (모르면 null) */
  seconds: number | null
  query: string
  /** 목록을 읽은 이 연결 */
  own: boolean
}

// ───────── SQL 스크립트 파일 ─────────

export interface SqlFile {
  path: string
  name: string
  text: string
}

export interface ScriptEntry {
  path: string
  name: string
  /** 스크립트 폴더 안이면 그 안의 상대 폴더('' = 맨 위), 바깥 파일(최근 연 파일)이면 null */
  folder: string | null
  mtime: number
  size: number
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
  /** 쿼리 변수(:이름, ${이름})가 있으면 실행 전에 값 묻기 */
  queryParams: boolean
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
  /** 접속을 폴더로 묶기 ('' = 폴더에서 빼기). 연결은 끊지 않는다 */
  setConnectionFolder(ids: string[], folder: string): Promise<void>
  /** 접속 목록을 JSON 파일로 (비밀번호 빼고) · 가져오기 (새 접속으로 더함). 고르는 창을 닫으면 null */
  exportConnections(): Promise<number | null>
  importConnections(): Promise<number | null>
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
  /** 프로시저·함수·트리거·시퀀스·이벤트 */
  extraObjects(connId: string, db: string, schema: string): Promise<ExtraObject[]>
  /** 개체 원본 (CREATE 문) */
  objectSource(connId: string, db: string, schema: string, kind: ExtraKind, id: string): Promise<string>
  /** 스키마 비교: 대상(dst)을 원본(src)처럼 만드는 SQL을 표마다 (같은 종류 DB끼리) */
  compareSchemas(srcConn: string, srcDb: string, srcSchema: string, dstConn: string, dstDb: string, dstSchema: string): Promise<CompareResult>
  /** 데이터 옮기기 (다른 종류 DB도). tabKey로 취소(cancelSql) */
  transferData(srcConn: string, srcDb: string, srcSchema: string, dstConn: string, dstDb: string, dstSchema: string, tables: string[], o: TransferOptions, tabKey: string): Promise<TransferResult>
  /** ER 다이어그램: 스키마(DB)의 표·열·외래 키 */
  erModel(connId: string, db: string, schema: string): Promise<ErModel>
  /** 그림 저장 (svg = SVG 글, png = base64) */
  saveImage(defaultName: string, kind: 'png' | 'svg', data: string): Promise<string | null>
  /** 이름 찾기: 표·뷰·열·프로시저 등 (allDbs면 접속의 모든 DB, 아니면 db만) */
  searchNames(connId: string, text: string, allDbs: boolean, db: string): Promise<SearchHit[]>
  /** 데이터 찾기: 스키마(DB)의 표마다 글 열에 그 값이 든 행 수. tabKey로 취소 */
  searchData(connId: string, db: string, schema: string, text: string, tabKey: string): Promise<DataHit[]>
  /** 사용자·권한: 목록, 한 사용자의 권한 줄들(db 안에서), 바꾸기(비밀번호는 기록에 남기지 않음) */
  users(connId: string): Promise<DbUser[]>
  userGrants(connId: string, name: string, host: string, db: string): Promise<string[]>
  runUserAction(connId: string, db: string, schema: string, action: UserAction): Promise<void>
  /** 서버 상태 한 번 읽기 (SQLite는 없음) */
  serverStats(connId: string): Promise<ServerStats>
  /** 세션 관리자: 서버의 연결 목록, 쿼리 취소(queryOnly) 또는 연결 끊기 */
  serverSessions(connId: string): Promise<ServerSession[]>
  killSession(connId: string, sessionId: string, queryOnly: boolean): Promise<void>
  /** 표 설계 화면용: 열·기본 키·인덱스·외래 키 */
  tableDesign(connId: string, ref: TableRef): Promise<TableDesign>
  /** 구조를 바꾸는 문장들을 차례로 실행 (표 설계·이름 바꾸기·지우기). 오류가 나면 멈추고 되돌리기 시도 */
  runDdl(connId: string, db: string, schema: string, statements: string[]): Promise<void>

  // SQL 편집기 (탭마다 DB 연결 하나: tabKey는 화면이 정한 탭 이름)
  /** manual = 수동 커밋 (커밋·롤백 전까지 트랜잭션 안) */
  runSql(connId: string, tabKey: string, db: string, schema: string, sql: string, maxRows: number, manual: boolean): Promise<StatementResult[]>
  cancelSql(tabKey: string): Promise<void>
  /** 편집기 탭 연결의 트랜잭션 확정·되돌리기 (연결이 없으면 아무것도 안 함) */
  commitTx(tabKey: string): Promise<void>
  rollbackTx(tabKey: string): Promise<void>
  /** 실행하지 않고 실행 계획만 */
  explain(connId: string, tabKey: string, db: string, schema: string, sql: string, manual: boolean): Promise<ExplainResult>
  foreignKeys(connId: string, ref: TableRef): Promise<ForeignKeyInfo[]>
  /** 표의 칸 값 전체 (화면 표에는 바이너리 앞부분만 있다). keyValues는 TableData.key 순서 (rowid면 [rowid]) */
  cellValue(connId: string, ref: TableRef, keyValues: Cell[], column: string): Promise<Cell>
  /** 칸 값을 파일로 저장 (바이너리는 그대로, 글은 UTF-8) */
  saveCellValue(connId: string, ref: TableRef, keyValues: Cell[], column: string, defaultName: string): Promise<string | null>
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
  /** SQL 스크립트 파일: 열기(고르는 창) · 다시 읽기 · 저장(path가 null이면 다른 이름으로) · 목록(스크립트 폴더 + 최근 파일) */
  openSqlFile(): Promise<SqlFile | null>
  readSqlFile(path: string): Promise<SqlFile>
  saveSqlFile(path: string | null, text: string, defaultName: string): Promise<SqlFile | null>
  listScripts(): Promise<{ dir: string; files: ScriptEntry[] }>
  forgetScript(path: string): Promise<void>
  /** 파일을 Windows 탐색기에서 보기 (null = 스크립트 폴더 열기) */
  revealScript(path: string | null): Promise<void>
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
  'listConnections', 'saveConnection', 'deleteConnection', 'duplicateConnection', 'moveConnection', 'setConnectionFolder', 'exportConnections', 'importConnections', 'testConnection', 'connect',
  'disconnect', 'connectedIds', 'pickSqliteFile', 'pickKeyFile', 'forgetHostKey',
  'databases', 'schemas', 'objects', 'columns', 'indexes', 'ddl', 'completion', 'extraObjects', 'objectSource', 'serverSessions', 'killSession', 'erModel', 'saveImage', 'searchNames', 'searchData', 'serverStats', 'users', 'userGrants', 'runUserAction', 'compareSchemas', 'transferData', 'tableDesign', 'runDdl',
  'runSql', 'cancelSql', 'commitTx', 'rollbackTx', 'explain', 'foreignKeys', 'cellValue', 'saveCellValue', 'closeSession', 'history', 'clearHistory',
  'tableData', 'countRows', 'applyChanges',
  'saveCsv', 'exportQueryCsv', 'exportTableCsv', 'pickCsv', 'previewCsv', 'importCsv', 'exportDump', 'pickSqlFile', 'runSqlFile',
  'openSqlFile', 'readSqlFile', 'saveSqlFile', 'listScripts', 'forgetScript', 'revealScript',
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
    production: false,
    readOnly: false,
    folder: '',
  }
}
