// SQL 덤프 왕복 — 실제 DB 서버(Docker): 원본 DB에서 뽑아 빈 DB에 넣으면 같은 내용·자동 번호가 이어지는지
// npm run test:db 로 돌린다 (DBOARD_TEST_DBS=1이 없으면 건너뜀)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import { runSqlFile, writeDump } from '../src/main/dump'
import { quoteIdent } from '../src/shared/dialect'
import type { DriverKind, DumpOptions } from '../src/shared/types'
import { config, memoryKeys, resolved } from './exercise'

const ON = process.env.DBOARD_TEST_DBS === '1'
const rand = () => Math.random().toString(36).slice(2, 8)
const ALL: DumpOptions = { structure: true, data: true, drop: true, batch: 2 }

interface Case {
  kind: DriverKind
  /** 원본에 만들 것 */
  source: string[]
  /** 비교할 SELECT */
  compare: string[]
  /** 다시 넣은 뒤: 자동 번호가 이어지는지 */
  after: { sql: string; check: string; expect: number }[]
  schema: string
}

const MYSQL: Omit<Case, 'kind'> = {
  schema: '',
  source: [
    'CREATE TABLE parent (id INT PRIMARY KEY, name VARCHAR(100) NOT NULL) ENGINE=InnoDB',
    `CREATE TABLE child (id INT AUTO_INCREMENT PRIMARY KEY, parent_id INT, note TEXT, data VARBINARY(16), price DECIMAL(10,2), made DATETIME(3),
       doubled DECIMAL(12,2) AS (price * 2) STORED, FOREIGN KEY (parent_id) REFERENCES parent (id)) ENGINE=InnoDB`,
    'CREATE VIEW v1 AS SELECT id, note FROM child',
    'CREATE VIEW v0 AS SELECT id FROM v1',
    "INSERT INTO parent VALUES (1, 'a''b; -- x \\\\ back'), (2, '한글 😀')",
    "INSERT INTO child (parent_id, note, data, price, made) VALUES (1, NULL, X'00FF10', 1.50, '2026-01-02 03:04:05.678'), (2, 'line1\\nline2', NULL, -3.25, NULL)",
  ],
  compare: ['SELECT * FROM parent ORDER BY id', 'SELECT * FROM child ORDER BY id', 'SELECT * FROM v0 ORDER BY id'],
  after: [{ sql: "INSERT INTO child (parent_id, note) VALUES (1, 'new')", check: 'SELECT MAX(id) FROM child', expect: 3 }],
}

const CASES: Case[] = [
  { kind: 'mysql', ...MYSQL },
  { kind: 'mariadb', ...MYSQL },
  {
    kind: 'postgres',
    schema: 'public',
    source: [
      'CREATE TABLE parent (id int PRIMARY KEY, name text NOT NULL)',
      `CREATE TABLE child (id serial PRIMARY KEY, parent_id int REFERENCES parent (id), note text, data bytea, price numeric(10,2), made timestamptz,
         doubled numeric GENERATED ALWAYS AS (price * 2) STORED, tags text[], meta jsonb)`,
      'CREATE TABLE ident (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text)',
      'CREATE VIEW v1 AS SELECT id, note FROM child',
      'CREATE VIEW v0 AS SELECT id FROM v1',
      "INSERT INTO parent VALUES (1, 'a''b; -- x \\ back'), (2, '한글 😀')",
      `INSERT INTO child (parent_id, note, data, price, made, tags, meta) VALUES
         (1, NULL, '\\x00ff10', 1.50, '2026-01-02 03:04:05.678+00', '{a,"b c"}', '{"k": [1, "둘"]}'), (2, E'line1\\nline2', NULL, -3.25, NULL, NULL, NULL)`,
      "INSERT INTO ident (v) VALUES ('a'), ('b')",
    ],
    compare: ['SELECT * FROM parent ORDER BY id', 'SELECT * FROM child ORDER BY id', 'SELECT * FROM ident ORDER BY id', 'SELECT * FROM v0 ORDER BY id'],
    after: [
      { sql: "INSERT INTO child (parent_id, note) VALUES (1, 'new')", check: 'SELECT MAX(id) FROM child', expect: 3 },
      { sql: "INSERT INTO ident (v) VALUES ('c')", check: 'SELECT MAX(id) FROM ident', expect: 3 },
    ],
  },
  {
    kind: 'mssql',
    schema: 'dbo',
    source: [
      'CREATE TABLE parent (id INT PRIMARY KEY, name NVARCHAR(100) NOT NULL)',
      `CREATE TABLE child (id INT IDENTITY(1,1) PRIMARY KEY, parent_id INT REFERENCES parent (id), note NVARCHAR(MAX), data VARBINARY(16),
         price DECIMAL(10,2), made DATETIME, doubled AS (price * 2))`,
      'CREATE VIEW v1 AS SELECT id, note FROM child',
      'CREATE VIEW v0 AS SELECT id FROM v1',
      "INSERT INTO parent VALUES (1, N'a''b; -- x \\ back'), (2, N'한글 😀')",
      "INSERT INTO child (parent_id, note, data, price, made) VALUES (1, NULL, 0x00FF10, 1.50, '2026-01-02T03:04:05.677'), (2, N'line1' + CHAR(10) + N'line2', NULL, -3.25, NULL)",
    ],
    compare: ['SELECT * FROM parent ORDER BY id', 'SELECT * FROM child ORDER BY id', 'SELECT * FROM v0 ORDER BY id'],
    after: [{ sql: "INSERT INTO child (parent_id, note) VALUES (1, N'new')", check: 'SELECT MAX(id) FROM child', expect: 3 }],
  },
]

describe.skipIf(!ON)('dump round trip on real servers', () => {
  for (const c of CASES) {
    it(c.kind, async () => {
      const m = new Manager(memoryKeys())
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dboard-dump-'))
      const out = path.join(dir, 'dump.sql')
      const src = 'dboard_src_' + rand()
      const dst = 'dboard_dst_' + rand()
      const d = c.kind === 'mariadb' ? 'mysql' : c.kind
      const base = c.kind === 'postgres' ? config('postgres', { database: 'dboard_test' }) : config(c.kind)
      const admin = async (sql: string) => {
        const live = m.isConnected('admin') ? m.get('admin') : await m.connect('admin', resolved(base))
        await (await live.metaSession(c.kind === 'postgres' ? 'dboard_test' : undefined)).exec(sql)
      }
      try {
        for (const db of [src, dst]) await admin(`CREATE DATABASE ${quoteIdent(d, db)}`)
        await m.connect('x', resolved(base))
        const live = m.get('x')
        const s = await m.editorSession('x', 'src', src, c.schema)
        for (const q of c.source) await s.run(q, 10)
        const objects = await live.mod.objects(s, src, c.schema, { showSystem: false })
        await writeDump(s, live.mod, src, c.schema, objects, out, ALL, { conn: c.kind, version: live.version })
        const t = await m.editorSession('x', 'dst', dst, c.schema)
        await runSqlFile(t, d, out)
        // DROP이 있으니 두 번 넣어도 된다
        await runSqlFile(t, d, out)
        for (const q of c.compare) expect((await t.query(q)).rows, q).toEqual((await s.query(q)).rows)
        for (const a of c.after) {
          await t.run(a.sql, 10)
          expect(Number((await t.query(a.check)).rows[0][0]), a.sql).toBe(a.expect)
        }
      } finally {
        await m.disconnect('x').catch(() => undefined)
        for (const db of [src, dst]) {
          await admin(c.kind === 'mssql' ? `ALTER DATABASE ${quoteIdent(d, db)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${quoteIdent(d, db)}` : `DROP DATABASE ${quoteIdent(d, db)}`).catch((e) => console.warn(String(e)))
        }
        await m.disconnectAll()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
