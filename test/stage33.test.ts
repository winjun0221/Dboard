// 3-3단계(서버 없이): DuckDB 전체 시나리오·설계·덤프·옮기기, 엔진 받기(꾸러미 확인·풀기), 새 방언의 SQL 조각·문장 나누기·타입 바꾸기
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import { writeDump, runSqlFile } from '../src/main/dump'
import { explain } from '../src/main/explain'
import { searchData, searchNames } from '../src/main/search'
import { transferData } from '../src/main/transfer'
import { compareSchemas } from '../src/main/compare'
import { DUCKDB_ENGINE, installFromTgz, untar } from '../src/main/engines'
import { bindClickhouse, engineOf } from '../src/main/drivers/clickhouse'
import { oracleStatement } from '../src/main/drivers/oracle'
import { parseDuckExpressions } from '../src/main/drivers/duckdb'
import { chUnwrap, designSql, objectSql, dropExtraSql } from '../src/shared/alter'
import { convertDesign, mapType, mapDefault } from '../src/shared/compare'
import { likeCond, literal, placeholder, qualify, quoteIdent, selectPage, selectTop } from '../src/shared/dialect'
import { buildChange, buildInsertMany, inlineParams, previewChanges } from '../src/shared/edit'
import { defaultPlace, duckCatalog, features } from '../src/shared/features'
import { isPlsql, mask, splitSql, statementAt } from '../src/shared/sql'
import { userSql } from '../src/shared/users'
import type { TableDesign } from '../src/shared/types'
import { parsePlan } from '../src/renderer/src/components/PlanGraph'
import { config, exercise, memoryKeys, resolved } from './exercise'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dboard-33-'))
const o = { showSystem: false }

describe('duckdb', () => {
  it('full scenario on a file', async () => {
    const dir = tmp()
    const file = path.join(dir, 'shop.duckdb')
    const m = new Manager(memoryKeys())
    try {
      await exercise(m, 'duck', resolved(config('duckdb', { file })), async () => ({ db: 'shop', schema: 'main' }), async () => {})
    } finally {
      await m.disconnectAll()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('design → ALTER, dump round trip, explain, search, transfer from SQLite', async () => {
    const dir = tmp()
    const file = path.join(dir, 'a.b.duckdb')
    const m = new Manager(memoryKeys())
    try {
      const live = await m.connect('d', resolved(config('duckdb', { file })))
      // 파일 이름의 첫 점 앞이 카탈로그 이름
      expect(live.defaultDb).toBe('a')
      expect(duckCatalog(file)).toBe('a')
      const s = await live.metaSession()
      for (const sql of [
        'CREATE TABLE parent (id INTEGER PRIMARY KEY, code VARCHAR UNIQUE)',
        'CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id), qty DECIMAL(10,2) DEFAULT 0, note VARCHAR)',
        "INSERT INTO parent VALUES (1, 'x'), (2, 'y')",
        "INSERT INTO child VALUES (10, 1, 2.5, 'n1'), (11, 2, NULL, NULL)",
        "COMMENT ON TABLE child IS '자식'",
        'CREATE MACRO twice(x) AS x * 2',
      ]) await s.exec(sql)
      const ref = { db: 'a', schema: 'main', table: 'child' }
      const before = await live.mod.design(s, ref)
      expect(before).toMatchObject({ comment: '자식', primaryKey: ['id'], pkName: expect.stringMatching(/pkey/) })
      expect(before.foreignKeys[0]).toMatchObject({ columns: ['pid'], refTable: 'parent', refColumns: ['id'] })
      expect(before.columns.find((c) => c.name === 'qty')).toMatchObject({ type: 'DECIMAL(10,2)', default: expect.stringMatching(/0/) })
      const after: TableDesign = JSON.parse(JSON.stringify(before))
      after.columns.find((c) => c.name === 'note')!.name = 'memo'
      after.columns.find((c) => c.name === 'qty')!.nullable = false
      after.columns.find((c) => c.name === 'qty')!.default = '1'
      after.columns.push({ name: 'added', type: 'VARCHAR', nullable: true, default: "'z'", autoIncrement: false, comment: '새 열', generated: false, orig: null })
      after.indexes.push({ name: 'ix_child_memo', columns: ['memo'], unique: false, orig: null })
      // 0이 아닌 기본값 → NOT NULL로 바꾸기 전에 NULL을 채운다
      await s.exec('UPDATE child SET qty = 0 WHERE qty IS NULL')
      const r = designSql('duckdb', { db: 'a', schema: 'main' }, before, after)
      expect(r.statements[0]).toBe('BEGIN')
      for (const st of r.statements) await s.exec(st)
      const again = await live.mod.design(s, ref)
      expect(again.columns.map((c) => c.name)).toEqual(['id', 'pid', 'qty', 'memo', 'added'])
      expect(again.columns.find((c) => c.name === 'qty')).toMatchObject({ nullable: false })
      expect(again.columns.find((c) => c.name === 'added')).toMatchObject({ comment: '새 열' })
      expect(again.indexes.map((i) => i.name)).toContain('ix_child_memo')
      // 외래 키·기본 키는 바꿀 수 없다고 알려 준다
      expect(() => designSql('duckdb', { db: 'a', schema: 'main' }, again, { ...again, foreignKeys: [] })).toThrow(/외래 키/)
      // 개체: 매크로
      const extras = await live.mod.extras(s, 'a', 'main')
      expect(extras.find((x) => x.name === 'twice')?.kind).toBe('function')
      expect(await live.mod.source(s, 'a', 'main', 'function', 'twice')).toMatch(/MACRO .*twice.*\(x\) AS \(?x \* 2/)
      expect(dropExtraSql('duckdb', { db: 'a', schema: 'main' }, extras.find((x) => x.name === 'twice')!)).toBe('DROP MACRO "a"."main"."twice"')

      // 실행 계획
      const ed = await m.editorSession('d', 'tab', 'a', 'main')
      // RETURNING은 행으로, 그냥 UPDATE는 바뀐 행 수로
      const ret = await ed.run("UPDATE child SET memo = 'r' WHERE id = 11 RETURNING id, memo", 10)
      expect(ret[0]).toMatchObject({ columns: [{ name: 'id' }, { name: 'memo' }], rows: [[11, 'r']] })
      expect((await ed.run("UPDATE child SET memo = 'n2' WHERE id = 11", 10))[0]).toMatchObject({ columns: null, affected: 1 })
      const plan = await explain(ed, 'SELECT * FROM child WHERE id = 10')
      expect(plan.text).toMatch(/SCAN|Scan/)

      // 검색
      const hits = await searchNames(live.mod, async () => s, ['a'], 'memo', o)
      expect(hits.find((h) => h.kind === 'column')).toMatchObject({ table: 'child', name: 'memo' })
      const data = await searchData(live.mod, s, 'a', 'main', 'N1', o, () => false)
      expect(data).toEqual([expect.objectContaining({ table: 'child', count: 1 })])

      // 덤프 → 새 파일에 다시 넣기
      const out = path.join(dir, 'dump.sql')
      const res = await writeDump(s, live.mod, 'a', 'main', [{ name: 'parent', kind: 'table' }, { name: 'child', kind: 'table' }], out, { structure: true, data: true, drop: true, batch: 100 }, { conn: 'x', version: live.version })
      expect(res).toMatchObject({ tables: 2, rows: 4 })
      const text = fs.readFileSync(out, 'utf8')
      expect(text).toMatch(/BEGIN TRANSACTION;/)
      expect(text).toMatch(/DROP TABLE IF EXISTS "main"\."child";/)
      const live2 = await m.connect('d2', resolved(config('duckdb', { id: 'c-d2', file: path.join(dir, 'copy.duckdb') })))
      const s2 = await live2.metaSession()
      await runSqlFile(s2, 'duckdb', out)
      expect((await s2.query('SELECT count(*), sum(qty) FROM child')).rows[0]).toEqual([2, '2.50'])

      // SQLite → DuckDB 옮기기 (표를 새로 만들어서)
      const lite = path.join(dir, 'src.db')
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(lite)
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount REAL, blob BLOB); INSERT INTO t VALUES (1, '가', 1.5, X'0102'), (2, '나', NULL, NULL)")
      db.close()
      const src = await m.connect('lite', resolved(config('sqlite', { id: 'c-lite', file: lite })))
      const tr = await transferData(
        { mod: src.mod, s: await src.metaSession(), db: 'main', schema: '', o },
        { mod: live2.mod, s: s2, db: 'copy', schema: 'main', o },
        ['t'], { create: true, truncate: false, stopOnError: true, batch: 500 }, () => false,
      )
      expect(tr.tables[0]).toMatchObject({ name: 't', rows: 2, created: true, error: null })
      expect((await s2.query('SELECT name, amount, hex(blob) FROM t ORDER BY id')).rows).toEqual([['가', 1.5, '0102'], ['나', null, null]])

      // 비교: 같은 구조면 같음
      const cmp = await compareSchemas({ mod: live.mod, s, db: 'a', schema: 'main', o }, { mod: live2.mod, s: s2, db: 'copy', schema: 'main', o })
      expect(cmp.items.find((x) => x.name === 'parent')?.status).toBe('same')
    } finally {
      await m.disconnectAll()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('read-only connection opens the file read-only', async () => {
    const dir = tmp()
    const file = path.join(dir, 'ro.duckdb')
    const m = new Manager(memoryKeys())
    try {
      const w = await m.connect('w', resolved(config('duckdb', { id: 'c-w', file })))
      await (await w.metaSession()).exec('CREATE TABLE t (a INTEGER)')
      await m.disconnect('w')
      const live = await m.connect('r', resolved(config('duckdb', { id: 'c-r', file, readOnly: true })))
      const s = await live.metaSession()
      expect((await s.query('SELECT count(*) FROM t')).rows[0][0]).toBe(0)
      await expect(s.exec('INSERT INTO t VALUES (1)')).rejects.toThrow(/read-only|read only/i)
    } finally {
      await m.disconnectAll()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** 시험용 tar: 512바이트 머리 + 내용 */
function tar(files: Record<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = []
  for (const [name, data] of Object.entries(files)) {
    const h = new Uint8Array(512)
    h.set(Buffer.from(name), 0)
    h.set(Buffer.from(data.length.toString(8).padStart(11, '0') + '\0'), 124)
    h[156] = 48
    h.set(Buffer.from('ustar\0'), 257)
    parts.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512))
  }
  parts.push(new Uint8Array(1024))
  return Buffer.concat(parts)
}

describe('engine download', () => {
  it('pins the same version as @duckdb/node-api', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, string> }
    expect(pkg.devDependencies['@duckdb/node-api']).toBe(DUCKDB_ENGINE.version)
    expect(DUCKDB_ENGINE.url).toContain(DUCKDB_ENGINE.version)
    expect(DUCKDB_ENGINE.url.startsWith('https://registry.npmjs.org/')).toBe(true)
  })

  it('reads tar entries', () => {
    const files = untar(tar({ 'package/a.txt': Buffer.from('hello'), 'package/b.bin': new Uint8Array(700).fill(7) }))
    expect(Buffer.from(files.get('package/a.txt')!).toString()).toBe('hello')
    expect(files.get('package/b.bin')!.length).toBe(700)
  })

  it('refuses a package whose checksum does not match', () => {
    const tgz = gzipSync(tar({ 'package/duckdb.node': Buffer.from('x') }))
    expect(() => installFromTgz(tgz, 'sha512-' + Buffer.alloc(64).toString('base64'))).toThrow(/지문/)
  })
})

describe('new dialect pieces', () => {
  it('quotes and qualifies names', () => {
    expect(quoteIdent('clickhouse', 'a`b\\c')).toBe('`a\\`b\\\\c`')
    expect(quoteIdent('oracle', 'A"B')).toBe('"A""B"')
    expect(qualify('oracle', { db: 'FREEPDB1', schema: 'HR', table: 'EMP' })).toBe('"HR"."EMP"')
    expect(qualify('clickhouse', { db: 'logs', schema: '', table: 'hits' })).toBe('`logs`.`hits`')
    expect(qualify('duckdb', { db: 'shop', schema: '', table: 't' })).toBe('"shop"."main"."t"')
    expect(qualify('duckdb', { db: '', schema: '', table: 't' })).toBe('"t"')
    expect(placeholder('oracle', 3)).toBe(':3')
    expect(placeholder('duckdb', 2)).toBe('$2')
    expect(placeholder('clickhouse', 2)).toBe('?')
  })

  it('writes literals and pages', () => {
    expect(literal('clickhouse', "a'b\\c")).toBe("'a''b\\\\c'")
    expect(literal('oracle', { bin: '00ff', size: 2 })).toBe("HEXTORAW('00ff')")
    expect(literal('duckdb', { bin: '00ff', size: 2 })).toBe("from_hex('00ff')")
    expect(literal('clickhouse', true)).toBe('TRUE')
    expect(literal('oracle', true)).toBe('1')
    expect(selectPage('oracle', { db: '', schema: 'S', table: 'T' }, { filter: '', order: [], offset: 10, limit: 5 }, true))
      .toBe('SELECT ROWIDTOCHAR(t.ROWID) AS "__dboard_rowid", t.* FROM "S"."T" t OFFSET 10 ROWS FETCH NEXT 6 ROWS ONLY')
    expect(selectPage('duckdb', { db: 'x', schema: 'main', table: 't' }, { filter: '', order: [], offset: 0, limit: 5 }, true)).toBe('SELECT rowid AS "__dboard_rowid", * FROM "x"."main"."t" LIMIT 6')
    expect(selectTop('oracle', '"T"', 100)).toBe('SELECT * FROM "T" FETCH FIRST 100 ROWS ONLY')
    expect(likeCond('oracle', '"C"', ':1')).toBe(`UPPER("C") LIKE UPPER(:1) ESCAPE '\\'`)
    expect(likeCond('clickhouse', '`c`', '?')).toBe('toString(`c`) ILIKE ?')
  })

  it('builds row edits per dialect', () => {
    const ref = { db: '', schema: 'S', table: 'T' }
    const up = buildChange('oracle', ref, { kind: 'rowid', columns: [] }, { op: 'update', key: ['AAAx'], values: { A: 1 } })
    expect(up.sql).toBe('UPDATE "S"."T" SET "A" = :1 WHERE ROWID = :2')
    expect(inlineParams('oracle', up)).toBe(`UPDATE "S"."T" SET "A" = 1 WHERE ROWID = 'AAAx'`)
    const all = buildChange('oracle', ref, { kind: 'all', columns: ['A'] }, { op: 'delete', key: [1] })
    expect(all.sql).toBe('DELETE FROM "S"."T" WHERE "A" = :1 AND ROWNUM = 1')
    expect(() => buildChange('oracle', ref, { kind: 'pk', columns: ['A'] }, { op: 'insert', values: {} })).toThrow(/Oracle/)
    expect(previewChanges('oracle', ref, { kind: 'pk', columns: ['A'] }, [{ op: 'delete', key: [1] }])).toEqual(['DELETE FROM "S"."T" WHERE "A" = 1', 'COMMIT'])
    expect(previewChanges('clickhouse', { db: 'd', schema: '', table: 't' }, { kind: 'pk', columns: ['a'] }, [{ op: 'delete', key: [1] }])).toEqual(['DELETE FROM `d`.`t` WHERE `a` = 1'])
    // Oracle 여러 행 INSERT는 (미리 보기에서) 한 행씩
    expect(buildInsertMany('oracle', ref, ['A'], [[1], [2]]).map((b) => b.sql)).toEqual(['INSERT INTO "S"."T" ("A") VALUES (:1)', 'INSERT INTO "S"."T" ("A") VALUES (:1)'])
    expect(bindClickhouse("SELECT ? , '?' -- ?\n, ?", ["it's", 2])).toBe("SELECT 'it''s' , '?' -- ?\n, 2")
  })

  it('splits Oracle PL/SQL and masks q-quotes', () => {
    const src = [
      'CREATE TABLE t (a NUMBER);',
      'CREATE OR REPLACE PROCEDURE p (x IN NUMBER) AS',
      '  v NUMBER;',
      'BEGIN',
      '  IF x > 0 THEN v := 1; END IF;',
      '  FOR r IN (SELECT a FROM t) LOOP NULL; END LOOP;',
      'END;',
      '/',
      'CREATE OR REPLACE PACKAGE pk AS',
      '  PROCEDURE a;',
      '  TYPE n_tab IS TABLE OF NUMBER;',
      '  FUNCTION f RETURN NUMBER;',
      'END pk;',
      '/',
      'DECLARE',
      '  s VARCHAR2(10) := q\'[it\'s; ok]\';',
      'BEGIN NULL; END;',
      'SELECT 1 FROM dual;',
    ].join('\n')
    const list = splitSql(src, 'oracle').map((x) => x.text)
    expect(list).toHaveLength(5)
    // 끝의 ;는 나눌 때 빠지고, 보낼 때 oracleStatement가 PL/SQL이면 다시 붙인다
    expect(list[1]).toMatch(/^CREATE OR REPLACE PROCEDURE[\s\S]*END LOOP;\nEND$/)
    expect(list[2]).toMatch(/^CREATE OR REPLACE PACKAGE[\s\S]*END pk$/)
    expect(list[3]).toMatch(/^DECLARE[\s\S]*END$/)
    expect(oracleStatement(list[1]).endsWith('END;')).toBe(true)
    expect(list[4]).toBe('SELECT 1 FROM dual')
    expect(isPlsql(list[1])).toBe(true)
    expect(isPlsql(list[4])).toBe(false)
    expect(mask("x := q'[a'b]' || 'c'", 'oracle')).toBe('x := ' + ' '.repeat(8) + ' || ' + ' '.repeat(3))
    // 보낼 때: SQL은 ;를 빼고, PL/SQL은 END;까지
    expect(oracleStatement('SELECT 1 FROM dual;')).toBe('SELECT 1 FROM dual')
    expect(oracleStatement('BEGIN NULL; END')).toBe('BEGIN NULL; END;')
    expect(oracleStatement('BEGIN NULL; END;\n/')).toBe('BEGIN NULL; END;')
    // 커서 아래 문장: 프로시저 안의 빈 줄에서 끊지 않는다
    const proc = 'CREATE PROCEDURE q AS\nBEGIN\n  NULL;\n\n  NULL;\nEND;\n\nSELECT 2 FROM dual'
    expect(statementAt(proc, proc.indexOf('NULL;\n\n') + 2, 'oracle')?.text).toMatch(/^CREATE PROCEDURE[\s\S]*END;?$/)
  })

  it('masks ClickHouse comments and escapes', () => {
    expect(splitSql("SELECT 'a\\';b'; # x;y\nSELECT `c\\`;d`", 'clickhouse').map((x) => x.text)).toEqual(["SELECT 'a\\';b'", '# x;y\nSELECT `c\\`;d`'])
  })

  it('maps types between new dialects', () => {
    expect(mapType('oracle', 'postgres', 'NUMBER(10)')).toBe('bigint')
    expect(mapType('oracle', 'postgres', 'NUMBER(10,2)')).toBe('numeric(10,2)')
    expect(mapType('oracle', 'mysql', 'VARCHAR2(100 CHAR)')).toBe('varchar(100)')
    expect(mapType('oracle', 'postgres', 'DATE')).toBe('timestamp')
    expect(mapType('oracle', 'postgres', 'TIMESTAMP(6) WITH TIME ZONE')).toBe('timestamptz')
    expect(mapType('clickhouse', 'postgres', 'Int8')).toBe('smallint')
    expect(mapType('clickhouse', 'postgres', 'UInt64')).toBe('numeric(20,0)')
    expect(mapType('clickhouse', 'mysql', 'LowCardinality(String)')).toBe('longtext')
    expect(mapType('clickhouse', 'duckdb', 'Decimal(18, 4)')).toBe('DECIMAL(18,4)')
    expect(mapType('duckdb', 'postgres', 'FLOAT')).toBe('real')
    expect(mapType('postgres', 'oracle', 'varchar(20)')).toBe('VARCHAR2(20 CHAR)')
    expect(mapType('postgres', 'oracle', 'integer')).toBe('NUMBER(10)')
    expect(mapType('postgres', 'clickhouse', 'timestamptz')).toBe('DateTime64(6)')
    expect(mapType('mysql', 'duckdb', 'decimal(10,2)')).toBe('DECIMAL(10,2)')
    expect(mapDefault('SYSDATE', 'postgres')).toBe('CURRENT_TIMESTAMP')
    expect(mapDefault('now()', 'clickhouse')).toBe('now64(6)')
    const src: TableDesign = {
      name: 't', comment: '', primaryKey: ['id'], pkName: 'pk', unsupported: [], foreignKeys: [],
      indexes: [{ name: 'ix', columns: ['name'], unique: false, orig: 'ix' }],
      columns: [
        { name: 'id', type: 'integer', nullable: true, default: '', autoIncrement: true, comment: '', generated: false, orig: 'id' },
        { name: 'name', type: 'text', nullable: true, default: '', autoIncrement: false, comment: '', generated: false, orig: 'name' },
      ],
    }
    const ch = convertDesign(src, 'postgres', 'clickhouse')
    expect(ch.columns[0]).toMatchObject({ type: 'Int32', nullable: false, autoIncrement: false })
    expect(ch.indexes).toEqual([])
    expect(designSql('clickhouse', { db: 'd', schema: '' }, null, ch).statements[0]).toBe(
      'CREATE TABLE `d`.`t` (\n  `id` Int32,\n  `name` Nullable(String)\n)\nENGINE = MergeTree\nORDER BY (`id`)')
    const ora = convertDesign(src, 'postgres', 'oracle')
    // 키 열의 CLOB은 인덱스를 못 만들어서 VARCHAR2로
    expect(ora.columns.map((c) => c.type)).toEqual(['NUMBER(10)', 'VARCHAR2(1000 CHAR)'])
    expect(designSql('oracle', { db: '', schema: 'S' }, null, ora).statements).toEqual([
      'CREATE TABLE "S"."t" (\n  "id" NUMBER(10) GENERATED BY DEFAULT ON NULL AS IDENTITY,\n  "name" VARCHAR2(1000 CHAR),\n  PRIMARY KEY ("id")\n)',
      'CREATE INDEX "S"."ix" ON "S"."t" ("name")',
    ])
  })

  it('builds Oracle and ClickHouse ALTER statements', () => {
    const base: TableDesign = {
      name: 'T', comment: '', primaryKey: ['ID'], pkName: 'T_PK', unsupported: [], foreignKeys: [], indexes: [],
      columns: [
        { name: 'ID', type: 'NUMBER(10)', nullable: false, default: '', autoIncrement: true, comment: '', generated: false, orig: 'ID' },
        { name: 'NAME', type: 'VARCHAR2(50)', nullable: false, default: '', autoIncrement: false, comment: '', generated: false, orig: 'NAME' },
      ],
    }
    const after: TableDesign = JSON.parse(JSON.stringify(base))
    after.columns[1] = { ...after.columns[1], name: 'TITLE', type: 'VARCHAR2(100)', default: "'x'", comment: '제목' }
    after.columns.push({ name: 'N', type: 'NUMBER', nullable: true, default: '', autoIncrement: false, comment: '', generated: false, orig: null })
    after.name = 'T2'
    const r = designSql('oracle', { db: '', schema: 'S' }, base, after)
    expect(r.statements).toEqual([
      'ALTER TABLE "S"."T" RENAME COLUMN "NAME" TO "TITLE"',
      `ALTER TABLE "S"."T" MODIFY ("TITLE" VARCHAR2(100) DEFAULT 'x')`,
      `COMMENT ON COLUMN "S"."T"."TITLE" IS '제목'`,
      'ALTER TABLE "S"."T" ADD ("N" NUMBER)',
      'ALTER TABLE "S"."T" RENAME TO "T2"',
    ])
    expect(r.warnings[0]).toMatch(/Oracle/)
    // 있는 열을 IDENTITY로는 못 바꾼다
    const noId: TableDesign = JSON.parse(JSON.stringify(base))
    noId.columns[0].autoIncrement = false
    expect(() => designSql('oracle', { db: '', schema: 'S' }, noId, base)).toThrow(/IDENTITY/)
    expect(objectSql('oracle', { db: '', schema: 'S', table: 'V' }, 'view', 'rename', 'W')).toEqual(['RENAME "V" TO "W"'])
    expect(objectSql('clickhouse', { db: 'd', schema: '', table: 't' }, 'table', 'rename', 'u')).toEqual(['RENAME TABLE `d`.`t` TO `d`.`u`'])

    const ch: TableDesign = {
      name: 't', comment: '', primaryKey: ['id'], pkName: '', unsupported: [], foreignKeys: [], indexes: [], options: 'MergeTree',
      columns: [
        { name: 'id', type: 'UInt64', nullable: false, default: '', autoIncrement: false, comment: '', generated: false, orig: 'id' },
        { name: 'v', type: 'Int32', nullable: true, default: '', autoIncrement: false, comment: '', generated: false, orig: 'v' },
      ],
    }
    const ch2: TableDesign = JSON.parse(JSON.stringify(ch))
    ch2.columns[1] = { ...ch2.columns[1], type: 'Int64', nullable: false, default: '0' }
    expect(designSql('clickhouse', { db: 'd', schema: '' }, ch, ch2).statements).toEqual(['ALTER TABLE `d`.`t` MODIFY COLUMN `v` Int64 DEFAULT 0'])
    expect(() => designSql('clickhouse', { db: 'd', schema: '' }, ch, { ...ch2, primaryKey: ['v'] })).toThrow(/정렬 키/)
    expect(chUnwrap('Nullable(Decimal(10, 2))')).toEqual({ type: 'Decimal(10, 2)', nullable: true })
    expect(engineOf('ReplacingMergeTree(ver) ORDER BY id SETTINGS index_granularity = 8192')).toBe('ReplacingMergeTree(ver)')
  })

  it('builds user SQL for Oracle and ClickHouse (passwords masked)', () => {
    expect(userSql('oracle', { kind: 'create', name: 'app', host: '', password: 'p@ss', login: true }, true)).toEqual(['CREATE USER "app" IDENTIFIED BY "********"', 'GRANT CREATE SESSION TO "app"'])
    expect(() => userSql('oracle', { kind: 'password', name: 'app', host: '', password: 'a"b' }, false)).toThrow(/큰따옴표/)
    const g = userSql('oracle', { kind: 'grant', name: 'APP', host: '', privileges: ['SELECT'], db: '', schema: 'HR', table: '' }, false)[0]
    expect(g).toMatch(/^BEGIN\n  FOR o IN \(SELECT object_name FROM all_objects WHERE owner = 'HR'/)
    expect(g).toContain(`EXECUTE IMMEDIATE 'GRANT SELECT ON "HR"."' || REPLACE(o.object_name, '"', '""') || '" TO "APP"';`)
    expect(userSql('clickhouse', { kind: 'grant', name: 'u', host: '', privileges: ['SELECT', 'DELETE'], db: 'd', schema: '', table: '' }, false)).toEqual(['GRANT SELECT, ALTER DELETE ON `d`.* TO `u`'])
    expect(userSql('clickhouse', { kind: 'create', name: 'u', host: '', password: 'x', login: true }, true)).toEqual(["CREATE USER `u` IDENTIFIED BY '********'"])
  })

  it('reads an Oracle DBMS_XPLAN table as a tree', () => {
    const text = [
      'Plan hash value: 1234',
      '',
      '---------------------------------------------------------------------------',
      '| Id  | Operation                    | Name  | Rows  | Bytes | Cost (%CPU)|',
      '---------------------------------------------------------------------------',
      '|   0 | SELECT STATEMENT             |       |     1 |    26 |     2   (0)|',
      '|   1 |  TABLE ACCESS BY INDEX ROWID | CHILD |  1.5K |    26 |     2   (0)|',
      '|*  2 |   INDEX UNIQUE SCAN          | PK_C  |     1 |       |     1   (0)|',
      '---------------------------------------------------------------------------',
      '',
      'Predicate Information (identified by operation id):',
      '---------------------------------------------------',
      '',
      '   2 - access("ID"=1)',
    ].join('\n')
    const roots = parsePlan(text, 'oracle')
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatchObject({ label: 'SELECT STATEMENT', cost: 2, rows: 1 })
    const access = roots[0].children[0]
    expect(access).toMatchObject({ label: 'TABLE ACCESS BY INDEX ROWID CHILD', rows: 1500 })
    expect(access.children[0]).toMatchObject({ label: 'INDEX UNIQUE SCAN PK_C', cost: 1, details: ['access("ID"=1)'] })
    expect(parsePlan('┌───┐\n│ x │\n└───┘', 'duckdb')).toEqual([])
    expect(parsePlan('Expression\n  ReadFromMergeTree (d.t)', 'clickhouse')[0].children[0].label).toBe('ReadFromMergeTree (d.t)')
  })

  it('knows defaults and features', () => {
    expect(defaultPlace({ driver: 'oracle', database: 'FREEPDB1', file: '', user: 'scott' })).toEqual({ db: 'FREEPDB1', schema: 'SCOTT' })
    expect(defaultPlace({ driver: 'duckdb', database: '', file: 'C:\\x\\shop.v1.duckdb', user: '' })).toEqual({ db: 'shop', schema: 'main' })
    expect(defaultPlace({ driver: 'clickhouse', database: '', file: '', user: 'default' })).toEqual({ db: 'default', schema: '' })
    expect(features('clickhouse')).toMatchObject({ transactions: false, editRows: false, foreignKeys: false })
    expect(features('duckdb')).toMatchObject({ server: false, rowid: 'rowid' })
    expect(parseDuckExpressions(`['"name"', price, '(lower("x"))']`, '(식)')).toEqual(['name', 'price', '(식)'])
  })
})
