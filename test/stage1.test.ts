// 수동 커밋 · 읽기 전용 · 실행 계획 · 외래 키 · 칸 값 전체 · 내보내기 형식 (SQLite. 서버 DB는 stage1-servers.test.ts)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import { explain } from '../src/main/explain'
import { writeExport } from '../src/main/export'
import * as ops from '../src/main/ops'
import type { Cell, CsvWriteOptions } from '../src/shared/types'
import { config, memoryKeys, resolved } from './exercise'

let dir = ''
let file = ''
let m: Manager
const count = async (sql: string) => Number((await (await m.editorSession('db', 'other', 'main', '')).query(sql)).rows[0][0])

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dboard-s1-'))
  file = path.join(dir, 'x.db')
  fs.writeFileSync(file, '')
  m = new Manager(memoryKeys())
  await m.connect('db', resolved(config('sqlite', { file })))
  const s = await m.editorSession('db', 'setup', 'main', '')
  for (const q of [
    'CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT)',
    'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), a INT, b INT, FOREIGN KEY (a, b) REFERENCES pair (x, y))',
    'CREATE TABLE pair (x INT, y INT, PRIMARY KEY (x, y))',
    'CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)',
    "INSERT INTO parent VALUES (1, 'p1'), (2, 'p2')",
  ]) await s.run(q, 10)
  await m.closeEditor('setup')
})

afterEach(async () => {
  await m.disconnectAll()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('manual commit', () => {
  it('keeps changes in a transaction until commit, rollback discards', async () => {
    const s = await m.editorSession('db', 'ed', 'main', '')
    await s.setManualCommit(true)
    await s.runManaged("INSERT INTO parent VALUES (3, 'p3')", 10)
    // 다른 연결에서는 아직 안 보인다
    expect(await count('SELECT COUNT(*) FROM parent')).toBe(2)
    await s.endTransaction(true)
    expect(await count('SELECT COUNT(*) FROM parent')).toBe(3)
    await s.runManaged('DELETE FROM parent WHERE id = 3', 10)
    await s.endTransaction(false)
    expect(await count('SELECT COUNT(*) FROM parent')).toBe(3)
  })

  it('an error keeps the earlier work, and turning manual off rolls back', async () => {
    const s = await m.editorSession('db', 'ed', 'main', '')
    await s.setManualCommit(true)
    await s.runManaged("INSERT INTO parent VALUES (4, 'p4')", 10)
    await expect(s.runManaged('INSERT INTO nope VALUES (1)', 10)).rejects.toThrow()
    expect((await s.query('SELECT COUNT(*) FROM parent')).rows[0][0]).toBe(3)
    await s.setManualCommit(false)
    expect(await count('SELECT COUNT(*) FROM parent')).toBe(2)
  })

  it('follows COMMIT typed by the user', async () => {
    const s = await m.editorSession('db', 'ed', 'main', '')
    await s.setManualCommit(true)
    await s.runManaged("INSERT INTO parent VALUES (5, 'p5')", 10)
    await s.runManaged('COMMIT', 10)
    expect(await count('SELECT COUNT(*) FROM parent')).toBe(3)
    // 다음 문장은 새 트랜잭션에서
    await s.runManaged('DELETE FROM parent WHERE id = 5', 10)
    await s.endTransaction(false)
    expect(await count('SELECT COUNT(*) FROM parent')).toBe(3)
  })
})

describe('read-only connection', () => {
  it('blocks writes on the server side', async () => {
    const m2 = new Manager(memoryKeys())
    try {
      await m2.connect('ro', resolved(config('sqlite', { file, readOnly: true })))
      const s = await m2.editorSession('ro', 'ed', 'main', '')
      expect((await s.query('SELECT COUNT(*) FROM parent')).rows[0][0]).toBe(2)
      await expect(s.run("INSERT INTO parent VALUES (9, 'x')", 10)).rejects.toThrow()
    } finally {
      await m2.disconnectAll()
    }
  })
})

describe('metadata and values', () => {
  it('explains without running', async () => {
    const s = await m.editorSession('db', 'ed', 'main', '')
    const r = await explain(s, 'SELECT * FROM child JOIN parent ON parent.id = child.parent_id WHERE parent.name = 1;')
    expect(r.text).toMatch(/SCAN|SEARCH/)
    const del = await explain(s, 'DELETE FROM parent')
    expect(del.text).not.toBeNull()
    expect(await count('SELECT COUNT(*) FROM parent')).toBe(2)
  })

  it('lists foreign keys, including composite and implicit primary key targets', async () => {
    const live = m.get('db')
    const fks = await live.mod.foreignKeys(await live.metaSession('main'), { db: 'main', schema: '', table: 'child' })
    const byTable = Object.fromEntries(fks.map((f) => [f.ref.table, f]))
    expect(byTable.parent).toMatchObject({ columns: ['parent_id'], refColumns: ['id'], ref: { db: 'main', table: 'parent' } })
    expect(byTable.pair).toMatchObject({ columns: ['a', 'b'], refColumns: ['x', 'y'] })
  })

  it('reads a whole binary value that the grid only shows the start of', async () => {
    const live = m.get('db')
    const s = await live.metaSession('main')
    await s.exec('INSERT INTO blobs VALUES (1, randomblob(5000))')
    const data = await ops.tableData(live, { db: 'main', schema: '', table: 'blobs' }, { filter: '', order: [], offset: 0, limit: 10 })
    const cell = data.rows[0][1] as { bin: string; size: number }
    expect(cell.bin.length).toBe(128)
    const full = await ops.cellValue(live, { db: 'main', schema: '', table: 'blobs' }, [data.rows[0][0]], 'data', 1024 * 1024) as { bin: string; size: number }
    expect(full.size).toBe(5000)
    expect(full.bin.length).toBe(10000)
  })
})

describe('export formats', () => {
  const cols = ['id', 'name', 'name', 'data']
  const rows: Cell[][] = [[1, 'a|b', 'x', null], [2, '줄1\n줄2 & <태그>', '007', { bin: 'ff00', size: 2 }], [3, '12.5', '-0.75', true]]
  const base: CsvWriteOptions = { format: 'csv', table: 'people', dialect: 'postgres', delimiter: ',', header: true, bom: false, nullText: '' }
  const run = (f: CsvWriteOptions['format'], o: Partial<CsvWriteOptions> = {}) => {
    const out = path.join(dir, 'out.' + f)
    return writeExport(out, { ...base, format: f, ...o }, async (onColumns, onRows) => {
      onColumns(cols)
      await onRows(rows.slice(0, 2))
      await onRows(rows.slice(2))
      return rows.length
    }).then((n) => ({ n, out }))
  }

  it('json: array of objects, duplicate names get _2, binary as 0x', async () => {
    const { n, out } = await run('json')
    expect(n).toBe(3)
    const v = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(v).toHaveLength(3)
    expect(v[0]).toEqual({ id: 1, name: 'a|b', name_2: 'x', data: null })
    expect(v[1].data).toBe('0xFF00')
  })

  it('markdown: escapes pipes and line breaks', async () => {
    const { out } = await run('md', { nullText: 'NULL' })
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n')
    expect(lines[0]).toBe('| id | name | name | data |')
    expect(lines[2]).toBe('| 1 | a\\|b | x | NULL |')
    expect(lines[3]).toContain('줄1<br>줄2')
  })

  it('sql: INSERT statements with the chosen table and dialect quoting', async () => {
    const { out } = await run('sql', { table: 'public.people' })
    const text = fs.readFileSync(out, 'utf8')
    expect(text.split('\n')[0]).toBe(`INSERT INTO "public"."people" ("id", "name", "name", "data") VALUES (1, 'a|b', 'x', NULL);`)
    expect(text).toContain("'\\xff00'::bytea")
  })

  it('xlsx: a valid workbook with header, numbers kept as numbers, text escaped', async () => {
    const { out } = await run('xlsx')
    const files = unzipSync(new Uint8Array(fs.readFileSync(out)))
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'])
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    expect(sheet.match(/<row>/g)).toHaveLength(4)
    expect(sheet).toContain('<c s="1" t="inlineStr"><is><t xml:space="preserve">id</t></is></c>')
    expect(sheet).toContain('<c><v>1</v></c>')
    expect(sheet).toContain('줄1\n줄2 &amp; &lt;태그&gt;')
    // 앞자리 0은 글자로, 소수는 숫자로
    expect(sheet).toContain('<t xml:space="preserve">007</t>')
    expect(sheet).toContain('<c><v>12.5</v></c>')
    expect(sheet).toContain('<c><v>-0.75</v></c>')
    expect(sheet).toContain('t="b"><v>1</v>')
  })

  it('csv still works with BOM and header', async () => {
    const { out } = await run('csv', { bom: true })
    const text = fs.readFileSync(out, 'utf8')
    expect(text.startsWith('﻿id,name,name,data\r\n1,a|b,x,\r\n')).toBe(true)
  })
})
