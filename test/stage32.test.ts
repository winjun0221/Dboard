// 3-2단계: 엑셀·JSON 가져오기 · 실행 계획 그림 읽기 · 사용자 SQL · 전체 검색 (SQLite. 서버 DB는 stage32-servers.test.ts)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import * as ops from '../src/main/ops'
import { searchData, searchNames } from '../src/main/search'
import { readJson, readXlsx } from '../src/main/tabular'
import { userSql } from '../src/shared/users'
import { parsePlan } from '../src/renderer/src/components/PlanGraph'
import { config, memoryKeys, resolved } from './exercise'

/** 시트 하나짜리 xlsx: 공유 글·인라인 글·숫자·참거짓·날짜 서식·빈칸 */
function xlsx(): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="데이터" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8('<sst><si><t>name</t></si><si><t>price</t></si><si><r><t>참외,</t></r><r><t xml:space="preserve"> 노랑</t></r></si><si><t>made</t></si><si><t>A &amp; B</t></si></sst>'),
    'xl/styles.xml': strToU8('<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>'),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c><c r="D1" t="inlineStr"><is><t>ok</t></is></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c><c r="C2" s="1"><v>45352</v></c><c r="D2" t="b"><v>1</v></c></row>' +
      '<row r="4"><c r="A4" t="s"><v>4</v></c><c r="C4" s="2"><v>45352.5</v></c></row>' +
      '</sheetData></worksheet>',
    ),
    'xl/worksheets/sheet2.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>'),
  }
  return zipSync(files)
}

describe('stage 3-2 file readers', () => {
  it('reads xlsx sheets with shared strings, dates, booleans and gaps', () => {
    const r = readXlsx(xlsx(), 0, true)
    expect(r.sheets).toEqual(['데이터', 'Other'])
    expect(r.headers).toEqual(['name', 'price', 'made', 'ok'])
    expect(r.rows).toEqual([['참외, 노랑', '12.5', '2024-03-01', 'true'], [], ['A & B', '', '2024-03-01 12:00:00']])
    expect(readXlsx(xlsx(), 1, false).rows).toEqual([['x']])
  })

  it('reads JSON arrays of objects, arrays of arrays and wrapped arrays', () => {
    const j = (v: unknown) => Buffer.from(JSON.stringify(v))
    expect(readJson(j([{ a: 1, b: 'x' }, { b: null, c: { d: 2 } }]), true)).toEqual({ headers: ['a', 'b', 'c'], rows: [['1', 'x', ''], ['', '', '{"d":2}']] })
    expect(readJson(j([['h1', 'h2'], [1, true]]), true)).toEqual({ headers: ['h1', 'h2'], rows: [['1', 'true']] })
    expect(readJson(j({ data: [{ k: 'v' }] }), true).rows).toEqual([['v']])
    expect(() => readJson(Buffer.from('{oops'), true)).toThrow()
  })
})

describe('stage 3-2 plans and users', () => {
  it('parses execution plans into trees', () => {
    const pg = parsePlan(['Hash Join  (cost=1.09..2.27 rows=5 width=40)', '  Hash Cond: (o.customer_id = c.id)', '  ->  Seq Scan on orders o  (cost=0.00..1.05 rows=5 width=24)', '  ->  Hash  (cost=1.04..1.04 rows=4 width=20)', '        ->  Seq Scan on customers c  (cost=0.00..1.04 rows=4 width=20)'].join('\n'), 'postgres')
    expect(pg).toHaveLength(1)
    expect(pg[0]).toMatchObject({ label: 'Hash Join', cost: 2.27, rows: 5, details: ['Hash Cond: (o.customer_id = c.id)'] })
    expect(pg[0].children.map((c) => c.label)).toEqual(['Seq Scan on orders o', 'Hash'])
    expect(pg[0].children[1].children[0].label).toBe('Seq Scan on customers c')
    const my = parsePlan('-> Nested loop inner join  (cost=2.50 rows=5)\n    -> Table scan on c  (cost=0.65 rows=4)\n    -> Index lookup on o using fk (customer_id=c.id)  (cost=0.30 rows=1)', 'mysql')
    expect(my[0]).toMatchObject({ label: 'Nested loop inner join', cost: 2.5 })
    expect(my[0].children).toHaveLength(2)
    const lite = parsePlan('SCAN o\n└─ SEARCH c USING INTEGER PRIMARY KEY (rowid=?)', 'sqlite')
    expect(lite[0].children[0].label).toBe('SEARCH c USING INTEGER PRIMARY KEY (rowid=?)')
    const ms = parsePlan('SELECT * FROM t\n  |--Nested Loops(Inner Join)\n       |--Clustered Index Scan(OBJECT:([t]))\n       |--Index Seek(OBJECT:([u]))', 'mssql')
    expect(ms[0].children.map((c) => c.label)).toEqual(['Clustered Index Scan(OBJECT:([t]))', 'Index Seek(OBJECT:([u]))'])
  })

  it('builds user SQL and masks passwords', () => {
    const a = { kind: 'create' as const, name: "o'neil", host: '%', password: "p'w", login: true }
    expect(userSql('mysql', a, false)).toEqual(["CREATE USER 'o''neil'@'%' IDENTIFIED BY 'p''w'"])
    expect(userSql('mysql', a, true)).toEqual(["CREATE USER 'o''neil'@'%' IDENTIFIED BY '********'"])
    expect(userSql('postgres', a, true)).toEqual(['CREATE ROLE "o\'neil" LOGIN PASSWORD \'********\''])
    const g = { kind: 'grant' as const, name: 'u', host: '', privileges: ['SELECT', 'INSERT'], db: 'shop', schema: 'public', table: '' }
    expect(userSql('postgres', g, false)).toEqual(['GRANT USAGE ON SCHEMA "public" TO "u"', 'GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA "public" TO "u"'])
    expect(userSql('mysql', { ...g, table: 't' }, false)).toEqual(["GRANT SELECT, INSERT ON `shop`.`t` TO 'u'@'%'"])
    expect(userSql('mssql', { ...g, schema: 'dbo' }, false)[1]).toBe('GRANT SELECT, INSERT ON SCHEMA::[dbo] TO [u]')
    expect(() => userSql('mssql', { ...a, password: '' }, false)).toThrow()
  })
})

describe('stage 3-2 on sqlite', () => {
  let dir = ''
  let m: Manager
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dboard-s32-'))
    const file = path.join(dir, 'x.db')
    fs.writeFileSync(file, '')
    m = new Manager(memoryKeys())
    await m.connect('db', resolved(config('sqlite', { file })))
    const s = await m.editorSession('db', 'setup', 'main', '')
    for (const q of [
      'CREATE TABLE fruit (id INTEGER PRIMARY KEY, name TEXT, price REAL, made TEXT, ok TEXT)',
      'CREATE TABLE note (body TEXT, n INT)',
      "INSERT INTO note VALUES ('사과가 좋아', 1), ('100% 확실', 2), ('배', 3)",
      'CREATE TRIGGER fruit_t AFTER INSERT ON fruit BEGIN SELECT 1; END',
    ]) await s.run(q, 1)
  })
  afterEach(async () => {
    await m.disconnectAll()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('imports xlsx and json files into a table', async () => {
    const live = m.get('db')
    const ref = { db: 'main', schema: '', table: 'fruit' }
    const xf = path.join(dir, 'f.xlsx')
    fs.writeFileSync(xf, xlsx())
    const pv = ops.previewCsv(xf, { delimiter: 'auto', header: true, encoding: 'auto', sheet: 0 }, 'f.xlsx')
    expect(pv).toMatchObject({ format: 'xlsx', sheets: ['데이터', 'Other'], headers: ['name', 'price', 'made', 'ok'], total: 2 })
    const n = await ops.importCsv(live, ref, xf, { delimiter: ',', header: true, encoding: 'utf8', sheet: 0, mapping: ['name', 'price', 'made', 'ok'], emptyAsNull: true })
    expect(n).toBe(2)
    const jf = path.join(dir, 'f.json')
    fs.writeFileSync(jf, JSON.stringify([{ name: '귤', price: 3 }]))
    expect(await ops.importCsv(live, ref, jf, { delimiter: ',', header: true, encoding: 'utf8', mapping: ['name', 'price'], emptyAsNull: true })).toBe(1)
    const rows = (await (await live.metaSession('main')).query('SELECT name, price, made, ok FROM fruit ORDER BY id')).rows
    expect(rows).toEqual([['참외, 노랑', 12.5, '2024-03-01', 'true'], ['A & B', null, '2024-03-01 12:00:00', null], ['귤', 3, null, null]])
  })

  it('searches names and data', async () => {
    const live = m.get('db')
    const s = await live.metaSession('main')
    const hits = await searchNames(live.mod, async () => s, ['main'], 'FRU', { showSystem: false })
    expect(hits.map((h) => `${h.kind}:${h.name}`)).toEqual(expect.arrayContaining(['table:fruit', 'trigger:fruit_t']))
    expect((await searchNames(live.mod, async () => s, ['main'], 'price', { showSystem: false }))[0]).toMatchObject({ kind: 'column', table: 'fruit', name: 'price' })
    const data = await searchData(live.mod, s, 'main', '', '사과', { showSystem: false }, () => false)
    expect(data).toEqual([{ table: 'note', columns: ['body'], count: 1, error: null }])
    // % 같은 글자는 글자 그대로 찾는다
    expect((await searchData(live.mod, s, 'main', '', '100%', { showSystem: false }, () => false))[0]?.count).toBe(1)
    expect(await searchData(live.mod, s, 'main', '', '%%%', { showSystem: false }, () => false)).toEqual([])
  })
})
