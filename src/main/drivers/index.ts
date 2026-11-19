// DB 종류 → 드라이버 모듈. 새 종류는 여기에 등록 (shared/types.ts의 DriverKind·dialectOf도)
import type { DriverKind } from '../../shared/types'
import type { DriverModule } from './base'
import { mssqlDriver } from './mssql'
import { mysqlDriver } from './mysql'
import { postgresDriver } from './postgres'
import { sqliteDriver } from './sqlite'

const DRIVERS: Record<DriverKind, DriverModule> = {
  sqlite: sqliteDriver,
  mysql: mysqlDriver,
  mariadb: mysqlDriver,
  postgres: postgresDriver,
  mssql: mssqlDriver,
}

export function driverOf(kind: DriverKind): DriverModule {
  return DRIVERS[kind]
}
