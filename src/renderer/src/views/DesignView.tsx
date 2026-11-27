// 표 설계: 열·기본 키·인덱스·외래 키를 고치고, 바뀐 것을 SQL(새 표는 CREATE TABLE, 고친 표는 ALTER)로 미리 본 뒤 실행
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Columns3, KeyRound, Link2, ListTree, LoaderCircle, Lock, Plus, RotateCcw, Save, Trash2, TriangleAlert } from 'lucide-react'
import { designSql } from '../../../shared/alter'
import { features } from '../../../shared/features'
import { dialectOf, FK_ACTIONS, type ConnectionInfo, type DesignColumn, type DesignForeignKey, type DesignIndex, type Dialect, type FkAction, type TableDesign } from '../../../shared/types'
import { api, errorText, useRefreshConn } from '../api'
import { setDirty, useWs, type TableTab } from '../ws'
import { useUi } from '../ui'
import { t } from '../i18n'
import { DdlDialog } from '../dialogs/DdlDialog'

const TYPES: Record<Dialect, string[]> = {
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'],
  mysql: ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL(10,2)', 'DOUBLE', 'VARCHAR(255)', 'CHAR(10)', 'TEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'BOOLEAN', 'JSON', 'BLOB'],
  postgres: ['integer', 'bigint', 'smallint', 'numeric(10,2)', 'double precision', 'real', 'varchar(255)', 'text', 'boolean', 'date', 'timestamp', 'timestamptz', 'time', 'uuid', 'jsonb', 'json', 'bytea'],
  mssql: ['int', 'bigint', 'smallint', 'tinyint', 'bit', 'decimal(10,2)', 'float', 'nvarchar(255)', 'nvarchar(max)', 'varchar(255)', 'date', 'datetime2', 'datetimeoffset', 'time', 'uniqueidentifier', 'varbinary(max)'],
  oracle: ['NUMBER(10)', 'NUMBER(19)', 'NUMBER(10,2)', 'NUMBER', 'BINARY_DOUBLE', 'VARCHAR2(255 CHAR)', 'NVARCHAR2(255)', 'CHAR(10)', 'CLOB', 'DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'BLOB', 'RAW(16)'],
  clickhouse: ['UInt32', 'UInt64', 'Int32', 'Int64', 'Float64', 'Decimal(18,2)', 'String', 'LowCardinality(String)', 'FixedString(16)', 'Date', 'Date32', 'DateTime', 'DateTime64(3)', 'Bool', 'UUID', 'Array(String)', 'Map(String, String)'],
  duckdb: ['INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL(10,2)', 'DOUBLE', 'FLOAT', 'VARCHAR', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIME', 'UUID', 'BLOB', 'INTEGER[]', 'VARCHAR[]'],
}

/** 새 열의 기본 타입 */
const TEXT_TYPE: Record<Dialect, string> = { sqlite: 'TEXT', mysql: 'VARCHAR(255)', postgres: 'text', mssql: 'nvarchar(255)', oracle: 'VARCHAR2(255 CHAR)', clickhouse: 'String', duckdb: 'VARCHAR' }

function newDesign(d: Dialect): TableDesign {
  const idType = { sqlite: 'INTEGER', mysql: 'INT', postgres: 'integer', mssql: 'int', oracle: 'NUMBER(10)', clickhouse: 'UInt64', duckdb: 'INTEGER' }[d]
  return {
    name: '', comment: '', primaryKey: ['id'], pkName: '', indexes: [], foreignKeys: [], unsupported: [],
    columns: [{ name: 'id', type: idType, nullable: false, default: '', autoIncrement: features(d).autoIncrement, comment: '', generated: false, orig: null }],
  }
}

const clone = (x: TableDesign): TableDesign => JSON.parse(JSON.stringify(x)) as TableDesign
const parseList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
const replaceIn = (list: string[], from: string, to: string) => list.map((x) => (x === from ? to : x))

/** "a, b" 처럼 쉼표로 쓰는 열 목록. 입력하는 동안은 쓴 글자 그대로 둔다 */
function ListInput({ value, onChange, disabled, placeholder, label }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder?: string; label: string }) {
  const ext = value.join(', ')
  const [text, setText] = useState(ext)
  useEffect(() => {
    setText((cur) => (parseList(cur).join(', ') === ext ? cur : ext))
  }, [ext])
  return <input className="cell-input mono" aria-label={label} value={text} disabled={disabled} placeholder={placeholder} spellCheck={false} onChange={(e) => { setText(e.target.value); onChange(parseList(e.target.value)) }} />
}

type Section = 'columns' | 'indexes' | 'fks'

export function DesignView({ tab, conn, active }: { tab: TableTab; conn: ConnectionInfo; active: boolean }) {
  const ws = useWs()
  const ui = useUi()
  const refresh = useRefreshConn()
  const d = dialectOf(conn.driver)
  const isOn = ws.connected.has(tab.connId)
  const fresh = useRef(newDesign(d))
  const q = useQuery({
    queryKey: ['design', tab.connId, tab.ref.db, tab.ref.schema, tab.ref.table],
    queryFn: () => api.tableDesign(tab.connId, tab.ref),
    enabled: isOn && active && !tab.newTable,
  })
  const [before, setBefore] = useState<TableDesign | null>(null)
  const [draft, setDraft] = useState<TableDesign>(() => clone(fresh.current))
  const [section, setSection] = useState<Section>('columns')
  const resetNext = useRef(false)
  const base = tab.newTable ? fresh.current : before
  const dirty = !!base && JSON.stringify(draft) !== JSON.stringify(base)

  useEffect(() => {
    if (!q.data) return
    if (resetNext.current || !dirty) {
      resetNext.current = false
      setBefore(q.data)
      setDraft(clone(q.data))
    }
    // dirty는 일부러 빼고: 새로 읽은 것만 반영
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data])

  useEffect(() => {
    setDirty(tab.id, dirty)
  }, [tab.id, dirty])

  const f = features(d)
  const here = d === 'mysql' || d === 'clickhouse' ? tab.ref.db : d === 'sqlite' ? '' : tab.ref.schema || (({ mssql: 'dbo', duckdb: 'main', oracle: '' } as Partial<Record<Dialect, string>>)[d] ?? 'public')
  const readOnly = conn.readOnly === true
  const beforeCol = new Map((before?.columns ?? []).map((c) => [c.name, c]))

  const set = (fn: (x: TableDesign) => void) => setDraft((cur) => {
    const n = clone(cur)
    fn(n)
    return n
  })

  const updateCol = (i: number, patch: Partial<DesignColumn>) => set((x) => {
    const c = x.columns[i]
    if (patch.name !== undefined && patch.name !== c.name) {
      // 이름을 바꾸면 기본 키·인덱스·외래 키의 열 이름도 같이
      x.primaryKey = replaceIn(x.primaryKey, c.name, patch.name)
      for (const ix of x.indexes) ix.columns = replaceIn(ix.columns, c.name, patch.name)
      for (const fk of x.foreignKeys) fk.columns = replaceIn(fk.columns, c.name, patch.name)
    }
    Object.assign(c, patch)
  })
  const togglePk = (i: number, on: boolean) => set((x) => {
    const c = x.columns[i]
    x.primaryKey = on ? [...x.primaryKey.filter((n) => n !== c.name), c.name] : x.primaryKey.filter((n) => n !== c.name)
    if (on) c.nullable = false
  })
  const removeCol = (i: number) => set((x) => {
    const name = x.columns[i].name
    x.columns.splice(i, 1)
    x.primaryKey = x.primaryKey.filter((n) => n !== name)
    for (const ix of x.indexes) ix.columns = ix.columns.filter((n) => n !== name)
    x.indexes = x.indexes.filter((ix) => ix.columns.length > 0)
    x.foreignKeys = x.foreignKeys.filter((fk) => !fk.columns.includes(name))
  })
  const add = () => set((x) => {
    const table = x.name || 'table'
    if (section === 'columns') {
      let n = x.columns.length + 1
      while (x.columns.some((c) => c.name === `column${n}`)) n++
      x.columns.push({ name: `column${n}`, type: TEXT_TYPE[d], nullable: true, default: '', autoIncrement: false, comment: '', generated: false, orig: null })
    } else if (section === 'indexes') {
      let n = x.indexes.length + 1
      while (x.indexes.some((ix) => ix.name === `ix_${table}_${n}`)) n++
      x.indexes.push({ name: `ix_${table}_${n}`, columns: [], unique: false, orig: null })
    } else {
      let n = x.foreignKeys.length + 1
      while (x.foreignKeys.some((f) => f.name === `fk_${table}_${n}`)) n++
      x.foreignKeys.push({ name: d === 'sqlite' ? '' : `fk_${table}_${n}`, columns: [], refSchema: here, refTable: '', refColumns: [], onDelete: 'NO ACTION', onUpdate: 'NO ACTION', orig: null })
    }
  })

  const refText = (fk: DesignForeignKey) => (fk.refSchema && fk.refSchema !== here ? `${fk.refSchema}.${fk.refTable}` : fk.refTable)
  const parseRef = (s: string): Pick<DesignForeignKey, 'refSchema' | 'refTable'> => {
    const i = s.indexOf('.')
    if (d !== 'sqlite' && i > 0) return { refSchema: s.slice(0, i).trim(), refTable: s.slice(i + 1).trim() }
    return { refSchema: here, refTable: s.trim() }
  }

  const save = () => {
    if (readOnly) return
    let r: ReturnType<typeof designSql>
    try {
      r = designSql(d, { db: tab.ref.db, schema: tab.ref.schema }, tab.newTable ? null : before, draft)
    } catch (e) {
      ui.notify(errorText(e), 'error')
      return
    }
    if (!r.statements.length) {
      ui.notify(t('바뀐 것이 없어요'), 'info')
      return
    }
    const name = draft.name.trim()
    ui.open((close) => (
      <DdlDialog
        title={tab.newTable ? t('새 표 만들기') : t('표 구조 바꾸기')}
        driver={conn.driver}
        statements={r.statements}
        warnings={r.warnings}
        production={conn.production === true}
        onClose={close}
        onSubmit={async () => {
          try {
            await api.runDdl(tab.connId, tab.ref.db, tab.ref.schema, r.statements)
          } catch (e) {
            ui.notify(errorText(e), 'error')
            return
          }
          close()
          ui.notify(tab.newTable ? t('표를 만들었어요: {name}', { name }) : t('표 구조를 바꿨어요'), 'success')
          resetNext.current = true
          setDirty(tab.id, false)
          refresh(tab.connId)
          ws.updateTab(tab.id, { ref: { ...tab.ref, table: name }, newTable: false, sub: 'design' })
        }}
      />
    ))
  }

  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      save()
    }
  }

  if (!tab.newTable && !q.data && (q.isPending || q.isFetching)) return <div className="center-fill"><LoaderCircle className="spin big" /></div>
  if (!tab.newTable && q.error) return <div className="banner error">{errorText(q.error)}</div>

  const sections: { value: Section; label: string; icon: typeof Columns3; n: number }[] = [
    { value: 'columns' as const, label: t('열|column'), icon: Columns3, n: draft.columns.length },
    ...(f.designIndexes ? [{ value: 'indexes' as const, label: t('인덱스'), icon: ListTree, n: draft.indexes.length }] : []),
    ...(f.foreignKeys ? [{ value: 'fks' as const, label: t('외래 키'), icon: Link2, n: draft.foreignKeys.length }] : []),
  ]
  const actionSelect = (v: FkAction, on: (a: FkAction) => void, label: string) => (
    <select className="cell-input" aria-label={label} value={v} onChange={(e) => on(e.target.value as FkAction)}>
      {FK_ACTIONS.filter((a) => (d !== 'mssql' || a !== 'RESTRICT') && (d !== 'oracle' || a === 'NO ACTION' || a === 'CASCADE' || a === 'SET NULL')).map((a) => <option key={a} value={a}>{a}</option>)}
    </select>
  )

  return (
    <div className="design-view" onKeyDown={onKey}>
      <div className="toolbar design-bar">
        <label className="design-name">
          <span className="muted">{t('표 이름')}</span>
          <input className="cell-input" value={draft.name} spellCheck={false} placeholder={t('새 표 이름')} onChange={(e) => set((x) => { x.name = e.target.value })} data-autofocus />
        </label>
        {d !== 'sqlite' && (
          <label className="design-comment">
            <span className="muted">{t('설명')}</span>
            <input className="cell-input" value={draft.comment} onChange={(e) => set((x) => { x.comment = e.target.value })} />
          </label>
        )}
        <span className="spacer" />
        <button className="tbtn" disabled={!dirty} onClick={() => setDraft(clone(base ?? fresh.current))} title={t('고친 것을 모두 되돌리기')}><RotateCcw />{t('되돌리기')}</button>
        <button className="tbtn primary" disabled={readOnly || (!dirty && !tab.newTable)} onClick={save} title={readOnly ? t('읽기 전용 접속') : t('실행할 SQL을 미리 보고 실행 (Ctrl+S)')}>
          {readOnly ? <Lock /> : <Save />}{tab.newTable ? t('표 만들기') : t('저장')}<kbd>Ctrl+S</kbd>
        </button>
      </div>
      {before && before.unsupported.length > 0 && (
        <div className="banner warn"><TriangleAlert />{t('이 표에는 설계 화면이 다루지 않는 설정({list})이 있어요. 열 추가·이름 바꾸기·지우기와 인덱스만 바꿀 수 있어요.', { list: before.unsupported.join(', ') })}</div>
      )}
      <div className="toolbar design-sections">
        <div className="subtabs" role="tablist">
          {sections.map((s) => (
            <button key={s.value} type="button" role="tab" aria-selected={section === s.value} className={`subtab ${section === s.value ? 'on' : ''}`} onClick={() => setSection(s.value)}>
              <s.icon />{s.label}<span className="count">{s.n}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="tbtn" onClick={add}><Plus />{section === 'columns' ? t('열 추가') : section === 'indexes' ? t('인덱스 추가') : t('외래 키 추가')}</button>
      </div>
      <datalist id={`types-${d}`}>{TYPES[d].map((x) => <option key={x} value={x} />)}</datalist>
      <div className="design-body">
        {section === 'columns' && (
          <table className="info-table design-table">
            <thead>
              <tr>
                <th className="narrow" title={t('기본 키')}><KeyRound className="pk-icon" /></th>
                <th>{t('이름')}</th>
                <th>{t('타입')}</th>
                <th className="narrow">{t('NULL 허용')}</th>
                <th>{t('기본값 (SQL 식)')}</th>
                <th className="narrow">{t('자동 증가')}</th>
                {d !== 'sqlite' && <th>{t('설명')}</th>}
                <th className="narrow" />
              </tr>
            </thead>
            <tbody>
              {draft.columns.map((c, i) => {
                const b = c.orig !== null ? beforeCol.get(c.orig) : undefined
                const state = !b ? 'added' : JSON.stringify({ ...b, orig: null }) !== JSON.stringify({ ...c, orig: null }) ? 'changed' : ''
                const pk = draft.primaryKey.includes(c.name)
                // SQL Server는 IDENTITY를 못 바꾸고, Oracle은 있는 열을 IDENTITY로 못 바꾼다. DuckDB·ClickHouse는 자동 증가가 없다
                const lockAuto = !f.autoIncrement || (!!b && (d === 'mssql' || (d === 'oracle' && !b.autoIncrement)))
                return (
                  <tr key={i} className={state}>
                    <td className="narrow"><input type="checkbox" aria-label={t('기본 키')} checked={pk} disabled={c.generated} onChange={(e) => togglePk(i, e.target.checked)} /></td>
                    <td><input className="cell-input" aria-label={t('이름')} value={c.name} spellCheck={false} onChange={(e) => updateCol(i, { name: e.target.value })} /></td>
                    <td>
                      {c.generated
                        ? <span className="muted mono">{c.type} · {t('계산 열')}</span>
                        : <input className="cell-input mono" aria-label={t('타입')} value={c.type} list={`types-${d}`} spellCheck={false} onChange={(e) => updateCol(i, { type: e.target.value })} />}
                    </td>
                    <td className="narrow"><input type="checkbox" aria-label={t('NULL 허용')} checked={c.nullable} disabled={c.generated} onChange={(e) => updateCol(i, { nullable: e.target.checked })} /></td>
                    <td><input className="cell-input mono" aria-label={t('기본값')} value={c.default} disabled={c.generated || (c.autoIncrement && d !== 'mysql')} spellCheck={false} placeholder={d === 'mssql' ? "N'…'" : "'…'"} onChange={(e) => updateCol(i, { default: e.target.value })} /></td>
                    <td className="narrow">
                      <input type="checkbox" aria-label={t('자동 증가')} checked={c.autoIncrement} disabled={c.generated || lockAuto} title={!f.autoIncrement ? t('이 DB에는 자동 증가 열이 없어요') : lockAuto ? t('이미 있는 열의 자동 증가는 바꿀 수 없어요') : undefined}
                        onChange={(e) => updateCol(i, { autoIncrement: e.target.checked, ...(e.target.checked && d !== 'mysql' ? { default: '' } : {}) })} />
                    </td>
                    {d !== 'sqlite' && <td><input className="cell-input" aria-label={t('설명')} value={c.comment} disabled={c.generated} onChange={(e) => updateCol(i, { comment: e.target.value })} /></td>}
                    <td className="narrow"><button className="icon-btn small" title={t('열 지우기')} aria-label={t('열 지우기')} onClick={() => removeCol(i)}><Trash2 /></button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {section === 'indexes' && (
          draft.indexes.length === 0 ? <p className="pad muted">{t('인덱스가 없어요')}</p> : (
            <table className="info-table design-table">
              <thead>
                <tr>
                  <th>{t('이름')}</th>
                  <th>{t('열 (쉼표로)')}</th>
                  <th className="narrow">{t('고유')}</th>
                  <th className="narrow" />
                </tr>
              </thead>
              <tbody>
                {draft.indexes.map((ix, i) => {
                  const fixed = !!ix.sql || (d === 'sqlite' && !!ix.constraint)
                  const upd = (patch: Partial<DesignIndex>) => set((x) => { Object.assign(x.indexes[i], patch) })
                  return (
                    <tr key={i} className={ix.orig === null ? 'added' : ''}>
                      <td>
                        <input className="cell-input" aria-label={t('이름')} value={ix.name} disabled={fixed} spellCheck={false} onChange={(e) => upd({ name: e.target.value })} />
                        {ix.constraint && <span className="tag">{t('UNIQUE 제약')}</span>}
                        {ix.sql && <span className="tag">{t('식·조건 인덱스')}</span>}
                      </td>
                      <td><ListInput label={t('열|column')} value={ix.columns} disabled={fixed} placeholder="a, b" onChange={(v) => upd({ columns: v })} /></td>
                      <td className="narrow"><input type="checkbox" aria-label={t('고유')} checked={ix.unique} disabled={fixed || ix.constraint} onChange={(e) => upd({ unique: e.target.checked })} /></td>
                      <td className="narrow"><button className="icon-btn small" title={t('인덱스 지우기')} aria-label={t('인덱스 지우기')} onClick={() => set((x) => { x.indexes.splice(i, 1) })}><Trash2 /></button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )
        )}
        {section === 'fks' && (
          draft.foreignKeys.length === 0 ? <p className="pad muted">{t('외래 키가 없어요')}</p> : (
            <table className="info-table design-table">
              <thead>
                <tr>
                  {d !== 'sqlite' && <th>{t('이름')}</th>}
                  <th>{t('열 (쉼표로)')}</th>
                  <th>{t('참조 표')}</th>
                  <th>{t('참조 열 (쉼표로)')}</th>
                  <th>ON DELETE</th>
                  <th>ON UPDATE</th>
                  <th className="narrow" />
                </tr>
              </thead>
              <tbody>
                {draft.foreignKeys.map((fk, i) => {
                  const upd = (patch: Partial<DesignForeignKey>) => set((x) => { Object.assign(x.foreignKeys[i], patch) })
                  return (
                    <tr key={i} className={fk.orig === null ? 'added' : ''}>
                      {d !== 'sqlite' && <td><input className="cell-input" aria-label={t('이름')} value={fk.name} spellCheck={false} onChange={(e) => upd({ name: e.target.value })} /></td>}
                      <td><ListInput label={t('열|column')} value={fk.columns} placeholder="parent_id" onChange={(v) => upd({ columns: v })} /></td>
                      <td><input className="cell-input mono" aria-label={t('참조 표')} value={refText(fk)} spellCheck={false} placeholder={d === 'sqlite' || d === 'mysql' ? 'parent' : 'schema.parent'} onChange={(e) => upd(parseRef(e.target.value))} /></td>
                      <td><ListInput label={t('참조 열')} value={fk.refColumns} placeholder="id" onChange={(v) => upd({ refColumns: v })} /></td>
                      <td>{actionSelect(fk.onDelete, (a) => upd({ onDelete: a }), 'ON DELETE')}</td>
                      <td>{actionSelect(fk.onUpdate, (a) => upd({ onUpdate: a }), 'ON UPDATE')}</td>
                      <td className="narrow"><button className="icon-btn small" title={t('외래 키 지우기')} aria-label={t('외래 키 지우기')} onClick={() => set((x) => { x.foreignKeys.splice(i, 1) })}><Trash2 /></button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  )
}
