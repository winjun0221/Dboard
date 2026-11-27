// 2단계: 표 설계(새 표·ALTER)·이름 바꾸기·비우기·지우기 — 실제 DB 서버(Docker). npm run test:db 로 돌린다
import { describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import { runStatements } from '../src/main/dump'
import { designSql, dropExtraSql, objectSql } from '../src/shared/alter'
import { quoteIdent } from '../src/shared/dialect'
import type { DesignColumn, DriverKind, TableDesign } from '../src/shared/types'
import { config, memoryKeys, resolved } from './exercise'

const ON = process.env.DBOARD_TEST_DBS === '1'
const rand = () => Math.random().toString(36).slice(2, 8)
const col = (name: string, type: string, o: Partial<DesignColumn> = {}): DesignColumn => ({ name, type, nullable: true, default: '', autoIncrement: false, comment: '', generated: false, orig: null, ...o })
const clone = (x: TableDesign): TableDesign => JSON.parse(JSON.stringify(x)) as TableDesign

const TYPES = {
  mysql: { int: 'INT', big: 'BIGINT', text: 'VARCHAR(100)', str: (s: string) => `'${s}'` },
  postgres: { int: 'integer', big: 'bigint', text: 'varchar(100)', str: (s: string) => `'${s}'` },
  mssql: { int: 'int', big: 'bigint', text: 'nvarchar(100)', str: (s: string) => `N'${s}'` },
}

const EXTRA_SQL = {
  mysql: [
    'CREATE PROCEDURE p_one() SELECT 1',
    'CREATE FUNCTION f_one(x INT) RETURNS INT DETERMINISTIC RETURN x + 1',
    'CREATE TRIGGER tr_one BEFORE INSERT ON parent FOR EACH ROW SET NEW.name = NEW.name',
  ],
  postgres: [
    'CREATE FUNCTION f_one(x int) RETURNS int LANGUAGE sql AS $$ SELECT x + 1 $$',
    'CREATE PROCEDURE p_one() LANGUAGE sql AS $$ SELECT 1 $$',
    'CREATE FUNCTION tr_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
    'CREATE TRIGGER tr_one BEFORE INSERT ON parent FOR EACH ROW EXECUTE FUNCTION tr_fn()',
    'CREATE SEQUENCE s_one START 5',
  ],
  mssql: [
    'CREATE PROCEDURE p_one AS SELECT 1',
    'CREATE FUNCTION f_one(@x INT) RETURNS INT AS BEGIN RETURN @x + 1 END',
    'CREATE TRIGGER tr_one ON parent AFTER INSERT AS SET NOCOUNT ON',
    'CREATE SEQUENCE s_one START WITH 5',
  ],
}

describe.skipIf(!ON)('stage 2 on real servers', () => {
  for (const kind of ['mysql', 'mariadb', 'postgres', 'mssql'] as DriverKind[]) {
    it(kind, async () => {
      const m = new Manager(memoryKeys())
      const d = kind === 'mariadb' ? 'mysql' : (kind as 'mysql' | 'postgres' | 'mssql')
      const T = TYPES[d]
      const db = 'dboard_s2_' + rand()
      const base = kind === 'postgres' ? config('postgres', { database: 'dboard_test' }) : config(kind)
      const schema = kind === 'postgres' ? 'public' : kind === 'mssql' ? 'dbo' : ''
      const W = { db, schema }
      const admin = await m.connect('admin', resolved(base))
      const adminExec = async (sql: string) => (await admin.metaSession(kind === 'postgres' ? 'dboard_test' : undefined)).exec(sql)
      try {
        await adminExec(`CREATE DATABASE ${quoteIdent(d, db)}`)
        // PostgreSQL은 DB마다 연결 → 새 DB로 접속
        await m.connect('x', resolved(kind === 'postgres' ? config('postgres', { database: db }) : base))
        const live = m.get('x')
        const design = async (table: string) => live.mod.design(await live.metaSession(db), { db, schema, table })
        const run = async (list: string[]) => {
          const s = await m.editorSession('x', 'ddl', db, schema)
          try {
            await runStatements(s, d, list)
          } finally {
            await m.closeEditor('ddl')
          }
        }
        const work = await m.editorSession('x', 'work', db, schema)
        const q = (n: string) => quoteIdent(d, n)

        // 새 표 두 개 (자동 증가 기본 키 · 외래 키 · 인덱스 · 설명)
        const parent: TableDesign = {
          name: 'parent', comment: 'parents', primaryKey: ['id'], pkName: '', unsupported: [], indexes: [], foreignKeys: [],
          columns: [col('id', T.int, { nullable: false, autoIncrement: true }), col('name', T.text, { nullable: false, default: T.str('none'), comment: 'the name' })],
        }
        await run(designSql(d, W, null, parent).statements)
        const child: TableDesign = {
          name: 'child', comment: '', primaryKey: ['id'], pkName: '', unsupported: [],
          columns: [col('id', T.int, { nullable: false }), col('parent_id', T.int), col('qty', T.int, { default: '1' }), col('old', T.text)],
          indexes: [{ name: 'child_qty', columns: ['qty'], unique: false, orig: null }],
          foreignKeys: [{ name: 'fk_child_parent', columns: ['parent_id'], refSchema: '', refTable: 'parent', refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION', orig: null }],
        }
        await run(designSql(d, W, null, child).statements)
        await work.run(`INSERT INTO ${q('parent')} (${q('name')}) VALUES (${T.str('p1')})`, 1)
        await work.run(`INSERT INTO ${q('parent')} (${q('name')}) VALUES (${T.str('p2')})`, 1)
        await work.run(`INSERT INTO ${q('child')} (${q('id')}, ${q('parent_id')}, ${q('old')}) VALUES (1, 1, ${T.str('o')})`, 1)

        // 프로시저·함수·트리거·시퀀스: 목록 · 원본 · 지우기
        for (const sql of EXTRA_SQL[d]) await work.run(sql, 1)
        const meta = async () => live.mod.extras(await live.metaSession(db), db, schema)
        const ours = (list: Awaited<ReturnType<typeof meta>>) => list.filter((e) => ['p_one', 'f_one', 'tr_one', 's_one'].includes(e.name))
        const ex = ours(await meta())
        const names = ex.map((e) => `${e.kind}:${e.name}`)
        expect(names).toEqual(expect.arrayContaining(['procedure:p_one', 'function:f_one', 'trigger:tr_one']))
        if (d !== 'mysql') expect(names).toContain('sequence:s_one')
        expect(ex.find((e) => e.name === 'tr_one')?.table).toBe('parent')
        for (const e of ex) {
          const src = await live.mod.source(await live.metaSession(db), db, schema, e.kind, e.id)
          expect(src).toMatch(/CREATE/i)
          expect(src).toContain(e.name)
        }
        for (const e of ex) await run([dropExtraSql(d, W, e)])
        expect(ours(await meta())).toEqual([])

        const p = await design('parent')
        expect(p.columns[0].autoIncrement).toBe(true)
        expect(p.columns[1]).toMatchObject({ nullable: false, comment: 'the name' })
        expect(p.columns[1].default).toMatch(/none/)
        expect(p.comment).toBe('parents')
        const before = await design('child')
        expect(before.primaryKey).toEqual(['id'])
        expect(before.indexes.map((i) => i.name)).toContain('child_qty')
        expect(before.foreignKeys[0]).toMatchObject({ name: 'fk_child_parent', columns: ['parent_id'], refTable: 'parent', refColumns: ['id'] })
        expect(before.columns.find((c) => c.name === 'qty')?.default).toMatch(/1/)

        // 고치기: 열 이름·타입·NULL·기본값·설명, 열 추가·지우기, 인덱스, 외래 키 동작, 기본 키, 표 이름
        const after = clone(before)
        const qty = after.columns.find((c) => c.name === 'qty')!
        qty.name = 'amount'
        qty.type = T.big
        qty.nullable = false
        qty.default = '5'
        qty.comment = 'how many'
        after.columns = after.columns.filter((c) => c.name !== 'old')
        after.columns.push(col('note', T.text, { default: T.str('n') }))
        after.indexes = [{ name: 'child_amount', columns: ['amount'], unique: false, orig: null }]
        after.foreignKeys[0].onDelete = 'CASCADE'
        after.primaryKey = ['id', 'amount']
        after.comment = 'kids'
        after.name = 'children'
        await run(designSql(d, W, before, after).statements)

        const x = await design('children')
        expect(x.columns.map((c) => c.name)).toEqual(['id', 'parent_id', 'amount', 'note'])
        const amount = x.columns.find((c) => c.name === 'amount')!
        expect(amount.type.toLowerCase()).toContain('bigint')
        expect(amount).toMatchObject({ nullable: false, comment: 'how many' })
        expect(amount.default).toMatch(/5/)
        expect(x.primaryKey).toEqual(['id', 'amount'])
        expect(x.indexes.map((i) => i.name)).toContain('child_amount')
        expect(x.indexes.map((i) => i.name)).not.toContain('child_qty')
        expect(x.foreignKeys[0].onDelete).toBe('CASCADE')
        expect(x.comment).toBe('kids')
        const r = await work.query(`SELECT ${q('id')}, ${q('amount')}, ${q('note')} FROM ${q('children')}`)
        expect(r.rows.map((row) => row.map(String))).toEqual([['1', '1', 'n']])

        // 외래 키 지우기 · 기본값 없애기 · NULL 허용으로
        const again = clone(x)
        again.foreignKeys = []
        const am = again.columns.find((c) => c.name === 'amount')!
        am.default = ''
        await run(designSql(d, W, x, again).statements)
        const y = await design('children')
        expect(y.foreignKeys).toEqual([])
        expect(y.columns.find((c) => c.name === 'amount')?.default).toBe('')

        // 세션 관리자: 목록에 다른 연결이 보이고, 끊으면 그 연결은 더 못 쓴다
        const victim = await m.editorSession('x', 'victim', db, schema)
        const idSql = { mysql: 'SELECT CONNECTION_ID()', postgres: 'SELECT pg_backend_pid()', mssql: 'SELECT @@SPID' }[d]
        const vid = String((await victim.query(idSql)).rows[0][0])
        const sessions = await live.mod.sessions!.list(await live.metaSession(db))
        expect(sessions.some((x) => x.own)).toBe(true)
        expect(sessions.map((x) => x.id)).toContain(vid)
        await live.mod.sessions!.kill(await live.metaSession(db), vid, false)
        await expect(victim.query('SELECT 1')).rejects.toThrow()
        await m.closeEditor('victim')

        // 이름 바꾸기 · 비우기 · 지우기
        await run(objectSql(d, { db, schema, table: 'children' }, 'table', 'rename', 'kids'))
        await run(objectSql(d, { db, schema, table: 'kids' }, 'table', 'truncate'))
        expect(Number((await work.query(`SELECT COUNT(*) FROM ${q('kids')}`)).rows[0][0])).toBe(0)
        await run(objectSql(d, { db, schema, table: 'kids' }, 'table', 'drop'))
        await expect(design('kids')).rejects.toThrow()
      } finally {
        await m.disconnect('x').catch(() => undefined)
        await adminExec(d === 'mssql' ? `ALTER DATABASE ${quoteIdent(d, db)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${quoteIdent(d, db)}` : `DROP DATABASE ${quoteIdent(d, db)}`).catch((e) => console.warn(String(e)))
        await m.disconnectAll()
      }
    })
  }
})
