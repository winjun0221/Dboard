// 전체 검색: 이름(드라이버 searchNames를 DB마다)과 데이터(표마다 글 열에 LIKE로 행 수)
import { likeCond, placeholder, qualify, quoteIdent } from '../shared/dialect'
import type { DataHit, SearchHit } from '../shared/types'
import type { DriverModule, MetaOptions, Session } from './drivers/base'

/** 글이 들어 있을 만한 열 타입 */
const TEXTY = /char|text|clob|json|uuid|xml|string|enum|\bset\b|\bname\b|citext|uniqueidentifier/i

/** LIKE 패턴: %·_·\는 글자 그대로 (ESCAPE '\') */
export const likeOf = (text: string) => '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%'

export async function searchNames(mod: DriverModule, sessionFor: (db: string) => Promise<Session>, dbs: string[], text: string, o: MetaOptions, limit = 3000): Promise<SearchHit[]> {
  const like = likeOf(text)
  const out: SearchHit[] = []
  for (const db of dbs) {
    try {
      out.push(...(await mod.searchNames(await sessionFor(db), db, like, o)))
    } catch {
      // 권한이 없는 DB 등은 건너뛴다
    }
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
}

export async function searchData(mod: DriverModule, s: Session, db: string, schema: string, text: string, o: MetaOptions, cancelled: () => boolean): Promise<DataHit[]> {
  const d = mod.dialect
  const like = likeOf(text)
  const tables = (await mod.objects(s, db, schema, o)).filter((x) => x.kind === 'table').slice(0, 1000)
  const out: DataHit[] = []
  for (const obj of tables) {
    if (cancelled()) break
    const ref = { db, schema, table: obj.name }
    try {
      const cols = (await mod.columns(s, ref)).filter((c) => TEXTY.test(c.type))
      if (!cols.length) continue
      const cond = cols.map((c, i) => likeCond(d, quoteIdent(d, c.name), placeholder(d, i + 1))).join(' OR ')
      const r = await s.query(`SELECT COUNT(*) FROM ${qualify(d, ref)} WHERE ${cond}`, cols.map(() => like))
      const count = Number(r.rows[0]?.[0] ?? 0)
      if (count > 0) out.push({ table: obj.name, columns: cols.map((c) => c.name), count, error: null })
    } catch (e) {
      out.push({ table: obj.name, columns: [], count: 0, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}
