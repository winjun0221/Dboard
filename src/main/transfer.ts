// 데이터 옮기기: 원본 표의 행을 대상 DB 표로 (다른 종류 DB도). 대상에 표가 없으면 타입을 맞춰 만들고, 같은 이름의 열만 옮긴다
import { designSql, tableName } from '../shared/alter'
import { convertDesign, orderByParents } from '../shared/compare'
import { quoteIdent } from '../shared/dialect'
import { t } from '../shared/i18n'
import type { Cell, TransferOptions, TransferResult } from '../shared/types'
import type { DriverModule, MetaOptions, Session } from './drivers/base'
import { runStatements } from './dump'

export interface TransferSide {
  mod: DriverModule
  s: Session
  db: string
  schema: string
  o: MetaOptions
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function transferData(src: TransferSide, dst: TransferSide, tables: string[], o: TransferOptions, isCancelled: () => boolean): Promise<TransferResult> {
  const t0 = performance.now()
  const sd = src.mod.dialect
  const dd = dst.mod.dialect
  const w = { db: dst.db, schema: dst.schema }
  const srcRef = (table: string) => ({ db: src.db, schema: src.schema, table })
  const dstRef = (table: string) => ({ db: dst.db, schema: dst.schema, table })
  const parents = new Map<string, string[]>()
  for (const n of tables) parents.set(n, (await src.mod.foreignKeys(src.s, srcRef(n))).map((f) => f.ref.table))
  const order = orderByParents(tables, (n) => parents.get(n) ?? [])
  const existing = new Map((await dst.mod.objects(dst.s, dst.db, dst.schema, dst.o)).filter((x) => x.kind === 'table').map((x) => [x.name.toLowerCase(), x.name]))
  const result: TransferResult = { tables: [], ms: 0 }

  // 외래 키 검사를 잠깐 끈다 (MySQL·SQLite: 이 연결에서만)
  if (dd === 'mysql') await dst.s.exec('SET FOREIGN_KEY_CHECKS = 0')
  if (dd === 'sqlite') await dst.s.exec('PRAGMA foreign_keys = OFF')
  try {
    for (const name of order) {
      if (isCancelled()) break
      const row = { name, rows: 0, created: false, error: null as string | null }
      result.tables.push(row)
      try {
        const sdesign = await src.mod.design(src.s, srcRef(name))
        let target = existing.get(name.toLowerCase())
        if (!target) {
          if (!o.create) throw new Error(t('대상에 같은 이름의 표가 없어요'))
          await runStatements(dst.s, dd, designSql(dd, w, null, convertDesign(sdesign, sd, dd)).statements)
          target = name
          existing.set(name.toLowerCase(), name)
          row.created = true
        } else if (o.truncate) {
          // ClickHouse의 DELETE는 표시만 하고 나중에 지워서 TRUNCATE로
          await dst.s.exec(`${dd === 'clickhouse' ? 'TRUNCATE TABLE' : 'DELETE FROM'} ${tableName(dd, w, target)}`)
        }
        const ddesign = await dst.mod.design(dst.s, dstRef(target))
        const dcols = new Map(ddesign.columns.filter((c) => !c.generated).map((c) => [c.name.toLowerCase(), c]))
        const pairs = sdesign.columns.filter((c) => !c.generated && dcols.has(c.name.toLowerCase())).map((c) => ({ from: c.name, to: dcols.get(c.name.toLowerCase())!.name }))
        if (!pairs.length) throw new Error(t('이름이 같은 열이 없어요'))
        const identity = ddesign.columns.some((c) => c.autoIncrement && pairs.some((p) => p.to === c.name))
        const tn = tableName(dd, w, target)
        const select = `SELECT ${pairs.map((p) => quoteIdent(sd, p.from)).join(', ')} FROM ${tableName(sd, { db: src.db, schema: src.schema }, name)}`
        const batch = Math.max(1, Math.min(o.batch, dd === 'mssql' ? Math.floor(2000 / pairs.length) : 1000))
        const cols = pairs.map((p) => p.to)
        row.rows = await dst.s.transaction(async (tx) => {
          if (dd === 'mssql' && identity) await tx.exec(`SET IDENTITY_INSERT ${tn} ON`)
          let n = 0
          let buf: Cell[][] = []
          const flush = async () => {
            if (!buf.length) return
            await tx.insertMany(dstRef(target!), cols, buf)
            n += buf.length
            buf = []
          }
          await src.s.stream(select, () => undefined, async (rows) => {
            if (isCancelled()) throw new Error(t('취소했어요'))
            for (const r of rows) {
              buf.push(r)
              if (buf.length >= batch) await flush()
            }
          })
          await flush()
          if (dd === 'mssql' && identity) await tx.exec(`SET IDENTITY_INSERT ${tn} OFF`)
          return n
        })
        // Oracle: IDENTITY를 옮긴 값 다음부터 (START WITH LIMIT VALUE = 지금 가장 큰 값 다음)
        if (dd === 'oracle' && identity) {
          const r = await dst.s.query(
            `SELECT i.column_name, i.generation_type, c.default_on_null FROM all_tab_identity_cols i
             JOIN all_tab_columns c ON c.owner = i.owner AND c.table_name = i.table_name AND c.column_name = i.column_name
             WHERE i.owner = :1 AND i.table_name = :2`,
            [dst.schema, target],
          ).catch(() => ({ rows: [] as Cell[][] }))
          for (const x of r.rows) {
            const gen = String(x[1]) === 'ALWAYS' ? 'ALWAYS' : String(x[2]) === 'YES' ? 'BY DEFAULT ON NULL' : 'BY DEFAULT'
            await dst.s.exec(`ALTER TABLE ${tn} MODIFY (${quoteIdent(dd, String(x[0]))} GENERATED ${gen} AS IDENTITY (START WITH LIMIT VALUE))`).catch(() => undefined)
          }
        }
        // PostgreSQL: 자동 번호를 옮긴 값 다음부터
        if (dd === 'postgres') {
          for (const c of ddesign.columns.filter((x) => x.autoIncrement || /^nextval\(/i.test(x.default))) {
            const col = quoteIdent(dd, c.name)
            await dst.s.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${col}) FROM ${tn}), 0) + 1, false)`, [tn, c.name]).catch(() => undefined)
          }
        }
      } catch (e) {
        row.error = msg(e)
        if (o.stopOnError) break
      }
    }
  } finally {
    if (dd === 'mysql') await dst.s.exec('SET FOREIGN_KEY_CHECKS = 1').catch(() => undefined)
    if (dd === 'sqlite') await dst.s.exec('PRAGMA foreign_keys = ON').catch(() => undefined)
  }
  result.ms = Math.round(performance.now() - t0)
  return result
}
