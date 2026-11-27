// 3-1단계: ER 모델 · 스키마 비교 · 데이터 옮기기 · 타입 바꾸기 (SQLite. 서버 DB는 stage3-servers.test.ts)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import { compareSchemas } from '../src/main/compare'
import { runStatements } from '../src/main/dump'
import { erModel } from '../src/main/er'
import { transferData } from '../src/main/transfer'
import { mapDefault, mapType, orderByParents } from '../src/shared/compare'
import { autoLayout, boxSize, visibleColumns } from '../src/renderer/src/views/erGeometry'
import { config, memoryKeys, resolved } from './exercise'

let dir = ''
let m: Manager
const O = { showSystem: false }
const side = async (id: string) => {
  const live = m.get(id)
  return { mod: live.mod, s: await live.metaSession('main'), db: 'main', schema: '', o: O }
}
const run = async (id: string, sql: string[]) => {
  const s = await m.editorSession(id, 'ddl-' + id, 'main', '')
  await runStatements(s, 'sqlite', sql)
}
const rows = async (id: string, sql: string) => (await (await m.editorSession(id, 'q-' + id, 'main', '')).query(sql)).rows

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dboard-s3-'))
  m = new Manager(memoryKeys())
  for (const id of ['a', 'b']) {
    const file = path.join(dir, id + '.db')
    fs.writeFileSync(file, '')
    await m.connect(id, resolved(config('sqlite', { file })))
  }
  await run('a', [
    'CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)',
    'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), qty INT DEFAULT 1, data BLOB)',
    'CREATE INDEX child_qty ON child (qty)',
    'CREATE TABLE lonely (x INT)',
    'CREATE VIEW v AS SELECT id FROM parent',
    "INSERT INTO parent VALUES (1, 'p1', NULL), (2, 'p2', 'n')",
    "INSERT INTO child VALUES (1, 1, 3, X'00FF10'), (2, 2, 5, NULL)",
  ])
  await run('b', [
    'CREATE TABLE parent (id INTEGER PRIMARY KEY, name INT, extra TEXT)',
    'CREATE TABLE only_b (y INT)',
  ])
})

afterEach(async () => {
  await m.disconnectAll()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('stage 3-1 (sqlite)', () => {
  it('builds the ER model and lays it out with parents on the left', async () => {
    const live = m.get('a')
    const er = await erModel(live.mod, await live.metaSession('main'), 'main', '', O)
    expect(er.tables.map((x) => x.name).sort()).toEqual(['child', 'lonely', 'parent'])
    expect(er.links).toEqual([{ name: expect.any(String), from: 'child', fromColumns: ['parent_id'], to: 'parent', toColumns: ['id'] }])
    const sizes = new Map(er.tables.map((x) => [x.name, boxSize(x, visibleColumns(x, undefined, 'all'), (s) => s.length * 7)]))
    const pos = autoLayout(er, sizes)
    expect(pos.get('parent')!.x).toBeLessThan(pos.get('child')!.x)
    // 이어지지 않은 표는 아래쪽
    expect(pos.get('lonely')!.y).toBeGreaterThan(pos.get('parent')!.y)
  })

  it('compares schemas and makes the target match', async () => {
    const r = await compareSchemas(await side('a'), await side('b'))
    const by = Object.fromEntries(r.items.map((x) => [x.name, x]))
    expect(by.child.status).toBe('source')
    expect(by.lonely.status).toBe('source')
    expect(by.parent.status).toBe('changed')
    expect(by.parent.changes.join('\n')).toMatch(/note/)
    expect(by.parent.changes.join('\n')).toMatch(/extra/)
    expect(by.only_b.status).toBe('target')
    expect(by.v.status).toBe('source')
    // 새 표는 부모가 먼저
    const names = r.items.map((x) => x.name)
    expect(names.indexOf('parent')).toBeGreaterThan(-1)
    await run('b', r.items.filter((x) => x.status === 'source' || x.status === 'changed').flatMap((x) => x.statements))
    const again = await compareSchemas(await side('a'), await side('b'))
    expect(again.items.filter((x) => x.kind === 'table' && x.status !== 'same' && x.status !== 'target')).toEqual([])
  })

  it('transfers data, creating missing tables, in foreign key order', async () => {
    const r = await transferData(await side('a'), await side('b'), ['child', 'parent'], { create: true, truncate: true, batch: 1, stopOnError: true }, () => false)
    expect(r.tables.map((x) => x.name)).toEqual(['parent', 'child'])
    expect(r.tables.every((x) => x.error === null)).toBe(true)
    expect(r.tables.find((x) => x.name === 'child')?.created).toBe(true)
    expect(await rows('b', 'SELECT id, name FROM parent ORDER BY id')).toEqual([[1, 'p1'], [2, 'p2']])
    expect(await rows('b', 'SELECT id, parent_id, qty, hex(data) FROM child ORDER BY id')).toEqual([[1, 1, 3, '00FF10'], [2, 2, 5, '']])
  })

  it('maps types and defaults between databases', () => {
    expect(mapType('mysql', 'postgres', 'int(11)')).toBe('integer')
    expect(mapType('mysql', 'postgres', 'tinyint(1)')).toBe('boolean')
    expect(mapType('mysql', 'mssql', 'varchar(50)')).toBe('nvarchar(50)')
    expect(mapType('postgres', 'mysql', 'character varying(20)')).toBe('varchar(20)')
    expect(mapType('postgres', 'mysql', 'timestamp with time zone')).toBe('datetime(6)')
    expect(mapType('mssql', 'postgres', 'nvarchar(max)')).toBe('text')
    expect(mapType('mssql', 'sqlite', 'decimal(10,2)')).toBe('NUMERIC')
    expect(mapType('sqlite', 'postgres', 'INTEGER')).toBe('bigint')
    expect(mapType('postgres', 'mssql', 'uuid')).toBe('uniqueidentifier')
    expect(mapType('mysql', 'mysql', 'int(11)')).toBe('int(11)')
    expect(mapDefault("'abc'::character varying", 'mssql')).toBe("N'abc'")
    expect(mapDefault('((0))', 'postgres')).toBe('0')
    expect(mapDefault('getdate()', 'postgres')).toBe('CURRENT_TIMESTAMP')
    expect(mapDefault('gen_random_uuid()', 'mysql')).toBe('')
    expect(orderByParents(['c', 'b', 'a'], (n) => ({ c: ['b'], b: ['a'], a: [] })[n] ?? [])).toEqual(['a', 'b', 'c'])
  })
})
