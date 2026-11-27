// DB 종류(방언)마다 되는 기능. 화면(메뉴·단추 숨기기)과 메인(막기)이 같이 본다
import type { ConnectionConfig, Dialect, DriverKind } from './types'

export interface Features {
  /** 트랜잭션 (수동 커밋, 저장·가져오기 실패 시 되돌리기). ClickHouse는 없다 */
  transactions: boolean
  /** CREATE·ALTER도 트랜잭션으로 되돌릴 수 있다 (MySQL·Oracle은 DDL마다 자동 커밋) */
  transactionalDdl: boolean
  /** 표 데이터를 행 하나씩 고치기 (ClickHouse는 한 행만 정확히 고치는 방법이 없다) */
  editRows: boolean
  /** 키 없는 표의 행을 찾는 숨은 열 ('' = 없음 → 모든 열로 찾기) */
  rowid: string
  /** 외래 키 */
  foreignKeys: boolean
  /** 서버가 있는 DB: 세션 관리자·서버 상태·사용자·권한 */
  server: boolean
  /** 실행 중인 쿼리만 취소 (SQL Server는 세션을 끊어야) */
  cancelQuery: boolean
  /** 뷰 이름 바꾸기 (SQLite는 못 함) */
  renameView: boolean
  /** SQL 편집기에서 스키마를 고른다 (PostgreSQL·Oracle·DuckDB — SQL Server는 dbo로) */
  schemaPicker: boolean
  /** 자동 증가 열 (DuckDB·ClickHouse는 없음) */
  autoIncrement: boolean
  /** 표 설계의 인덱스 (ClickHouse는 다른 개념이라 설계 화면에서 다루지 않음) */
  designIndexes: boolean
}

const BASE: Features = { transactions: true, transactionalDdl: true, editRows: true, rowid: '', foreignKeys: true, server: true, cancelQuery: true, renameView: true, schemaPicker: false, autoIncrement: true, designIndexes: true }

export const FEATURES: Record<Dialect, Features> = {
  sqlite: { ...BASE, rowid: '_rowid_', server: false, renameView: false },
  mysql: { ...BASE, transactionalDdl: false },
  postgres: { ...BASE, schemaPicker: true },
  mssql: { ...BASE, cancelQuery: false },
  oracle: { ...BASE, transactionalDdl: false, rowid: 'ROWID', schemaPicker: true },
  clickhouse: { ...BASE, transactions: false, transactionalDdl: false, editRows: false, foreignKeys: false, autoIncrement: false, designIndexes: false },
  duckdb: { ...BASE, rowid: 'rowid', server: false, schemaPicker: true, autoIncrement: false },
}

export const features = (d: Dialect): Features => FEATURES[d]

/** DuckDB 기본 카탈로그 이름: 파일 이름의 첫 점 앞 ('shop.duckdb' → shop) */
export const duckCatalog = (file: string) => file.split(/[\\/]/).pop()!.split('.')[0] || 'main'

/** 새 편집기·탐색기의 처음 DB·스키마 */
export function defaultPlace(c: Pick<ConnectionConfig, 'driver' | 'database' | 'file' | 'user'>): { db: string; schema: string } {
  const k: DriverKind = c.driver
  if (k === 'sqlite') return { db: c.database || 'main', schema: '' }
  if (k === 'postgres') return { db: c.database || 'postgres', schema: 'public' }
  if (k === 'mssql') return { db: c.database || 'master', schema: 'dbo' }
  // Oracle 스키마 = 사용자 (따옴표 없이 만든 이름은 대문자)
  if (k === 'oracle') return { db: c.database, schema: c.user.toUpperCase() }
  if (k === 'clickhouse') return { db: c.database || 'default', schema: '' }
  if (k === 'duckdb') return { db: duckCatalog(c.file), schema: 'main' }
  return { db: c.database, schema: '' }
}
