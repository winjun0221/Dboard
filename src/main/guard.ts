// 화면에서 넘어온 값 검사. 화면(renderer)이 잘못되거나 뚫려도 메인 프로세스가 엉뚱한 파일·값을 다루지 않게.
// 이름(DB·표·열)은 SQL에 넣을 때 따옴표로 감싸므로 여기서는 모양(글자 수, NUL)만 본다.
import path from 'node:path'
import { t } from '../shared/i18n'
import {
  CSV_DELIMITERS, DRIVER_KINDS, EXPORT_FORMATS, type Cell, type ConnectionConfig, type CsvReadOptions, type CsvWriteOptions, type DataQuery, type ImportOptions,
  type DumpObject, type DumpOptions, type RowChange, type SecretsInput, type SortKey, type TableRef,
} from '../shared/types'

export function checkDumpOptions(v: unknown): DumpOptions {
  const o = checkObject(v)
  const r = { structure: checkBool(o.structure), data: checkBool(o.data), drop: checkBool(o.drop), batch: checkInt(o.batch, 1, 10_000) }
  if (!r.structure && !r.data) throw new Error(t('구조와 데이터 중 하나는 골라 주세요'))
  return r
}

export function checkDumpObjects(v: unknown): DumpObject[] {
  if (!Array.isArray(v) || v.length > 20_000) throw new Error(t('잘못된 요청'))
  return v.map((x) => {
    const o = checkObject(x)
    const name = checkName(o.name)
    if (!name) throw new Error(t('잘못된 요청'))
    return { name, kind: checkOneOf(o.kind, ['table', 'view'] as const) }
  })
}

/** 이번 실행에서 사용자가 파일 고르기 창으로 고른 파일 (CSV 가져오기) */
const picked = new Set<string>()

export function allowFile(file: string) {
  picked.add(path.resolve(file))
}

export function checkPickedFile(file: unknown): string {
  if (typeof file !== 'string' || !picked.has(path.resolve(file))) throw new Error(t('파일 고르기로 고른 파일만 쓸 수 있어요'))
  return path.resolve(file)
}

export function checkText(v: unknown, max = 100_000): string {
  if (typeof v !== 'string' || v.length > max || v.includes('\0')) throw new Error(t('잘못된 요청'))
  return v
}

export function checkBool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error(t('잘못된 요청'))
  return v
}

export function checkInt(v: unknown, min = 0, max = 1_000_000_000): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(t('잘못된 요청'))
  return v
}

export function checkOneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new Error(t('잘못된 요청'))
  return v as T
}

export function checkObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(t('잘못된 요청'))
  return v as Record<string, unknown>
}

/** DB·스키마·표·열 이름 ('' 허용) */
export function checkName(v: unknown): string {
  return checkText(v, 512)
}

/** SQL 글 (최대 10MB) */
export function checkSql(v: unknown): string {
  const s = checkText(v, 10_000_000)
  if (!s.trim()) throw new Error(t('실행할 SQL이 없어요'))
  return s
}

/** 편집기 탭 이름 (화면이 만든 무작위 글자) */
export function checkTabKey(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error(t('잘못된 요청'))
  return v
}

export function checkId(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(v)) throw new Error(t('잘못된 요청'))
  return v
}

export function checkRef(v: unknown): TableRef {
  const o = checkObject(v)
  const table = checkName(o.table)
  if (!table) throw new Error(t('잘못된 요청'))
  return { db: checkName(o.db ?? ''), schema: checkName(o.schema ?? ''), table }
}

export function checkCell(v: unknown): Cell {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return typeof v === 'string' ? checkText(v, 50_000_000) : v
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    if (typeof o.bin === 'string' && /^[0-9a-f]*$/i.test(o.bin) && typeof o.size === 'number') return { bin: o.bin, size: o.size }
  }
  throw new Error(t('잘못된 값'))
}

function checkCells(v: unknown, max = 100_000): Cell[] {
  if (!Array.isArray(v) || v.length > max) throw new Error(t('잘못된 값'))
  return v.map(checkCell)
}

function checkValues(v: unknown): Record<string, Cell> {
  const o = checkObject(v)
  const out: Record<string, Cell> = {}
  for (const [k, x] of Object.entries(o)) out[checkName(k)] = checkCell(x)
  return out
}

export function checkChanges(v: unknown): RowChange[] {
  if (!Array.isArray(v) || v.length > 100_000) throw new Error(t('잘못된 요청'))
  return v.map((c): RowChange => {
    const o = checkObject(c)
    const op = checkOneOf(o.op, ['insert', 'update', 'delete'] as const)
    if (op === 'insert') return { op, values: checkValues(o.values) }
    if (op === 'update') return { op, key: checkCells(o.key, 1000), values: checkValues(o.values) }
    return { op, key: checkCells(o.key, 1000) }
  })
}

export function checkSort(v: unknown): SortKey[] {
  if (!Array.isArray(v) || v.length > 20) throw new Error(t('잘못된 요청'))
  return v.map((x) => {
    const o = checkObject(x)
    return { column: checkName(o.column), desc: o.desc === true }
  })
}

export function checkDataQuery(v: unknown): DataQuery {
  const o = checkObject(v)
  return { filter: checkText(o.filter ?? '', 100_000), order: checkSort(o.order ?? []), offset: checkInt(o.offset, 0), limit: checkInt(o.limit, 1, 100_000) }
}

export function checkCsvWrite(v: unknown): CsvWriteOptions {
  const o = checkObject(v)
  return {
    format: checkOneOf(o.format ?? 'csv', EXPORT_FORMATS),
    table: checkText(o.table ?? '', 512),
    dialect: checkOneOf(o.dialect ?? 'sqlite', ['sqlite', 'mysql', 'postgres', 'mssql'] as const),
    delimiter: checkOneOf(o.delimiter ?? ',', CSV_DELIMITERS),
    header: o.header !== false,
    bom: o.bom !== false,
    nullText: checkText(o.nullText ?? '', 20),
  }
}

export function checkCsvRead(v: unknown): CsvReadOptions {
  const o = checkObject(v)
  return {
    delimiter: checkOneOf(o.delimiter, ['auto', ...CSV_DELIMITERS] as const),
    header: o.header !== false,
    encoding: checkOneOf(o.encoding, ['auto', 'utf8', 'euc-kr'] as const),
  }
}

export function checkImport(v: unknown): ImportOptions {
  const o = checkObject(v)
  if (!Array.isArray(o.mapping) || o.mapping.length > 5000) throw new Error(t('잘못된 요청'))
  return { ...checkCsvRead(o), mapping: o.mapping.map((m) => (m === null ? null : checkName(m) || null)), emptyAsNull: o.emptyAsNull !== false }
}

export function checkSecrets(v: unknown): SecretsInput {
  const o = v === null || v === undefined ? {} : checkObject(v)
  const out: SecretsInput = {}
  for (const k of ['password', 'sshPassword', 'sshPassphrase'] as const) if (o[k] !== undefined) out[k] = checkText(o[k], 4096)
  return out
}

const COLOR = /^(#[0-9a-f]{6})?$/i

/** 접속 정보: 모양을 맞추고 범위를 넘는 값은 고친다 */
export function checkConfig(v: unknown): ConnectionConfig {
  const o = checkObject(v)
  const ssh = checkObject(o.ssh ?? {})
  const driver = checkOneOf(o.driver, DRIVER_KINDS)
  const name = checkText(o.name ?? '', 200).trim()
  const file = checkText(o.file ?? '', 4096).trim()
  if (driver === 'sqlite' && file && !path.isAbsolute(file)) throw new Error(t('SQLite 파일은 전체 경로로 적어 주세요'))
  const keyFile = checkText(ssh.keyFile ?? '', 4096).trim()
  const port = (x: unknown, d: number) => (typeof x === 'number' && Number.isInteger(x) && x > 0 && x < 65536 ? x : d)
  const color = checkText(o.color ?? '', 7)
  return {
    id: o.id ? checkId(o.id) : '',
    name,
    driver,
    color: COLOR.test(color) ? color : '',
    host: checkText(o.host ?? '', 255).trim(),
    port: port(o.port, 0),
    database: checkText(o.database ?? '', 512).trim(),
    user: checkText(o.user ?? '', 512),
    file,
    savePassword: o.savePassword !== false,
    ssl: checkOneOf(o.ssl ?? 'off', ['off', 'require', 'verify'] as const),
    showSystem: o.showSystem === true,
    production: o.production === true,
    readOnly: o.readOnly === true,
    ssh: {
      enabled: ssh.enabled === true,
      host: checkText(ssh.host ?? '', 255).trim(),
      port: port(ssh.port, 22),
      user: checkText(ssh.user ?? '', 255),
      auth: checkOneOf(ssh.auth ?? 'password', ['password', 'key'] as const),
      keyFile,
    },
  }
}

/** 연결해도 되는 모양인지 (저장은 덜 채워도 되지만 연결·시험에는 필요) */
export function validateForConnect(c: ConnectionConfig) {
  if (c.driver === 'sqlite') {
    if (!c.file) throw new Error(t('SQLite 파일을 골라 주세요'))
    return
  }
  if (!c.host) throw new Error(t('호스트를 적어 주세요'))
  if (!c.port) throw new Error(t('포트를 적어 주세요'))
  if (c.ssh.enabled) {
    if (!c.ssh.host || !c.ssh.user) throw new Error(t('SSH 호스트와 사용자를 적어 주세요'))
    if (c.ssh.auth === 'key' && !c.ssh.keyFile) throw new Error(t('SSH 개인 키 파일을 골라 주세요'))
  }
}
