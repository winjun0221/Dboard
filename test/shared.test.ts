import { describe, expect, it } from 'vitest'
import { detectDelimiter, detectEncoding, parseCsv, csvLine } from '../src/shared/csv'
import { literal, qualify, quoteIdent, selectPage } from '../src/shared/dialect'
import { buildChange, buildInsertMany, inlineParams, previewChanges } from '../src/shared/edit'
import { firstKeyword, isDangerous, isReadOnlyQuery, mask, splitSql, statementAt } from '../src/shared/sql'

const texts = (src: string, d: Parameters<typeof splitSql>[1], o?: Parameters<typeof splitSql>[2]) => splitSql(src, d, o).map((s) => s.text)

describe('splitSql', () => {
  it('splits on semicolons outside strings and comments', () => {
    expect(texts("SELECT 'a;b'; SELECT 2 -- x;y\n; /* ; */ SELECT 3", 'sqlite')).toEqual(["SELECT 'a;b'", 'SELECT 2 -- x;y', '/* ; */ SELECT 3'])
  })
  it('drops comment-only pieces', () => {
    expect(texts('-- only comment\n;\nSELECT 1;', 'postgres')).toEqual(['SELECT 1'])
  })
  it('keeps postgres dollar-quoted bodies together', () => {
    const src = `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nSELECT f();`
    expect(texts(src, 'postgres')).toHaveLength(2)
    expect(texts('DO $body$ BEGIN PERFORM 1; END $body$; SELECT 1', 'postgres')).toHaveLength(2)
  })
  it('postgres BEGIN; is a transaction, not a block', () => {
    expect(texts('BEGIN; UPDATE t SET a = 1; COMMIT;', 'postgres')).toEqual(['BEGIN', 'UPDATE t SET a = 1', 'COMMIT'])
  })
  it('keeps sqlite trigger body together', () => {
    const src = 'CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = 1; INSERT INTO log VALUES (1); END;\nSELECT 1;'
    expect(texts(src, 'sqlite')).toEqual(['CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = 1; INSERT INTO log VALUES (1); END', 'SELECT 1'])
  })
  it('CASE … END does not break splitting', () => {
    expect(texts("SELECT CASE WHEN a THEN 'x;' ELSE 'y' END FROM t; SELECT 2", 'mysql')).toHaveLength(2)
  })
  it('mysql DELIMITER and backslash strings', () => {
    const src = "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 'it\\'s;'; SELECT 3"
    expect(texts(src, 'mysql')).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', "SELECT 'it\\'s;'", 'SELECT 3'])
  })
  it('mysql # comments and backticks', () => {
    expect(texts('SELECT `a;b` FROM t # c;d\n; SELECT 2', 'mysql')).toHaveLength(2)
  })
  it('sql server splits only on GO by default (variables stay together)', () => {
    const src = 'DECLARE @x int = 1;\nSELECT @x;\nGO\nSELECT [a;b] FROM t\ngo 2\nSELECT 3'
    expect(texts(src, 'mssql')).toEqual(['DECLARE @x int = 1;\nSELECT @x;', 'SELECT [a;b] FROM t', 'SELECT 3'])
  })
  it('sql server BEGIN TRY … END TRY with semicolons', () => {
    const src = 'BEGIN TRY SELECT 1; SELECT 2; END TRY BEGIN CATCH SELECT 3; END CATCH; SELECT 4'
    expect(texts(src, 'mssql', { semicolon: true })).toHaveLength(2)
  })
  it('blank lines split only outside parentheses', () => {
    expect(texts('SELECT 1\n\nSELECT 2', 'sqlite', { blankLines: true })).toEqual(['SELECT 1', 'SELECT 2'])
    expect(texts('SELECT (\n\n1)', 'sqlite', { blankLines: true })).toEqual(['SELECT (\n\n1)'])
    expect(texts("SELECT 'a\n\nb'", 'sqlite', { blankLines: true })).toHaveLength(1)
  })
  it('mask keeps length and hides literals', () => {
    const src = "SELECT 'x' -- c\n/* d */ \"q\""
    const m = mask(src, 'postgres')
    expect(m.length).toBe(src.length)
    expect(m.trim()).toBe('SELECT')
  })
})

describe('statementAt', () => {
  const src = 'SELECT 1;\nSELECT 2\nFROM t;\n\nSELECT 3'
  it('finds the statement under the cursor', () => {
    expect(statementAt(src, 3, 'sqlite')?.text).toBe('SELECT 1')
    expect(statementAt(src, src.indexOf('FROM'), 'sqlite')?.text).toBe('SELECT 2\nFROM t')
    expect(statementAt(src, src.length, 'sqlite')?.text).toBe('SELECT 3')
  })
  it('right after a semicolon belongs to that statement', () => {
    expect(statementAt(src, src.indexOf(';') + 1, 'sqlite')?.text).toBe('SELECT 1')
  })
  it('blank line between statements separates them', () => {
    expect(statementAt('SELECT 1\n\nSELECT 2', 0, 'mysql')?.text).toBe('SELECT 1')
  })
  it('sql server uses semicolons for the cursor statement', () => {
    expect(statementAt('SELECT 1; SELECT 2', 12, 'mssql')?.text).toBe('SELECT 2')
  })
})

describe('keywords', () => {
  it('firstKeyword skips comments', () => {
    expect(firstKeyword('-- hi\n/* x */ select 1', 'postgres')).toBe('SELECT')
  })
  it('isDangerous: UPDATE/DELETE without WHERE', () => {
    expect(isDangerous('DELETE FROM t', 'sqlite')).toBe(true)
    expect(isDangerous('UPDATE t SET a = (SELECT b FROM u WHERE c = 1)', 'sqlite')).toBe(true)
    expect(isDangerous('DELETE FROM t WHERE id = 1', 'sqlite')).toBe(false)
    expect(isDangerous("UPDATE t SET a = 'where'", 'mysql')).toBe(true)
    expect(isDangerous('SELECT * FROM t', 'mysql')).toBe(false)
  })
  it('isReadOnlyQuery', () => {
    expect(isReadOnlyQuery('SELECT * FROM t', 'postgres')).toBe(true)
    expect(isReadOnlyQuery('WITH x AS (SELECT 1) SELECT * FROM x', 'postgres')).toBe(true)
    expect(isReadOnlyQuery('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgres')).toBe(false)
    expect(isReadOnlyQuery('SELECT * INTO t2 FROM t', 'mssql')).toBe(false)
    expect(isReadOnlyQuery('SELECT updated_at FROM t', 'mysql')).toBe(true)
  })
})

describe('dialect', () => {
  it('quotes identifiers safely', () => {
    expect(quoteIdent('postgres', 'a"b')).toBe('"a""b"')
    expect(quoteIdent('mysql', 'a`b')).toBe('`a``b`')
    expect(quoteIdent('mssql', 'a]b')).toBe('[a]]b]')
  })
  it('qualifies table names', () => {
    expect(qualify('sqlite', { db: 'main', schema: '', table: 't' })).toBe('"main"."t"')
    expect(qualify('mysql', { db: 'shop', schema: '', table: 't' })).toBe('`shop`.`t`')
    expect(qualify('postgres', { db: 'x', schema: 'public', table: 't' })).toBe('"public"."t"')
    expect(qualify('mssql', { db: 'shop', schema: 'dbo', table: 't' })).toBe('[shop].[dbo].[t]')
  })
  it('literals', () => {
    expect(literal('postgres', "it's")).toBe("'it''s'")
    expect(literal('mysql', 'a\\b')).toBe("'a\\\\b'")
    expect(literal('mssql', '한글')).toBe("N'한글'")
    expect(literal('postgres', true)).toBe('TRUE')
    expect(literal('sqlite', null)).toBe('NULL')
  })
  it('pages', () => {
    const q = { filter: 'a > 1 -- comment', order: [{ column: 'id', desc: true }], offset: 20, limit: 10 }
    expect(selectPage('postgres', { db: '', schema: 'public', table: 't' }, q, false)).toBe('SELECT * FROM "public"."t" WHERE (\na > 1 -- comment\n) ORDER BY "id" DESC LIMIT 11 OFFSET 20')
    expect(selectPage('mssql', { db: 'd', schema: 'dbo', table: 't' }, { ...q, order: [] }, false)).toContain('ORDER BY (SELECT NULL) OFFSET 20 ROWS FETCH NEXT 11 ROWS ONLY')
    expect(selectPage('sqlite', { db: 'main', schema: '', table: 't' }, { filter: '', order: [], offset: 0, limit: 5 }, true)).toBe('SELECT _rowid_ AS "__dboard_rowid", * FROM "main"."t" LIMIT 6')
  })
})

describe('edit statements', () => {
  const ref = { db: 'shop', schema: 'public', table: 'items' }
  it('update by primary key with params', () => {
    const b = buildChange('postgres', ref, { kind: 'pk', columns: ['id'] }, { op: 'update', key: [5], values: { name: "O'Neil", price: null } })
    expect(b.sql).toBe('UPDATE "public"."items" SET "name" = $1, "price" = $2 WHERE "id" = $3')
    expect(b.params).toEqual(["O'Neil", null, 5])
    expect(b.expectOne).toBe(true)
    expect(inlineParams('postgres', b)).toBe(`UPDATE "public"."items" SET "name" = 'O''Neil', "price" = NULL WHERE "id" = 5`)
  })
  it('delete by all columns limits to one row', () => {
    const key = { kind: 'all' as const, columns: ['a', 'b'] }
    expect(buildChange('mysql', ref, key, { op: 'delete', key: [1, null] }).sql).toBe('DELETE FROM `shop`.`items` WHERE `a` = ? AND `b` IS NULL LIMIT 1')
    expect(buildChange('mssql', ref, key, { op: 'delete', key: [1, 'x'] }).sql).toBe('DELETE TOP (1) FROM [shop].[public].[items] WHERE [a] = @p1 AND [b] = @p2')
    expect(buildChange('postgres', ref, key, { op: 'delete', key: [1, 2] }).sql).toContain('WHERE ctid = (SELECT ctid FROM')
  })
  it('sqlite rowid and insert', () => {
    const r = { db: 'main', schema: '', table: 't' }
    expect(buildChange('sqlite', r, { kind: 'rowid', columns: [] }, { op: 'delete', key: [7] }).sql).toBe('DELETE FROM "main"."t" WHERE _rowid_ = ?')
    expect(buildChange('sqlite', r, { kind: 'rowid', columns: [] }, { op: 'insert', values: {} }).sql).toBe('INSERT INTO "main"."t" DEFAULT VALUES')
    expect(buildChange('mysql', ref, { kind: 'pk', columns: ['id'] }, { op: 'insert', values: {} }).sql).toBe('INSERT INTO `shop`.`items` () VALUES ()')
  })
  it('preview wraps in a transaction', () => {
    const p = previewChanges('mssql', ref, { kind: 'pk', columns: ['id'] }, [{ op: 'insert', values: { name: 'a?' } }])
    expect(p).toEqual(['BEGIN TRANSACTION', "INSERT INTO [shop].[public].[items] ([name]) VALUES (N'a?')", 'COMMIT'])
    expect(inlineParams('sqlite', { sql: 'UPDATE "a?" SET "b" = ? WHERE "c" = ?', params: ['x', 1], expectOne: true })).toBe(`UPDATE "a?" SET "b" = 'x' WHERE "c" = 1`)
  })
  it('insert many respects parameter limits', () => {
    const rows = Array.from({ length: 2500 }, (_, i) => [i, 'x'])
    const b = buildInsertMany('mssql', ref, ['a', 'b'], rows)
    expect(b.every((x) => x.params.length <= 2000)).toBe(true)
    expect(b.reduce((n, x) => n + x.params.length / 2, 0)).toBe(2500)
  })
})

describe('csv', () => {
  it('round trip with quotes, newlines, delimiters', () => {
    const line = csvLine(['a,b', 'say "hi"', 'x\ny', null, 3, { bin: 'ff00', size: 2 }], ',', 'NULL')
    expect(line).toBe('"a,b","say ""hi""","x\ny",NULL,3,0xff00')
    expect(parseCsv(line + '\r\nz,,1\r\n', ',')).toEqual([['a,b', 'say "hi"', 'x\ny', 'NULL', '3', '0xff00'], ['z', '', '1']])
  })
  it('strips BOM and detects delimiter', () => {
    expect(parseCsv('﻿a;b\n1;2', ';')).toEqual([['a', 'b'], ['1', '2']])
    expect(detectDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t')
    expect(detectDelimiter('a;b\n1;2\n')).toBe(';')
    expect(detectDelimiter('a,b\n"1,5",2\n')).toBe(',')
  })
  it('detects EUC-KR vs UTF-8', () => {
    expect(detectEncoding(new TextEncoder().encode('이름,나이'))).toBe('utf8')
    // '이름' in EUC-KR
    expect(detectEncoding(new Uint8Array([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0x31]))).toBe('euc-kr')
  })
})
