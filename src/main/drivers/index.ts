// DB 종류 → 드라이버 모듈. 새 종류는 여기에 등록 (shared/types.ts의 DriverKind·dialectOf, shared/features.ts도)
import type { DriverKind } from '../../shared/types'
import type { DriverModule } from './base'
import { clickhouseDriver } from './clickhouse'
import { duckdbDriver } from './duckdb'
import { mssqlDriver } from './mssql'
import { mysqlDriver } from './mysql'
import { oracleDriver } from './oracle'
import { postgresDriver } from './postgres'
import { sqliteDriver } from './sqlite'

const DRIVERS: Record<DriverKind, DriverModule> = {
  sqlite: sqliteDriver,
  mysql: mysqlDriver,
  mariadb: mysqlDriver,
  postgres: postgresDriver,
  mssql: mssqlDriver,
  oracle: oracleDriver,
  clickhouse: clickhouseDriver,
  duckdb: duckdbDriver,
}

export function driverOf(kind: DriverKind): DriverModule {
  return DRIVERS[kind]
}
