// 2단계: 표 설계(ALTER·새 표·SQLite 다시 만들기)·이름 바꾸기·비우기·지우기 (SQLite. 서버 DB는 stage2-servers.test.ts)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import { runStatements } from '../src/main/dump'
import { designSql, dropExtraSql, objectSql } from '../src/shared/alter'
import { bindParams, findParams } from '../src/shared/sql'
import type { TableDesign } from '../src/shared/types'
import { config, memoryKeys, resolved } from './exercise'

let dir = ''
let m: Manager
const W = { db: 'main', schema: '' }
const ref = (table: string) => ({ db: 'main', schema: '', table })
const session = () => m.editorSession('db', 'work', 'main', '')
const rows = async (sql: string) => (await (await session()).query(sql)).rows
const design = async (table: string) => {
  const live = m.get('db')
  return live.mod.design(await live.metaSession('main'), ref(table))
}
const apply = async (before: TableDesign | null, after: TableDesign) => {
  const r = designSql('sqlite', W, before, after)
  const s = await m.editorSession('db', 'ddl', 'main', '')
  try {
    await runStatements(s, 'sqlite', r.statements)
  } finally {
    await m.closeEditor('ddl')
  }
  return r
}
const clone = (x: TableDesign): TableDesign => JSON.parse(JSON.stringify(x)) as TableDesign

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dboard-s2-'))
  const file = path.join(dir, 'x.db')
  fs.writeFileSync(file, '')
  m = new Manager(memoryKeys())
  await m.connect('db', resolved(config('sqlite', { file })))
  const s = await session()
  for (const q of [
    'CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)',
    "CREATE TABLE item (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE, title TEXT DEFAULT 'x', qty INT, code TEXT UNIQUE)",
    'CREATE INDEX item_qty ON item (qty)',
    'CREATE INDEX item_lower ON item (lower(title))',
    'CREATE TABLE log (n INT)',
    "CREATE TRIGGER item_ins AFTER INSERT ON item BEGIN INSERT INTO log VALUES (NEW.id); END",
    'CREATE VIEW item_view AS SELECT id, title FROM item',
    "INSERT INTO parent (name) VALUES ('p1'), ('p2')",
    "INSERT INTO item (parent_id, title, qty, code) VALUES (1, 'a', 3, 'c1'), (2, 'b', 5, 'c2')",
  ]) await s.run(q, 10)
})

afterEach(async () => {
  await m.disconnectAll()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('table design (sqlite)', () => {
  it('reads columns, keys, indexes, foreign keys and triggers', async () => {
    const d = await design('item')
    expect(d.columns.map((c) => c.name)).toEqual(['id', 'parent_id', 'title', 'qty', 'code'])
    expect(d.columns.find((c) => c.name === 'title')?.default).toBe("'x'")
    expect(d.primaryKey).toEqual(['id'])
    expect(d.indexes.find((i) => i.name === 'item_qty')).toMatchObject({ columns: ['qty'], unique: false })
    expect(d.indexes.find((i) => i.constraint)?.columns).toEqual(['code'])
    expect(d.foreignKeys).toEqual([expect.objectContaining({ columns: ['parent_id'], refTable: 'parent', refColumns: ['id'], onDelete: 'CASCADE' })])
    expect(d.triggers?.length).toBe(1)
    expect(d.unsupported).toEqual([])
    expect((await design('parent')).columns[0].autoIncrement).toBe(true)
  })

  it('adds, renames and drops columns and indexes with ALTER', async () => {
    const before = await design('item')
    const after = clone(before)
    after.columns.find((c) => c.name === 'title')!.name = 'label'
    after.columns = after.columns.filter((c) => c.name !== 'qty')
    after.indexes = after.indexes.filter((i) => i.name !== 'item_qty')
    after.columns.push({ name: 'note', type: 'TEXT', nullable: true, default: "'n'", autoIncrement: false, comment: '', generated: false, orig: null })
    after.indexes.push({ name: 'item_note', columns: ['note'], unique: false, orig: null })
    const r = await apply(before, after)
    expect(r.statements.join('\n')).not.toMatch(/_dboard_new_/)
    const d = await design('item')
    expect(d.columns.map((c) => c.name)).toEqual(['id', 'parent_id', 'label', 'code', 'note'])
    expect(d.indexes.map((i) => i.name)).toContain('item_note')
    expect(await rows('SELECT label, note FROM item ORDER BY id')).toEqual([['a', 'n'], ['b', 'n']])
  })

  it('rebuilds the table for type, NULL, default, key and foreign key changes, keeping data, indexes, triggers and views', async () => {
    const before = await design('item')
    const after = clone(before)
    const qty = after.columns.find((c) => c.name === 'qty')!
    qty.type = 'REAL'
    qty.nullable = false
    qty.default = '0'
    after.foreignKeys[0].onDelete = 'SET NULL'
    after.name = 'items'
    const r = await apply(before, after)
    expect(r.statements[0]).toBe('PRAGMA foreign_keys = OFF')
    expect(r.warnings.length).toBe(1)
    const d = await design('items')
    expect(d.columns.find((c) => c.name === 'qty')).toMatchObject({ type: 'REAL', nullable: false, default: '0' })
    expect(d.foreignKeys[0].onDelete).toBe('SET NULL')
    expect(d.indexes.map((i) => i.name).sort()).toEqual(expect.arrayContaining(['item_lower', 'item_qty']))
    expect(d.indexes.some((i) => i.unique && i.columns[0] === 'code')).toBe(true)
    expect(d.triggers?.length).toBe(1)
    expect(await rows('SELECT id, title, qty FROM items ORDER BY id')).toEqual([[1, 'a', 3], [2, 'b', 5]])
    // 이름이 바뀐 표를 뷰·트리거가 따라간다
    expect(await rows('SELECT COUNT(*) FROM item_view')).toEqual([[2]])
    await (await session()).run("INSERT INTO items (parent_id, title, qty, code) VALUES (1, 'c', 1, 'c3')", 1)
    expect(await rows('SELECT COUNT(*) FROM log')).toEqual([[3]])
    // UNIQUE는 그대로 지켜진다
    await expect((await session()).run("INSERT INTO items (code) VALUES ('c1')", 1)).rejects.toThrow()
  })

  it('changes the primary key by rebuilding', async () => {
    const before = await design('item')
    const after = clone(before)
    after.primaryKey = ['id', 'parent_id']
    await apply(before, after)
    expect((await design('item')).primaryKey).toEqual(['id', 'parent_id'])
    expect(await rows('SELECT COUNT(*) FROM item')).toEqual([[2]])
  })

  it('creates a new table with an autoincrement key, a foreign key and an index', async () => {
    const x: TableDesign = {
      name: 'order line', comment: '', primaryKey: ['id'], pkName: '', unsupported: [],
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, default: '', autoIncrement: true, comment: '', generated: false, orig: null },
        { name: 'parent_id', type: 'INTEGER', nullable: true, default: '', autoIncrement: false, comment: '', generated: false, orig: null },
        { name: 'at', type: 'TEXT', nullable: true, default: "datetime('now')", autoIncrement: false, comment: '', generated: false, orig: null },
      ],
      indexes: [{ name: 'ol_parent', columns: ['parent_id'], unique: false, orig: null }],
      foreignKeys: [{ name: '', columns: ['parent_id'], refSchema: '', refTable: 'parent', refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION', orig: null }],
    }
    const r = await apply(null, x)
    expect(r.statements.join('\n')).toContain('PRIMARY KEY AUTOINCREMENT')
    await (await session()).run('INSERT INTO "order line" (parent_id) VALUES (1)', 1)
    expect(await rows('SELECT id, at IS NOT NULL FROM "order line"')).toEqual([[1, 1]])
    await expect((await session()).run('INSERT INTO "order line" (parent_id) VALUES (99)', 1)).rejects.toThrow()
    const d = await design('order line')
    expect(d.columns[0].autoIncrement).toBe(true)
    expect(d.foreignKeys[0].refTable).toBe('parent')
  })

  it('refuses rebuild changes on tables with settings it cannot keep, and checks the design', async () => {
    await (await session()).run('CREATE TABLE chk (a INT CHECK (a > 0), b TEXT)', 1)
    const before = await design('chk')
    expect(before.unsupported).toContain('CHECK')
    const after = clone(before)
    after.columns[1].nullable = false
    expect(() => designSql('sqlite', W, before, after)).toThrow(/CHECK/)
    // ALTER로 되는 바뀜은 그대로 된다
    const add = clone(before)
    add.columns.push({ name: 'c', type: 'INT', nullable: true, default: '', autoIncrement: false, comment: '', generated: false, orig: null })
    await apply(before, add)
    expect((await design('chk')).columns.length).toBe(3)

    const bad = clone(before)
    bad.columns[1].name = 'a'
    expect(() => designSql('sqlite', W, before, bad)).toThrow()
    const badIx = clone(before)
    badIx.indexes.push({ name: 'x', columns: ['nope'], unique: false, orig: null })
    expect(() => designSql('sqlite', W, before, badIx)).toThrow(/nope/)
  })

  it('lists triggers, shows their source and drops them', async () => {
    const live = m.get('db')
    const ex = await live.mod.extras(await live.metaSession('main'), 'main', '')
    expect(ex).toEqual([{ kind: 'trigger', name: 'item_ins', id: 'item_ins', table: 'item', args: '' }])
    const src = await live.mod.source(await live.metaSession('main'), 'main', '', 'trigger', 'item_ins')
    expect(src).toMatch(/^CREATE TRIGGER item_ins AFTER INSERT ON item/)
    const s = await m.editorSession('db', 'ddl', 'main', '')
    await runStatements(s, 'sqlite', [dropExtraSql('sqlite', W, ex[0])])
    expect(await live.mod.extras(await live.metaSession('main'), 'main', '')).toEqual([])
  })

  it('renames, empties and drops objects', async () => {
    const s = await m.editorSession('db', 'ddl', 'main', '')
    await runStatements(s, 'sqlite', objectSql('sqlite', ref('log'), 'table', 'rename', 'log2'))
    expect(await rows("SELECT name FROM sqlite_master WHERE name = 'log2'")).toEqual([['log2']])
    await runStatements(s, 'sqlite', objectSql('sqlite', ref('item'), 'table', 'truncate'))
    expect(await rows('SELECT COUNT(*) FROM item')).toEqual([[0]])
    await runStatements(s, 'sqlite', objectSql('sqlite', ref('item_view'), 'view', 'drop'))
    expect(await rows("SELECT COUNT(*) FROM sqlite_master WHERE name = 'item_view'")).toEqual([[0]])
    expect(() => objectSql('sqlite', ref('item_view'), 'view', 'rename', 'v2')).toThrow()
    // 실패하면 몇 번째 문장인지 알려 주고 되돌린다
    await expect(runStatements(s, 'sqlite', ['BEGIN', 'DROP TABLE log2', 'DROP TABLE nope', 'COMMIT'])).rejects.toThrow(/3/)
    expect(await rows("SELECT COUNT(*) FROM sqlite_master WHERE name = 'log2'")).toEqual([[1]])
  })
})

describe('query parameters', () => {
  it('finds :name and ${name} outside strings, comments and casts', () => {
    const sql = "SELECT * FROM t WHERE a = :id AND b = ${who} AND c = ':nope' AND d::text = :id -- :skip\n AND e := 1"
    expect(findParams(sql, 'postgres').map((p) => p.name)).toEqual(['id', 'who', 'id'])
    expect(bindParams(sql, 'postgres', { id: '7', who: "'kim'" })).toBe("SELECT * FROM t WHERE a = 7 AND b = 'kim' AND c = ':nope' AND d::text = 7 -- :skip\n AND e := 1")
    expect(findParams('SELECT @x := 1, `a:b`', 'mysql')).toEqual([])
    expect(findParams("SELECT $$ :inside $$, :out", 'postgres').map((p) => p.name)).toEqual(['out'])
  })
})
