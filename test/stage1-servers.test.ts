// 수동 커밋 · 실행 계획 · 외래 키 · 읽기 전용 — 실제 DB 서버(Docker). npm run test:db 로 돌린다 (DBOARD_TEST_DBS=1 없으면 건너뜀)
import { describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import { explain } from '../src/main/explain'
import { quoteIdent } from '../src/shared/dialect'
import type { DriverKind } from '../src/shared/types'
import { config, memoryKeys, resolved } from './exercise'

const ON = process.env.DBOARD_TEST_DBS === '1'
const rand = () => Math.random().toString(36).slice(2, 8)

const SETUP: Record<'mysql' | 'postgres' | 'mssql', string[]> = {
  mysql: [
    'CREATE TABLE pair (x INT, y INT, PRIMARY KEY (x, y)) ENGINE=InnoDB',
    'CREATE TABLE parent (id INT PRIMARY KEY, name VARCHAR(50)) ENGINE=InnoDB',
    'CREATE TABLE child (id INT PRIMARY KEY, parent_id INT, a INT, b INT, FOREIGN KEY (parent_id) REFERENCES parent (id), FOREIGN KEY (a, b) REFERENCES pair (x, y)) ENGINE=InnoDB',
    "INSERT INTO parent VALUES (1, 'p1'), (2, 'p2')",
  ],
  postgres: [
    'CREATE TABLE pair (x int, y int, PRIMARY KEY (x, y))',
    'CREATE TABLE parent (id int PRIMARY KEY, name text)',
    'CREATE TABLE child (id int PRIMARY KEY, parent_id int REFERENCES parent (id), a int, b int, FOREIGN KEY (a, b) REFERENCES pair (x, y))',
    "INSERT INTO parent VALUES (1, 'p1'), (2, 'p2')",
  ],
  mssql: [
    'CREATE TABLE pair (x INT, y INT, PRIMARY KEY (x, y))',
    'CREATE TABLE parent (id INT PRIMARY KEY, name NVARCHAR(50))',
    'CREATE TABLE child (id INT PRIMARY KEY, parent_id INT REFERENCES parent (id), a INT, b INT, FOREIGN KEY (a, b) REFERENCES pair (x, y))',
    "INSERT INTO parent VALUES (1, N'p1'), (2, N'p2')",
  ],
}

describe.skipIf(!ON)('stage 1 on real servers', () => {
  for (const kind of ['mysql', 'mariadb', 'postgres', 'mssql'] as DriverKind[]) {
    it(kind, async () => {
      const m = new Manager(memoryKeys())
      const d = kind === 'mariadb' ? 'mysql' : (kind as 'mysql' | 'postgres' | 'mssql')
      const db = 'dboard_s1_' + rand()
      const base = kind === 'postgres' ? config('postgres', { database: 'dboard_test' }) : config(kind)
      const schema = kind === 'postgres' ? 'public' : kind === 'mssql' ? 'dbo' : ''
      const admin = await m.connect('admin', resolved(base))
      const adminExec = async (sql: string) => (await admin.metaSession(kind === 'postgres' ? 'dboard_test' : undefined)).exec(sql)
      try {
        await adminExec(`CREATE DATABASE ${quoteIdent(d, db)}`)
        await m.connect('x', resolved(base))
        const setup = await m.editorSession('x', 'setup', db, schema)
        for (const q of SETUP[d]) await setup.run(q, 10)
        const other = async () => Number((await setup.query('SELECT COUNT(*) FROM parent')).rows[0][0])

        // 수동 커밋: 커밋 전에는 다른 연결에서 안 보이고, 롤백하면 사라진다
        const ed = await m.editorSession('x', 'ed', db, schema)
        await ed.setManualCommit(true)
        await ed.runManaged(`INSERT INTO parent VALUES (3, ${d === 'mssql' ? "N'p3'" : "'p3'"})`, 10)
        expect(Number((await ed.query('SELECT COUNT(*) FROM parent')).rows[0][0])).toBe(3)
        // 다른 연결은 잠긴 행을 기다리지 않게 커밋되지 않은 것을 건너뛰는 COUNT
        await ed.endTransaction(true)
        expect(await other()).toBe(3)
        await ed.runManaged('DELETE FROM parent WHERE id = 3', 10)
        // 오류가 나도 앞의 작업(DELETE)은 트랜잭션 안에 남는다 (PostgreSQL은 SAVEPOINT 덕분)
        await expect(ed.runManaged('INSERT INTO nope VALUES (1)', 10)).rejects.toThrow()
        expect(Number((await ed.query('SELECT COUNT(*) FROM parent')).rows[0][0])).toBe(2)
        await ed.endTransaction(false)
        expect(await other()).toBe(3)
        await ed.setManualCommit(false)
        await ed.runManaged('DELETE FROM parent WHERE id = 3', 10)
        expect(await other()).toBe(2)

        // 실행 계획 (실행하지 않음)
        const plan = await explain(ed, 'SELECT * FROM child JOIN parent ON parent.id = child.parent_id WHERE parent.id = 1')
        expect(plan.text || plan.result?.rows.length).toBeTruthy()
        await explain(ed, 'DELETE FROM parent')
        expect(await other()).toBe(2)

        // 외래 키 (여러 열 포함)
        const live = m.get('x')
        const fks = await live.mod.foreignKeys(await live.metaSession(db), { db, schema, table: 'child' })
        const byTable = Object.fromEntries(fks.map((f) => [f.ref.table, f]))
        expect(byTable.parent).toMatchObject({ columns: ['parent_id'], refColumns: ['id'] })
        expect(byTable.pair).toMatchObject({ columns: ['a', 'b'], refColumns: ['x', 'y'] })
        expect(byTable.parent.ref.db).toBe(db)

        // 읽기 전용 접속: MySQL·PostgreSQL은 서버가 막는다 (SQL Server는 메인의 문장 검사로만)
        if (d !== 'mssql') {
          await m.connect('ro', resolved({ ...base, readOnly: true }))
          const ro = await m.editorSession('ro', 'ro', db, schema)
          expect(Number((await ro.query('SELECT COUNT(*) FROM parent')).rows[0][0])).toBe(2)
          await expect(ro.run('DELETE FROM parent', 10)).rejects.toThrow()
          await m.disconnect('ro')
        }
      } finally {
        await m.disconnect('x').catch(() => undefined)
        await adminExec(d === 'mssql' ? `ALTER DATABASE ${quoteIdent(d, db)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${quoteIdent(d, db)}` : `DROP DATABASE ${quoteIdent(d, db)}`).catch((e) => console.warn(String(e)))
        await m.disconnectAll()
      }
    })
  }
})
