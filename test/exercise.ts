// DB 종류마다 같은 시나리오: 연결 → 탐색기(DB·스키마·표·열·인덱스·DDL·자동 완성) → 편집기 실행·잘림·취소
// → 표 데이터 보기·고치기(키 있음·없음, 실패하면 되돌림) → CSV 내보내기·가져오기
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from 'vitest'
import { Manager, type Resolved } from '../src/main/conn'
import * as ops from '../src/main/ops'
import { isBin, newConnection, type ConnectionConfig, type DriverKind, type TableRef } from '../src/shared/types'

export const memoryKeys = () => {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v), map: m }
}

export function config(kind: DriverKind, over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  const base = newConnection(kind)
  const ports: Record<DriverKind, number> = { sqlite: 0, mysql: 33061, mariadb: 33062, postgres: 54321, mssql: 14331 }
  return { ...base, id: 'c-' + kind, name: kind, host: '127.0.0.1', port: ports[kind], ...over }
}

export const PASSWORDS: Record<DriverKind, string> = { sqlite: '', mysql: 'dboard_test', mariadb: 'dboard_test', postgres: 'dboard_test', mssql: 'Dboard_test1!' }

export function resolved(c: ConnectionConfig, over: Partial<Resolved> = {}): Resolved {
  return { config: c, password: PASSWORDS[c.driver], sshPassword: '', sshPassphrase: '', ...over }
}

const SETUP: Record<'sqlite' | 'mysql' | 'postgres' | 'mssql', string[]> = {
  sqlite: [
    'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price NUMERIC, created TEXT DEFAULT CURRENT_TIMESTAMP, data BLOB, big INTEGER)',
    'CREATE INDEX ix_items_name ON items (name)',
    'CREATE TABLE nokey (a INTEGER, b TEXT)',
    'CREATE VIEW v_items AS SELECT id, name FROM items',
    "INSERT INTO items (name, price, data, big) VALUES ('사과', 1.5, X'00ff', 9007199254740993), ('배', 2, NULL, 1), ('감', NULL, NULL, NULL)",
  ],
  mysql: [
    'CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, price DECIMAL(10,2), created DATETIME DEFAULT CURRENT_TIMESTAMP, data VARBINARY(100), big BIGINT) DEFAULT CHARSET=utf8mb4',
    'CREATE INDEX ix_items_name ON items (name)',
    'CREATE TABLE nokey (a INT, b VARCHAR(10))',
    'CREATE VIEW v_items AS SELECT id, name FROM items',
    "INSERT INTO items (name, price, data, big) VALUES ('사과', 1.5, X'00ff', 9007199254740993), ('배', 2, NULL, 1), ('감', NULL, NULL, NULL)",
  ],
  postgres: [
    'CREATE TABLE items (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, price NUMERIC(10,2), created TIMESTAMP DEFAULT now(), data BYTEA, big BIGINT)',
    'CREATE INDEX ix_items_name ON items (name)',
    'CREATE TABLE nokey (a INT, b VARCHAR(10))',
    'CREATE VIEW v_items AS SELECT id, name FROM items',
    "INSERT INTO items (name, price, data, big) VALUES ('사과', 1.5, decode('00ff', 'hex'), 9007199254740993), ('배', 2, NULL, 1), ('감', NULL, NULL, NULL)",
  ],
  mssql: [
    'CREATE TABLE items (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(100) NOT NULL, price DECIMAL(10,2), created DATETIME2 DEFAULT SYSDATETIME(), data VARBINARY(100), big BIGINT)',
    'CREATE INDEX ix_items_name ON items (name)',
    'CREATE TABLE nokey (a INT, b NVARCHAR(10))',
    'CREATE VIEW v_items AS SELECT id, name FROM items',
    "INSERT INTO items (name, price, data, big) VALUES (N'사과', 1.5, 0x00FF, 9007199254740993), (N'배', 2, NULL, 1), (N'감', NULL, NULL, NULL)",
  ],
}

const LONG: Record<'mysql' | 'postgres' | 'mssql', string> = {
  mysql: 'SELECT SLEEP(20)',
  postgres: 'SELECT pg_sleep(20)',
  mssql: "WAITFOR DELAY '00:00:20'",
}

export interface Target {
  db: string
  schema: string
}

/** 시험용 DB·스키마 만들기 → 시나리오 → 지우기 */
export async function exercise(m: Manager, id: string, r: Resolved, prepare: (m: Manager) => Promise<Target>, cleanup: (m: Manager, t: Target) => Promise<void>) {
  const live = await m.connect(id, r)
  const d = live.mod.dialect
  expect(live.version).toMatch(/SQLite|MySQL|MariaDB|PostgreSQL|SQL Server/)
  const tgt = await prepare(m)
  try {
    const tab = 'tab-' + Math.random().toString(36).slice(2)
    const ed = await m.editorSession(id, tab, tgt.db, tgt.schema)
    for (const sql of SETUP[d]) await ed.run(sql, 100)
    await ed.run('INSERT INTO nokey (a, b) VALUES (1, ' + (d === 'mssql' ? "N'x'" : "'x'") + ')', 10)
    const ins = await ed.run('INSERT INTO nokey (a, b) VALUES (1, ' + (d === 'mssql' ? "N'x'" : "'x'") + ')', 10)
    expect(ins[0].affected).toBe(1)

    // ── 탐색기 ──
    const meta = await live.metaSession(tgt.db)
    const dbs = await live.mod.databases(await live.metaSession(), { showSystem: false })
    expect(dbs.databases).toContain(tgt.db)
    if (dbs.hasSchemas) expect(await live.mod.schemas(meta, tgt.db, { showSystem: false })).toContain(tgt.schema)
    const objs = await live.mod.objects(meta, tgt.db, tgt.schema, { showSystem: false })
    expect(objs.filter((o) => o.kind === 'table').map((o) => o.name)).toEqual(expect.arrayContaining(['items', 'nokey']))
    expect(objs.find((o) => o.name === 'v_items')?.kind).toBe('view')
    const ref: TableRef = { db: tgt.db, schema: tgt.schema, table: 'items' }
    const cols = await live.mod.columns(meta, ref)
    expect(cols.map((c) => c.name)).toEqual(['id', 'name', 'price', 'created', 'data', 'big'])
    expect(cols[0]).toMatchObject({ pk: true, autoIncrement: true })
    expect(cols[1]).toMatchObject({ pk: false, nullable: false })
    expect(cols[2].nullable).toBe(true)
    const ix = await live.mod.indexes(meta, ref)
    expect(ix.find((i) => i.primary)?.columns).toEqual(['id'])
    expect(ix.find((i) => i.name === 'ix_items_name')?.columns).toEqual(['name'])
    const ddl = await live.mod.ddl(meta, ref, 'table')
    expect(ddl).toMatch(/CREATE TABLE/i)
    expect(ddl).toMatch(/ix_items_name/)
    expect(await live.mod.ddl(meta, { ...ref, table: 'v_items' }, 'view')).toMatch(/SELECT/i)
    const comp = await live.mod.completion(meta, tgt.db, tgt.schema)
    expect(comp.items).toEqual(expect.arrayContaining(['id', 'name']))

    // ── 편집기 ──
    const res = await ed.run('SELECT id, name, price, created, data, big FROM items ORDER BY id', 2)
    expect(res[0].rows).toHaveLength(2)
    expect(res[0].truncated).toBe(true)
    expect(res[0].columns?.map((c) => c.name)).toEqual(['id', 'name', 'price', 'created', 'data', 'big'])
    const row = res[0].rows[0]
    expect(row[0]).toBe(1)
    expect(row[1]).toBe('사과')
    expect(String(row[2])).toMatch(/^1\.5/)
    expect(typeof row[3]).toBe('string')
    expect(isBin(row[4]!) && row[4].bin).toBe('00ff')
    expect(row[5]).toBe('9007199254740993')
    // 잘린 뒤에도 같은 연결을 계속 쓸 수 있다
    const cnt = await ed.run('SELECT COUNT(*) FROM items', 10)
    expect(Number(cnt[0].rows[0][0])).toBe(3)
    await expect(ed.run('SELECT * FROM no_such_table', 10)).rejects.toThrow()
    if (d === 'mssql') {
      const two = await ed.run('SELECT 1 AS a; SELECT 2 AS b', 10)
      expect(two.map((x) => x.columns?.[0].name)).toEqual(['a', 'b'])
    }
    if (d !== 'sqlite') {
      const t0 = Date.now()
      const p = m.editorSession(id, tab, tgt.db, tgt.schema).then((s) => s.run(LONG[d], 10)).catch(() => undefined)
      await new Promise((ok) => setTimeout(ok, 800))
      await m.cancel(tab)
      await p
      expect(Date.now() - t0).toBeLessThan(10_000)
      const again = await (await m.editorSession(id, tab, tgt.db, tgt.schema)).run('SELECT 1', 10)
      expect(Number(again[0].rows[0][0])).toBe(1)
    }

    // ── 표 데이터 ──
    const page = await ops.tableData(live, ref, { filter: '', order: [{ column: 'id', desc: true }], offset: 0, limit: 2 })
    expect(page.key).toEqual({ kind: 'pk', columns: ['id'] })
    expect(page.hasMore).toBe(true)
    expect(page.rows.map((x) => x[0])).toEqual([3, 2])
    const filtered = await ops.tableData(live, ref, { filter: "name = " + (d === 'mssql' ? "N'배'" : "'배'"), order: [], offset: 0, limit: 10 })
    expect(filtered.rows).toHaveLength(1)
    expect(await ops.countRows(live, ref, '')).toBe(3)

    const n = await ops.applyChanges(live, ref, [
      { op: 'update', key: [1], values: { name: "사과'", price: '3.25' } },
      { op: 'insert', values: { name: '포도' } },
      { op: 'delete', key: [2] },
    ])
    expect(n).toBe(3)
    const after = await ops.tableData(live, ref, { filter: '', order: [{ column: 'id', desc: false }], offset: 0, limit: 10 })
    expect(after.rows.map((x) => x[1])).toEqual(["사과'", '감', '포도'])
    expect(String(after.rows[0][2])).toMatch(/^3\.25/)
    // 없는 행을 고치면 같이 보낸 INSERT까지 전부 되돌림
    await expect(ops.applyChanges(live, ref, [{ op: 'insert', values: { name: '없어야 함' } }, { op: 'update', key: [999], values: { name: 'x' } }])).rejects.toThrow()
    expect(await ops.countRows(live, ref, '')).toBe(3)

    // 키 없는 표: 모든 열로 찾고, 같은 값의 행이 둘이어도 하나만
    const nk: TableRef = { ...ref, table: 'nokey' }
    const nkData = await ops.tableData(live, nk, { filter: '', order: [], offset: 0, limit: 10 })
    if (d === 'sqlite') {
      expect(nkData.key.kind).toBe('rowid')
      await ops.applyChanges(live, nk, [{ op: 'delete', key: [nkData.rowids![0]] }])
    } else {
      expect(nkData.key).toEqual({ kind: 'all', columns: ['a', 'b'] })
      await ops.applyChanges(live, nk, [{ op: 'delete', key: [1, 'x'] }])
    }
    expect(await ops.countRows(live, nk, '')).toBe(1)

    // ── CSV ──
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dboard-csv-'))
    const out = path.join(dir, 'items.csv')
    const exported = await ops.exportTable(live, ref, '', [{ column: 'id', desc: false }], out, { delimiter: ',', header: true, bom: true, nullText: '' })
    expect(exported).toBe(3)
    const text = fs.readFileSync(out, 'utf8')
    expect(text.startsWith('﻿id,name,price,created,data,big\r\n')).toBe(true)
    expect(text).toContain("사과'")
    const inFile = path.join(dir, 'in.csv')
    fs.writeFileSync(inFile, 'name,price,ignored\r\n수박,10,a\r\n"참외, 노랑",,b\r\n')
    const pv = ops.previewCsv(inFile, { delimiter: 'auto', header: true, encoding: 'auto' }, 'in.csv')
    expect(pv).toMatchObject({ delimiter: ',', encoding: 'utf8', headers: ['name', 'price', 'ignored'], total: 2 })
    const added = await ops.importCsv(live, ref, inFile, { delimiter: ',', header: true, encoding: 'auto', mapping: ['name', 'price', null], emptyAsNull: true })
    expect(added).toBe(2)
    const imported = await ops.tableData(live, ref, { filter: 'price IS NULL', order: [{ column: 'id', desc: false }], offset: 0, limit: 10 })
    expect(imported.rows.map((x) => x[1])).toContain('참외, 노랑')
    // NOT NULL 위반 → 하나도 안 들어감
    fs.writeFileSync(inFile, 'name\r\n하나\r\n\r\n')
    fs.writeFileSync(inFile, 'name,price\r\n하나,1\r\n,2\r\n')
    await expect(ops.importCsv(live, ref, inFile, { delimiter: ',', header: true, encoding: 'utf8', mapping: ['name', 'price'], emptyAsNull: true })).rejects.toThrow()
    expect(await ops.countRows(live, ref, '')).toBe(5)
    fs.rmSync(dir, { recursive: true, force: true })
    await m.closeEditor(tab)
  } finally {
    await cleanup(m, tgt).catch(() => undefined)
  }
}
