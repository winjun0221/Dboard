// 사용자·권한 SQL: 만들기·지우기·비밀번호·권한 주기/빼기. mask면 비밀번호를 ********로 (미리 보기·실행 기록용)
import { t } from './i18n'
import { quoteIdent } from './dialect'
import type { Dialect, UserAction } from './types'

export const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'] as const

function lit(d: Dialect, s: string): string {
  let v = s.replace(/'/g, "''")
  if (d === 'mysql' || d === 'clickhouse') v = v.replace(/\\/g, '\\\\')
  return d === 'mssql' ? `N'${v}'` : `'${v}'`
}

export function checkUserAction(a: UserAction): void {
  if (!a.name.trim()) throw new Error(t('사용자 이름을 적어 주세요'))
  if (a.kind === 'password' && !a.password) throw new Error(t('비밀번호를 적어 주세요'))
  if ((a.kind === 'grant' || a.kind === 'revoke') && !a.privileges.length) throw new Error(t('권한을 하나 이상 골라 주세요'))
}

export function userSql(d: Dialect, a: UserAction, mask: boolean): string[] {
  checkUserAction(a)
  const q = (n: string) => quoteIdent(d, n)
  const pw = (p: string) => (mask ? "'********'" : lit(d, p))
  const privs = (a.kind === 'grant' || a.kind === 'revoke')
    ? a.privileges.includes('ALL') ? (d === 'mssql' ? 'SELECT, INSERT, UPDATE, DELETE' : d === 'postgres' ? 'ALL PRIVILEGES' : 'ALL PRIVILEGES') : a.privileges.join(', ')
    : ''
  if (d === 'mysql') {
    const acct = `${lit(d, a.name)}@${lit(d, a.host || '%')}`
    if (a.kind === 'create') return [`CREATE USER ${acct}${a.password ? ` IDENTIFIED BY ${pw(a.password)}` : ''}`]
    if (a.kind === 'drop') return [`DROP USER ${acct}`]
    if (a.kind === 'password') return [`ALTER USER ${acct} IDENTIFIED BY ${pw(a.password)}`]
    const target = a.table ? `${q(a.db)}.${q(a.table)}` : `${q(a.db)}.*`
    return [a.kind === 'grant' ? `GRANT ${privs} ON ${target} TO ${acct}` : `REVOKE ${privs} ON ${target} FROM ${acct}`]
  }
  if (d === 'postgres') {
    const role = q(a.name)
    if (a.kind === 'create') return [`CREATE ROLE ${role}${a.login ? ' LOGIN' : ''}${a.password ? ` PASSWORD ${pw(a.password)}` : ''}`]
    if (a.kind === 'drop') return [`DROP ROLE ${role}`]
    if (a.kind === 'password') return [`ALTER ROLE ${role} PASSWORD ${pw(a.password)}`]
    const schema = q(a.schema || 'public')
    if (a.table) return [a.kind === 'grant' ? `GRANT ${privs} ON TABLE ${schema}.${q(a.table)} TO ${role}` : `REVOKE ${privs} ON TABLE ${schema}.${q(a.table)} FROM ${role}`]
    return a.kind === 'grant'
      ? [`GRANT USAGE ON SCHEMA ${schema} TO ${role}`, `GRANT ${privs} ON ALL TABLES IN SCHEMA ${schema} TO ${role}`]
      : [`REVOKE ${privs} ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`]
  }
  if (d === 'mssql') {
    const login = q(a.name)
    const name = lit(d, a.name)
    if (a.kind === 'create') {
      if (!a.password) throw new Error(t('비밀번호를 적어 주세요'))
      return [`CREATE LOGIN ${login} WITH PASSWORD = ${pw(a.password)}`, `CREATE USER ${login} FOR LOGIN ${login}`]
    }
    if (a.kind === 'drop') return [`IF USER_ID(${name}) IS NOT NULL DROP USER ${login}`, `DROP LOGIN ${login}`]
    if (a.kind === 'password') return [`ALTER LOGIN ${login} WITH PASSWORD = ${pw(a.password)}`]
    const target = a.table ? `${q(a.schema || 'dbo')}.${q(a.table)}` : `SCHEMA::${q(a.schema || 'dbo')}`
    return a.kind === 'grant'
      ? [`IF USER_ID(${name}) IS NULL CREATE USER ${login} FOR LOGIN ${login}`, `GRANT ${privs} ON ${target} TO ${login}`]
      : [`REVOKE ${privs} ON ${target} FROM ${login}`]
  }
  if (d === 'oracle') {
    const user = q(a.name)
    // Oracle 비밀번호는 큰따옴표로 감싼다 (안에 "는 못 씀)
    const opw = (p: string) => {
      if (p.includes('"')) throw new Error(t('Oracle 비밀번호에는 큰따옴표(")를 쓸 수 없어요'))
      return mask ? '"********"' : `"${p}"`
    }
    if (a.kind === 'create') {
      if (!a.password) throw new Error(t('비밀번호를 적어 주세요'))
      return [`CREATE USER ${user} IDENTIFIED BY ${opw(a.password)}`, `GRANT CREATE SESSION TO ${user}`]
    }
    if (a.kind === 'drop') return [`DROP USER ${user} CASCADE`]
    if (a.kind === 'password') return [`ALTER USER ${user} IDENTIFIED BY ${opw(a.password)}`]
    const p = a.privileges.includes('ALL') ? 'ALL' : privs
    if (a.table) {
      const target = `${q(a.schema)}.${q(a.table)}`
      return [a.kind === 'grant' ? `GRANT ${p} ON ${target} TO ${user}` : `REVOKE ${p} ON ${target} FROM ${user}`]
    }
    // 스키마 전체: 19c까지는 스키마 단위 권한이 없어서 표·뷰마다 (빼기는 안 준 권한이면 넘어간다)
    const head = `${a.kind === 'grant' ? 'GRANT' : 'REVOKE'} ${p} ON ${q(a.schema)}."`
    const tail = `" ${a.kind === 'grant' ? 'TO' : 'FROM'} ${user}`
    const exec = `EXECUTE IMMEDIATE ${lit(d, head)} || REPLACE(o.object_name, '"', '""') || ${lit(d, tail)};`
    return [
      `BEGIN\n  FOR o IN (SELECT object_name FROM all_objects WHERE owner = ${lit(d, a.schema)} AND object_type IN ('TABLE', 'VIEW')) LOOP\n    ` +
        (a.kind === 'grant' ? exec : `BEGIN ${exec} EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1927 THEN RAISE; END IF; END;`) +
        `\n  END LOOP;\nEND;`,
    ]
  }
  if (d === 'clickhouse') {
    const user = q(a.name)
    if (a.kind === 'create') return [`CREATE USER ${user}${a.password ? ` IDENTIFIED BY ${pw(a.password)}` : ' NOT IDENTIFIED'}`]
    if (a.kind === 'drop') return [`DROP USER ${user}`]
    if (a.kind === 'password') return [`ALTER USER ${user} IDENTIFIED BY ${pw(a.password)}`]
    // ClickHouse의 UPDATE·DELETE 권한 이름은 ALTER UPDATE·ALTER DELETE
    const p = a.privileges.includes('ALL') ? 'ALL' : a.privileges.map((x) => (x === 'UPDATE' || x === 'DELETE' ? 'ALTER ' + x : x)).join(', ')
    const target = `${q(a.db)}.${a.table ? q(a.table) : '*'}`
    return [a.kind === 'grant' ? `GRANT ${p} ON ${target} TO ${user}` : `REVOKE ${p} ON ${target} FROM ${user}`]
  }
  throw new Error(t('이 DB에는 사용자가 없어요'))
}
