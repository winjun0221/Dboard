// 스키마 비교: 원본과 대상의 표 설계를 맞대어 대상을 원본처럼 만드는 SQL을 표마다 만든다. 뷰는 정의만 비교
import { designSql, objectSql } from '../shared/alter'
import { alignDesign, describeDiff, normViewSql, orderByParents } from '../shared/compare'
import { t } from '../shared/i18n'
import type { CompareItem, CompareResult, Dialect, TableDesign } from '../shared/types'
import type { DriverModule, MetaOptions, Session } from './drivers/base'

export interface Side {
  mod: DriverModule
  s: Session
  db: string
  schema: string
  o: MetaOptions
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function compareSchemas(src: Side, dst: Side): Promise<CompareResult> {
  const d: Dialect = dst.mod.dialect
  const w = { db: dst.db, schema: dst.schema }
  // 원본의 참조 스키마(MySQL은 DB) → 대상
  const srcHome = d === 'mysql' ? src.db : src.schema
  const dstHome = d === 'mysql' ? dst.db : dst.schema
  const mapSchema = (s: string) => (!s || s.toLowerCase() === srcHome.toLowerCase() ? dstHome : s)
  const so = await src.mod.objects(src.s, src.db, src.schema, src.o)
  const to = await dst.mod.objects(dst.s, dst.db, dst.schema, dst.o)
  const dstByName = new Map(to.map((x) => [x.name.toLowerCase(), x]))
  const srcNames = new Set(so.map((x) => x.name.toLowerCase()))
  const ref = (side: Side, table: string) => ({ db: side.db, schema: side.schema, table })

  const created: CompareItem[] = []
  const changed: CompareItem[] = []
  const views: CompareItem[] = []
  const designs = new Map<string, TableDesign>()
  for (const o of so) {
    const other = dstByName.get(o.name.toLowerCase())
    if (o.kind === 'view') {
      const a = await src.mod.ddl(src.s, ref(src, o.name), 'view').catch(() => '')
      if (!other || other.kind !== 'view') {
        views.push({ name: o.name, kind: 'view', status: 'source', changes: [t('대상에 없는 뷰')], statements: [], warnings: [], error: null })
        continue
      }
      const b = await dst.mod.ddl(dst.s, ref(dst, other.name), 'view').catch(() => '')
      const eq = normViewSql(a) === normViewSql(b)
      views.push({ name: o.name, kind: 'view', status: eq ? 'same' : 'changed', changes: eq ? [] : [t('뷰 정의가 달라요')], statements: [], warnings: [], error: null })
      continue
    }
    const item: CompareItem = { name: o.name, kind: 'table', status: 'same', changes: [], statements: [], warnings: [], error: null }
    try {
      const a = await src.mod.design(src.s, ref(src, o.name))
      designs.set(o.name, a)
      if (!other || other.kind !== 'table') {
        item.status = 'source'
        item.changes = [t('대상에 없는 표')]
        const fresh: TableDesign = {
          ...a,
          columns: a.columns.map((c) => ({ ...c, orig: null })),
          // 식 인덱스는 빼고(열 이름으로 다시 만들 수 없음), 나머지는 열로 다시 만든다
          indexes: a.indexes.filter((i) => !i.columns.includes(t('(식)'))).map((i) => ({ ...i, sql: undefined, orig: null, ...(i.name.startsWith('sqlite_') ? { name: `uq_${a.name}_${i.columns.join('_')}` } : {}) })),
          foreignKeys: a.foreignKeys.map((f) => ({ ...f, refSchema: mapSchema(f.refSchema), orig: null })),
          pkName: '',
        }
        const r = designSql(d, w, null, fresh)
        item.statements = r.statements
        item.warnings = r.warnings
        created.push(item)
        continue
      }
      const b = await dst.mod.design(dst.s, ref(dst, other.name))
      const after = alignDesign(a, b, mapSchema)
      item.changes = describeDiff(b, after, d)
      if (item.changes.length) {
        item.status = 'changed'
        const r = designSql(d, w, b, after)
        item.statements = r.statements
        item.warnings = r.warnings
      }
    } catch (e) {
      item.status = item.status === 'same' ? 'changed' : item.status
      item.error = msg(e)
    }
    if (item.status === 'source') created.push(item)
    else changed.push(item)
  }
  // 대상에만 있는 것 (지우기는 화면에서 골라야 들어간다)
  const dropped: CompareItem[] = to.filter((x) => !srcNames.has(x.name.toLowerCase())).map((x) => ({
    name: x.name,
    kind: x.kind,
    status: 'target' as const,
    changes: [x.kind === 'view' ? t('원본에 없는 뷰') : t('원본에 없는 표')],
    statements: x.kind === 'table' ? objectSql(d, ref(dst, x.name), 'table', 'drop') : [],
    warnings: [],
    error: null,
  }))
  // 새로 만들 표는 외래 키 부모가 먼저
  const order = orderByParents(created.map((x) => x.name), (n) => (designs.get(n)?.foreignKeys ?? []).map((f) => f.refTable))
  const byName = new Map(created.map((x) => [x.name, x]))
  return { dialect: d, items: [...order.map((n) => byName.get(n)!), ...changed, ...dropped, ...views] }
}
