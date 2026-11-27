// ER 다이어그램 모델: 스키마(또는 DB)의 표·열·외래 키. 드라이버의 objects·columns·foreignKeys를 그대로 쓴다
import type { ErModel } from '../shared/types'
import type { DriverModule, MetaOptions, Session } from './drivers/base'

/** 표가 너무 많으면 앞쪽만 (그림이 읽히지 않고 오래 걸린다) */
export const ER_MAX_TABLES = 300

export async function erModel(mod: DriverModule, s: Session, db: string, schema: string, o: MetaOptions): Promise<ErModel> {
  const all = (await mod.objects(s, db, schema, o)).filter((x) => x.kind === 'table')
  const list = all.slice(0, ER_MAX_TABLES)
  const names = new Set(list.map((x) => x.name))
  const model: ErModel = { tables: [], links: [], truncated: all.length > list.length }
  for (const obj of list) {
    const ref = { db, schema, table: obj.name }
    const cols = await mod.columns(s, ref)
    model.tables.push({ name: obj.name, comment: obj.comment, columns: cols.map((c) => ({ name: c.name, type: c.type, pk: c.pk, nullable: c.nullable })) })
    for (const fk of await mod.foreignKeys(s, ref)) {
      // 같은 스키마(DB) 안의 표를 가리키는 것만 선으로
      const sameSchema = mod.dialect === 'mysql' ? fk.ref.db === db : mod.dialect === 'sqlite' ? true : fk.ref.schema === schema
      if (!sameSchema || !names.has(fk.ref.table)) continue
      model.links.push({ name: fk.name, from: obj.name, fromColumns: fk.columns, to: fk.ref.table, toColumns: fk.refColumns })
    }
  }
  return model
}
