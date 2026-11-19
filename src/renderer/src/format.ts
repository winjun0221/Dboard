// 칸 값 보여 주기·접속 종류 이름과 색
import { isBin, type Cell, type DriverKind, type ConnectionConfig } from '../../shared/types'

export const DRIVER_LABEL: Record<DriverKind, string> = { sqlite: 'SQLite', mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', mssql: 'SQL Server' }
export const DRIVER_SHORT: Record<DriverKind, string> = { sqlite: 'SL', mysql: 'My', mariadb: 'Ma', postgres: 'Pg', mssql: 'MS' }
export const DRIVER_COLOR: Record<DriverKind, string> = { sqlite: '#0e9fd8', mysql: '#e48e00', mariadb: '#b0703c', postgres: '#3d6fd8', mssql: '#d9443f' }

/** 접속 설명 한 줄: 호스트:포트/DB 또는 파일 이름 */
export function connSummary(c: ConnectionConfig): string {
  if (c.driver === 'sqlite') return c.file.split(/[\\/]/).pop() || ''
  return `${c.host}${c.port ? ':' + c.port : ''}${c.database ? '/' + c.database : ''}`
}

export function cellText(v: Cell): string {
  if (v === null) return 'NULL'
  if (isBin(v)) return '0x' + v.bin.toUpperCase() + (v.size > v.bin.length / 2 ? '…' : '')
  return String(v)
}

/** 칸에 그릴 글 (줄바꿈은 ↵, 너무 길면 자름) */
export function cellDisplay(v: Cell): string {
  const s = cellText(v)
  const short = s.length > 400 ? s.slice(0, 400) + '…' : s
  return short.replace(/\r?\n/g, '↵').replace(/\t/g, ' ')
}

/** 복사용 (탭·줄바꿈이 있으면 엑셀처럼 큰따옴표로) */
export function cellCopy(v: Cell): string {
  if (v === null) return ''
  const s = isBin(v) ? '0x' + v.bin.toUpperCase() : String(v)
  return /[\t\r\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

const NUM_TYPE = /^(tiny|small|medium|big)?int|integer|serial|numeric|decimal|float|double|real|money|number|int[248]|year/i

export const isNumericType = (type: string) => NUM_TYPE.test(type)

/** 정렬: NULL 먼저, 숫자는 숫자로(큰 정수·소수 글자도), 나머지는 글자 코드 순서 */
export function compareCells(a: Cell, b: Cell, numeric: boolean): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (numeric) {
    const x = Number(a)
    const y = Number(b)
    if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y
  }
  const x = cellText(a)
  const y = cellText(b)
  return x < y ? -1 : x > y ? 1 : 0
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

export const fmtNum = (n: number) => n.toLocaleString('en-US')

export const randomKey = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
