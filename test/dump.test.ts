// SQL 덤프: 뽑은 파일을 빈 DB에 다시 넣으면 같은 내용이 되는지 (SQLite. 서버 DB는 servers.test.ts)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import { orderByDeps, runSqlFile, writeDump } from '../src/main/dump'
import { ddlReferences } from '../src/shared/sql'
import type { DumpOptions } from '../src/shared/types'
import { config, memoryKeys, resolved } from './exercise'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dboard-dump-'))
const ALL: DumpOptions = { structure: true, data: true, drop: true, batch: 2 }

describe('orderByDeps', () => {
  it('puts dependencies first and keeps the rest in order', () => {
    const deps: Record<string, string[]> = { a: ['c'], b: [], c: ['b'], d: ['a', 'x'] }
    expect(orderByDeps(['a', 'b', 'c', 'd'], (x) => deps[x] ?? [])).toEqual(['b', 'c', 'a', 'd'])
  })
  it('survives cycles', () => {
    const deps: Record<string, string[]> = { a: ['b'], b: ['a'], c: [] }
    expect(orderByDeps(['a', 'b', 'c'], (x) => deps[x])).toEqual(['c', 'a', 'b'])
  })
  it('reads REFERENCES from DDL', () => {
    expect(ddlReferences('CREATE TABLE c (p INT REFERENCES "parent"(id), q INT, FOREIGN KEY (q) REFERENCES public.other (id))', 'postgres')).toEqual(['parent', 'other'])
  })
})

const SOURCE = [
  'CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
  `CREATE TABLE child (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES parent(id), note TEXT, data BLOB, price NUMERIC,
     doubled REAL GENERATED ALWAYS AS (price * 2) VIRTUAL)`,
  'CREATE INDEX ix_child_parent ON child (parent_id)',
  'CREATE TABLE log (msg TEXT)',
  "CREATE TRIGGER trg_child AFTER INSERT ON child BEGIN INSERT INTO log VALUES ('inserted; really'); END",
  'CREATE VIEW v1 AS SELECT id, note FROM child',
  // v0이 이름으로는 먼저지만 v1을 쓰므로 v1 뒤에 만들어야 한다
  'CREATE VIEW v0 AS SELECT id FROM v1',
  "INSERT INTO parent VALUES (1, 'a''b; -- not a comment'), (2, '한글 😀'), (3, 'x')",
  "INSERT INTO child (parent_id, note, data, price) VALUES (1, NULL, X'00FF10', 1.5), (2, 'line1\nline2', NULL, 3), (3, '', X'', -0.25)",
]

describe('sqlite dump', () => {
  it('round-trips structure and data into an empty file', async () => {
    const dir = tmp()
    const src = path.join(dir, 'src.db')
    const dst = path.join(dir, 'dst.db')
    const out = path.join(dir, 'dump.sql')
    fs.writeFileSync(src, '')
    fs.writeFileSync(dst, '')
    const m = new Manager(memoryKeys())
    try {
      await m.connect('src', resolved(config('sqlite', { file: src })))
      await m.connect('dst', resolved(config('sqlite', { file: dst })))
      const s = await m.editorSession('src', 'a', 'main', '')
      for (const q of SOURCE) await s.run(q, 10)
      const live = m.get('src')
      const objects = await live.mod.objects(s, 'main', '', { showSystem: false })
      const r = await writeDump(s, live.mod, 'main', '', objects, out, ALL, { conn: 'src', version: 'test' })
      expect(r).toEqual({ tables: 3, views: 2, rows: 3 + 3 + 3 })
      const text = fs.readFileSync(out, 'utf8')
      // 부모 표 → 자식 표, 트리거는 데이터 뒤, v1 → v0, 계산 열은 INSERT에 없음
      expect(text.indexOf('CREATE TABLE parent')).toBeLessThan(text.indexOf('CREATE TABLE child'))
      expect(text.indexOf('INSERT INTO "log"')).toBeLessThan(text.indexOf('CREATE TRIGGER'))
      expect(text.indexOf('CREATE VIEW v1')).toBeLessThan(text.indexOf('CREATE VIEW v0'))
      expect(text).not.toMatch(/INSERT INTO "child" \([^)]*doubled/)
      expect(text).toContain("X'00ff10'")

      const d = await m.editorSession('dst', 'b', 'main', '')
      const run1 = await runSqlFile(d, 'sqlite', out)
      expect(run1.statements).toBeGreaterThan(10)
      // DROP이 있으니 두 번 넣어도 같다
      await runSqlFile(d, 'sqlite', out)

      for (const q of ['SELECT * FROM parent ORDER BY id', 'SELECT * FROM child ORDER BY id', 'SELECT * FROM log', 'SELECT * FROM v0 ORDER BY id']) {
        const a = await s.query(q)
        const b = await d.query(q)
        expect(b.rows, q).toEqual(a.rows)
      }
      // 트리거는 다시 넣는 동안 돌지 않았고(로그 3줄 그대로), 지금은 살아 있다. 자동 번호도 이어진다
      await d.run("INSERT INTO child (parent_id, note) VALUES (1, 'new')", 10)
      expect((await d.query('SELECT MAX(id) FROM child')).rows[0][0]).toBe(4)
      expect((await d.query('SELECT COUNT(*) FROM log')).rows[0][0]).toBe(4)
      expect((await d.query('SELECT doubled FROM child WHERE id = 1')).rows[0][0]).toBe(3)
    } finally {
      await m.disconnectAll()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes structure only or data only', async () => {
    const dir = tmp()
    const src = path.join(dir, 'src.db')
    fs.writeFileSync(src, '')
    const m = new Manager(memoryKeys())
    try {
      await m.connect('src', resolved(config('sqlite', { file: src })))
      const s = await m.editorSession('src', 'a', 'main', '')
      for (const q of SOURCE) await s.run(q, 10)
      const live = m.get('src')
      const objects = [{ name: 'parent', kind: 'table' as const }]
      const ddlOnly = path.join(dir, 'ddl.sql')
      await writeDump(s, live.mod, 'main', '', objects, ddlOnly, { ...ALL, data: false, drop: false }, { conn: 'src', version: '' })
      const a = fs.readFileSync(ddlOnly, 'utf8')
      expect(a).toContain('CREATE TABLE parent')
      expect(a).not.toContain('INSERT INTO')
      expect(a).not.toContain('DROP TABLE')
      const dataOnly = path.join(dir, 'data.sql')
      await writeDump(s, live.mod, 'main', '', objects, dataOnly, { ...ALL, structure: false, drop: false, batch: 100 }, { conn: 'src', version: '' })
      const b = fs.readFileSync(dataOnly, 'utf8')
      expect(b).not.toContain('CREATE TABLE')
      expect(b.match(/INSERT INTO/g)).toHaveLength(1)
    } finally {
      await m.disconnectAll()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops a SQL file at the failing statement and rolls back', async () => {
    const dir = tmp()
    const dst = path.join(dir, 'dst.db')
    const file = path.join(dir, 'bad.sql')
    fs.writeFileSync(dst, '')
    fs.writeFileSync(file, 'CREATE TABLE t (a INT);\nBEGIN;\nINSERT INTO t VALUES (1);\n\nINSERT INTO nope VALUES (2);\nCOMMIT;\n')
    const m = new Manager(memoryKeys())
    try {
      await m.connect('dst', resolved(config('sqlite', { file: dst })))
      const d = await m.editorSession('dst', 'b', 'main', '')
      await expect(runSqlFile(d, 'sqlite', file)).rejects.toThrow(/4.*5|nope/s)
      expect((await d.query('SELECT COUNT(*) FROM t')).rows[0][0]).toBe(0)
    } finally {
      await m.disconnectAll()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('dump safety', () => {
  it('never writes DROP for a data-only dump', async () => {
    const dir = tmp()
    const src = path.join(dir, 'src.db')
    fs.writeFileSync(src, '')
    const m = new Manager(memoryKeys())
    try {
      await m.connect('src', resolved(config('sqlite', { file: src })))
      const s = await m.editorSession('src', 'a', 'main', '')
      for (const q of SOURCE) await s.run(q, 10)
      const out = path.join(dir, 'd.sql')
      await writeDump(s, m.get('src').mod, 'main', '', [{ name: 'parent', kind: 'table' }], out, { structure: false, data: true, drop: true, batch: 10 }, { conn: '', version: '' })
      expect(fs.readFileSync(out, 'utf8')).not.toContain('DROP')
    } finally {
      await m.disconnectAll()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
