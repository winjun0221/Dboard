// 3-2단계: 전체 검색 · 서버 상태 · 사용자·권한 — 실제 DB 서버(Docker). npm run test:db 로 돌린다
import { describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import { runStatements } from '../src/main/dump'
import { searchData, searchNames } from '../src/main/search'
import { quoteIdent } from '../src/shared/dialect'
import { userSql } from '../src/shared/users'
import type { DriverKind } from '../src/shared/types'
import { config, memoryKeys, resolved } from './exercise'

const ON = process.env.DBOARD_TEST_DBS === '1'
const rand = () => Math.random().toString(36).slice(2, 8)
const O = { showSystem: false }

describe.skipIf(!ON)('stage 3-2 on real servers', () => {
  for (const kind of ['mysql', 'mariadb', 'postgres', 'mssql'] as DriverKind[]) {
    it(kind, async () => {
      const m = new Manager(memoryKeys())
      const d = kind === 'mariadb' ? 'mysql' : (kind as 'mysql' | 'postgres' | 'mssql')
      const db = 'dboard_s32_' + rand()
      const user = 'dbu_' + rand()
      const base = kind === 'postgres' ? config('postgres', { database: 'dboard_test' }) : config(kind)
      const schema = kind === 'postgres' ? 'public' : kind === 'mssql' ? 'dbo' : ''
      const admin = await m.connect('admin', resolved(base))
      const adminExec = async (sql: string) => (await admin.metaSession(kind === 'postgres' ? 'dboard_test' : undefined)).exec(sql)
      try {
        await adminExec(`CREATE DATABASE ${quoteIdent(d, db)}`)
        await m.connect('x', resolved(kind === 'postgres' ? config('postgres', { database: db }) : base))
        const live = m.get('x')
        const s = await m.editorSession('x', 'w', db, schema)
        const text = d === 'mssql' ? 'NVARCHAR(50)' : 'VARCHAR(50)'
        await s.run(`CREATE TABLE gadget_box (id INT PRIMARY KEY, label ${text}, gadget_note ${text})`, 1)
        await s.run(`INSERT INTO gadget_box VALUES (1, ${d === 'mssql' ? "N'blue widget'" : "'blue widget'"}, NULL), (2, ${d === 'mssql' ? "N'red'" : "'red'"}, ${d === 'mssql' ? "N'widget!'" : "'widget!'"})`, 1)

        // 이름 찾기 (표·열) · 데이터 찾기
        const meta = await live.metaSession(db)
        const hits = await searchNames(live.mod, async () => meta, [db], 'gadget', O)
        expect(hits.map((h) => `${h.kind}:${h.table}.${h.name}`)).toEqual(expect.arrayContaining(['table:gadget_box.gadget_box', 'column:gadget_box.gadget_note']))
        const data = await searchData(live.mod, meta, db, schema, 'WIDGET', O, () => false)
        expect(data).toEqual([expect.objectContaining({ table: 'gadget_box', count: 2, error: null })])

        // 서버 상태
        const st = await live.mod.stats!(await live.metaSession())
        expect(st.gauges.connections).toBeGreaterThan(0)
        expect(Object.keys(st.counters).length).toBeGreaterThan(0)

        // 사용자: 만들기 → 권한 주기 → 권한 보기 → 비밀번호 바꾸기 → 권한 빼기 → 지우기
        const pw = 'Dboard_u1!' + rand()
        const run = async (list: string[]) => {
          const ss = await m.editorSession('x', 'usr', db, schema)
          try {
            await runStatements(ss, d, list)
          } finally {
            await m.closeEditor('usr')
          }
        }
        await run(userSql(d, { kind: 'create', name: user, host: '%', password: pw, login: true }, false))
        expect((await live.mod.users!.list(await live.metaSession())).some((u) => u.name === user)).toBe(true)
        await run(userSql(d, { kind: 'grant', name: user, host: '%', privileges: ['SELECT'], db, schema, table: '' }, false))
        const g = await live.mod.users!.grants(await live.metaSession(db), user, '%', db)
        expect(g.join('\n')).toMatch(/SELECT/)
        await run(userSql(d, { kind: 'password', name: user, host: '%', password: pw + 'x' }, false))
        // 새 비밀번호로 붙어진다 (SQL Server는 기본 DB 권한 때문에 생략)
        if (d !== 'mssql') {
          await m.connect('u', { ...resolved(kind === 'postgres' ? config('postgres', { database: db, user }) : config(kind, { user, database: db })), password: pw + 'x' })
          const us = await m.editorSession('u', 'q', db, schema)
          expect(Number((await us.query('SELECT COUNT(*) FROM gadget_box')).rows[0][0])).toBe(2)
          await m.disconnect('u')
        }
        await run(userSql(d, { kind: 'revoke', name: user, host: '%', privileges: ['SELECT'], db, schema, table: '' }, false))
        // PostgreSQL은 권한이 남아 있으면 역할을 못 지운다 → USAGE도 빼고
        if (d === 'postgres') await run([`REVOKE USAGE ON SCHEMA public FROM ${quoteIdent(d, user)}`])
        await run(userSql(d, { kind: 'drop', name: user, host: '%' }, false))
        expect((await live.mod.users!.list(await live.metaSession())).some((u) => u.name === user)).toBe(false)
      } finally {
        await m.disconnect('x').catch(() => undefined)
        await adminExec(d === 'mssql' ? `ALTER DATABASE ${quoteIdent(d, db)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${quoteIdent(d, db)}` : `DROP DATABASE ${quoteIdent(d, db)}`).catch((e) => console.warn(String(e)))
        await adminExec(d === 'mssql' ? `IF SUSER_ID(N'${user}') IS NOT NULL DROP LOGIN [${user}]` : d === 'postgres' ? `DROP ROLE IF EXISTS "${user}"` : `DROP USER IF EXISTS '${user}'@'%'`).catch(() => undefined)
        await m.disconnectAll()
      }
    })
  }
})
