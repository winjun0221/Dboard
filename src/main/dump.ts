// SQL 덤프 쓰기(구조 DDL + 데이터 INSERT)와 SQL 파일 실행. Electron을 안 써서 vitest에서 그대로 시험한다.
// 순서: (DROP) → 표 CREATE(외래 키 부모 먼저) → 데이터 → 트리거(SQLite) → 뷰(다른 뷰를 쓰면 그 뒤에)
import fs from 'node:fs'
import path from 'node:path'
import { literal, qualify, quoteIdent } from '../shared/dialect'
import { decodeText, detectEncoding } from '../shared/csv'
import { t } from '../shared/i18n'
import { ddlReferences, referencedTables, splitSql } from '../shared/sql'
import type { Cell, ColumnInfo, Dialect, DumpObject, DumpOptions, SqlFileResult, TableRef } from '../shared/types'
import type { DriverModule, Session } from './drivers/base'

/** INSERT 한 문장이 이보다 길어지면 끊는다 */
const MAX_STATEMENT = 1_000_000
/** SQL Server: 이만큼 INSERT마다 GO (배치를 너무 크게 만들지 않게) */
const GO_EVERY = 50
const MAX_SQL_FILE = 256 * 1024 * 1024

/** deps(x)에 든 것을 x보다 먼저. 원래 순서를 되도록 지키고, 고리가 있으면 남은 것은 원래 순서대로 */
export function orderByDeps<T>(items: T[], deps: (x: T) => T[]): T[] {
  const set = new Set(items)
  const need = new Map(items.map((x) => [x, new Set(deps(x).filter((y) => y !== x && set.has(y)))]))
  const out: T[] = []
  const done = new Set<T>()
  while (out.length < items.length) {
    const next = items.find((x) => !done.has(x) && [...need.get(x)!].every((y) => done.has(y)))
    // 고리: 아직 안 쓴 것 중 맨 앞
    const pick = next ?? items.find((x) => !done.has(x))!
    out.push(pick)
    done.add(pick)
  }
  return out
}

interface Item {
  obj: DumpObject
  ref: TableRef
  /** 스크립트 안에서 쓰는 이름 (SQLite·MySQL은 DB를 빼서 다른 DB에도 넣을 수 있게) */
  name: string
  ddl: string
  cols: ColumnInfo[]
}

function scriptName(d: Dialect, ref: TableRef): string {
  if (d === 'postgres') return qualify(d, { db: '', schema: ref.schema, table: ref.table })
  if (d === 'mssql') return `${quoteIdent(d, ref.schema || 'dbo')}.${quoteIdent(d, ref.table)}`
  return quoteIdent(d, ref.table)
}

/** SQL Server datetime은 'YYYY-MM-DD hh:mm:ss'를 언어 설정에 따라 다르게 읽는다 → ISO 8601(T) */
function cellLiteral(d: Dialect, v: Cell, type: string): string {
  if (d === 'mssql' && typeof v === 'string' && /^(small)?datetime/i.test(type)) return literal(d, v.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'))
  return literal(d, v)
}

/** 끝에 ; 붙이기 (SQL Server는 GO로 나눔) */
function statementEnd(d: Dialect, sql: string): string {
  const s = sql.trim()
  if (d === 'mssql') return s + '\nGO\n'
  return (s.endsWith(';') ? s : s + ';') + '\n'
}

/** 디스크가 따라오게 쓰기 (drain 기다림) */
function writer(file: string) {
  const out = fs.createWriteStream(file, { encoding: 'utf8' })
  let failed: Error | null = null
  out.on('error', (e) => {
    failed = e
  })
  const write = (s: string) => new Promise<void>((resolve, reject) => {
    if (failed) return reject(failed)
    if (out.write(s)) return resolve()
    const done = (e?: Error) => {
      out.off('drain', done)
      out.off('error', done)
      if (e) reject(e)
      else resolve()
    }
    out.on('drain', done)
    out.on('error', done)
  })
  const end = () => new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
  return { write, end, destroy: () => out.destroy() }
}

const stamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export async function writeDump(
  s: Session,
  mod: DriverModule,
  db: string,
  schema: string,
  objects: DumpObject[],
  file: string,
  o: DumpOptions,
  about: { conn: string; version: string },
): Promise<{ tables: number; views: number; rows: number }> {
  const d = mod.dialect
  const items: Item[] = []
  for (const obj of objects) {
    const ref = { db, schema, table: obj.name }
    let ddl = await mod.ddl(s, ref, obj.kind)
    // MySQL 뷰: 만든 사람(DEFINER)·DB 이름을 빼서 다른 DB·계정에도 넣을 수 있게
    if (d === 'mysql' && obj.kind === 'view') ddl = ddl.replace(/\sDEFINER=`(?:[^`]|``)*`@`(?:[^`]|``)*`/, '').split(quoteIdent(d, db) + '.').join('')
    const cols = obj.kind === 'table' ? await mod.columns(s, ref) : []
    items.push({ obj, ref, name: scriptName(d, ref), ddl, cols })
  }
  const byName = (list: Item[]) => new Map(list.map((x) => [x.obj.name.toLowerCase(), x]))
  const pick = (map: Map<string, Item>, names: string[]) => names.map((n) => map.get(n.toLowerCase())).filter((x): x is Item => !!x)
  const tableList = items.filter((x) => x.obj.kind === 'table')
  const viewList = items.filter((x) => x.obj.kind === 'view')
  const tableMap = byName(tableList)
  const viewMap = byName(viewList)
  const tables = orderByDeps(tableList, (x) => pick(tableMap, ddlReferences(x.ddl, d)))
  const views = orderByDeps(viewList, (x) => pick(viewMap, referencedTables(x.ddl, d)))

  const w = writer(file)
  let rows = 0
  try {
    const kinds = o.structure && o.data ? t('구조 + 데이터') : o.structure ? t('구조만 (DDL)') : t('데이터만')
    await w.write([
      `-- ${t('DBoard SQL 덤프')}`,
      `-- ${t('접속')}: ${about.conn}${about.version ? ` (${about.version.split('\n')[0].slice(0, 80)})` : ''}`,
      `-- DB: ${db}${schema ? ` · ${t('스키마')}: ${schema}` : ''}`,
      `-- ${t('표 {t}개 · 뷰 {v}개 · {kinds}', { t: tables.length, v: o.structure ? views.length : 0, kinds })}`,
      `-- ${stamp()}`,
      '',
      '',
    ].join('\n'))
    if (d === 'sqlite') await w.write('PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;\n\n')
    else if (d === 'mysql') await w.write('SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n')
    else if (d === 'postgres') await w.write("SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\nBEGIN;\n\n")
    else await w.write('SET NOCOUNT ON;\nGO\n\n')

    // DROP은 다시 만들 때(구조 포함)만 — 데이터만 뽑을 때 표를 지우면 안 된다
    if (o.drop && o.structure) {
      const drops: string[] = []
      for (const v of [...views].reverse()) drops.push(`DROP ${/^\s*CREATE\s+MATERIALIZED\s+VIEW/i.test(v.ddl) ? 'MATERIALIZED VIEW' : 'VIEW'} IF EXISTS ${v.name};`)
      for (const x of [...tables].reverse()) drops.push(`DROP TABLE IF EXISTS ${x.name};`)
      if (drops.length) await w.write(drops.join('\n') + (d === 'mssql' ? '\nGO\n\n' : '\n\n'))
    }

    // 트리거는 데이터를 넣은 뒤에 (넣는 동안 돌지 않게)
    const later: string[] = []
    if (o.structure) {
      for (const x of tables) {
        await w.write(`-- ${t('표')}: ${x.obj.name}\n`)
        if (d === 'mssql') {
          await w.write(statementEnd(d, x.ddl.replace(/\n\s*GO\s*$/i, '')) + '\n')
          continue
        }
        for (const st of splitSql(x.ddl, d)) {
          if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(st.text)) later.push(statementEnd(d, st.text))
          else await w.write(statementEnd(d, st.text))
        }
        await w.write('\n')
      }
    }

    if (o.data) {
      for (const x of tables) rows += await writeRows(s, d, x, o, w.write)
    }

    if (later.length) await w.write(`-- ${t('트리거')}\n` + later.join('') + '\n')
    if (o.structure) {
      for (const v of views) await w.write(`-- ${t('뷰')}: ${v.obj.name}\n` + statementEnd(d, v.ddl) + '\n')
    }

    if (d === 'sqlite' || d === 'postgres') await w.write('COMMIT;\n')
    else if (d === 'mysql') await w.write('SET FOREIGN_KEY_CHECKS = 1;\n')
    await w.end()
  } catch (e) {
    w.destroy()
    // 반쯤 쓴 파일은 지운다
    fs.rmSync(file, { force: true })
    throw e
  }
  return { tables: tables.length, views: o.structure ? views.length : 0, rows }
}

async function writeRows(s: Session, d: Dialect, x: Item, o: DumpOptions, write: (s: string) => Promise<void>): Promise<number> {
  const cols = x.cols.filter((c) => !c.generated)
  if (cols.length === 0) return 0
  const types = cols.map((c) => c.type)
  const identity = d === 'mssql' && cols.some((c) => c.autoIncrement)
  const override = d === 'postgres' && /GENERATED\s+ALWAYS\s+AS\s+IDENTITY/i.test(x.ddl) ? ' OVERRIDING SYSTEM VALUE' : ''
  const head = `INSERT INTO ${x.name} (${cols.map((c) => quoteIdent(d, c.name)).join(', ')})${override} VALUES\n`
  const batch = Math.max(1, Math.min(o.batch, d === 'mssql' ? 1000 : 10_000))
  let buf: string[] = []
  let size = 0
  let statements = 0
  let started = false
  const begin = async () => {
    if (started) return
    started = true
    await write(`-- ${t('데이터')}: ${x.obj.name}\n`)
    if (identity) await write(`SET IDENTITY_INSERT ${x.name} ON;\n`)
  }
  const flush = async () => {
    if (!buf.length) return
    await begin()
    await write(head + buf.join(',\n') + ';\n')
    buf = []
    size = 0
    statements++
    if (d === 'mssql' && statements % GO_EVERY === 0) await write('GO\n')
  }
  const sql = `SELECT ${cols.map((c) => quoteIdent(d, c.name)).join(', ')} FROM ${qualify(d, x.ref)}`
  const n = await s.stream(sql, () => undefined, async (list) => {
    for (const r of list) {
      const v = '(' + r.map((c, i) => cellLiteral(d, c, types[i])).join(', ') + ')'
      buf.push(v)
      size += v.length + 2
      if (buf.length >= batch || size > MAX_STATEMENT) await flush()
    }
  })
  await flush()
  if (identity && started) await write(`SET IDENTITY_INSERT ${x.name} OFF;\n`)
  // PostgreSQL: 넣은 번호 다음부터 이어지게 시퀀스를 맞춘다
  if (d === 'postgres') {
    for (const c of cols.filter((col) => col.autoIncrement)) {
      await begin()
      await write(`SELECT setval(pg_get_serial_sequence(${literal(d, x.name)}, ${literal(d, c.name)}), COALESCE(MAX(${quoteIdent(d, c.name)}), 0) + 1, false) FROM ${x.name};\n`)
    }
  }
  if (started) await write(d === 'mssql' ? 'GO\n\n' : '\n')
  return n
}

/** .sql 파일을 문장마다 차례로 실행. 오류가 나면 되돌리고(열린 트랜잭션) 몇 번째 문장·줄인지 알려 준다 */
export async function runSqlFile(s: Session, d: Dialect, file: string): Promise<SqlFileResult> {
  const size = fs.statSync(file).size
  if (size > MAX_SQL_FILE) throw new Error(t('SQL 파일이 너무 커요 (256MB까지)'))
  const bytes = fs.readFileSync(file)
  const text = decodeText(bytes, detectEncoding(bytes)).replace(/^﻿/, '')
  const list = splitSql(text, d)
  const t0 = performance.now()
  for (let i = 0; i < list.length; i++) {
    try {
      await s.run(list[i].text, 1)
    } catch (e) {
      await s.run(d === 'mssql' ? 'IF @@TRANCOUNT > 0 ROLLBACK' : 'ROLLBACK', 1).catch(() => undefined)
      const line = text.slice(0, list[i].from).split('\n').length
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(t('{name}: {n}번째 문장({line}번째 줄)에서 멈췄어요. 앞의 {done}개는 실행됐어요(트랜잭션 안이면 되돌렸어요).\n{error}', { name: path.basename(file), n: i + 1, line, done: i, error: msg }))
    }
  }
  return { statements: list.length, ms: Math.round(performance.now() - t0) }
}

/** 구조를 바꾸는 문장들을 차례로 (표 설계·이름 바꾸기·지우기). 오류가 나면 되돌리기를 시도하고 몇 번째 문장인지 알린다 */
export async function runStatements(s: Session, d: Dialect, list: string[]): Promise<void> {
  // 다른 연결이 표를 잡고 있으면 한없이 기다리지 않게
  const wait = { postgres: "SET lock_timeout = '15s'", mysql: 'SET SESSION lock_wait_timeout = 15', mssql: 'SET LOCK_TIMEOUT 15000', sqlite: '' }[d]
  if (wait) await s.exec(wait).catch(() => undefined)
  for (let i = 0; i < list.length; i++) {
    try {
      await s.run(list[i], 1)
    } catch (e) {
      await s.run(d === 'mssql' ? 'IF @@TRANCOUNT > 0 ROLLBACK' : 'ROLLBACK', 1).catch(() => undefined)
      const sql = list[i].length > 300 ? list[i].slice(0, 300) + '…' : list[i]
      throw new Error(t('{n}번째 문장에서 멈췄어요. 앞의 {done}개는 실행됐어요(트랜잭션 안이면 되돌렸어요).\n{sql}\n{error}', { n: i + 1, done: i, sql, error: e instanceof Error ? e.message : String(e) }))
    }
  }
}
