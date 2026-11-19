// 왼쪽 탐색기: 접속 → DB → (스키마) → 표·뷰 묶음 → 표 → 열·인덱스. 펼칠 때 읽고, 새로고침 전까지 기억
import { useState, type MouseEvent, type ReactNode } from 'react'
import {
  ChevronRight, Columns3, Copy, Database, Eye, FileCode2, FilePlus2, Folder, FolderTree, KeyRound, ListTree, LoaderCircle, Pencil, Plug, Plus,
  RefreshCw, Search, SquareTerminal, Table2, Trash2, Unplug, Upload, X, Download,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { ConnectionInfo, DbObject, ObjectKind, TableRef } from '../../../shared/types'
import { api, errorText, useColumns, useDatabases, useIndexes, useObjects, useRefreshConn, useSchemas } from '../api'
import { defaultContext, useWs } from '../ws'
import { useUi, type MenuItem } from '../ui'
import { t } from '../i18n'
import { connSummary } from '../format'
import { DriverBadge } from './DriverBadge'
import { ImportDialog } from '../dialogs/ImportDialog'

const EXPAND_KEY = 'dboard.tree.expanded'

function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPAND_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

interface TreeCtx {
  expanded: Set<string>
  toggle(key: string, open?: boolean): void
  selected: string | null
  select(key: string): void
  filter: string
}

function Row({ depth, k, ctx, icon, label, extra, expandable, loading, onOpen, onMenu, onDouble, title, className, open: openProp, onToggle }: {
  /** 펼침 상태를 바깥에서 정할 때 (처음부터 펼친 묶음) */
  open?: boolean
  onToggle?: () => void
  depth: number
  k: string
  ctx: TreeCtx
  icon: ReactNode
  label: ReactNode
  extra?: ReactNode
  expandable: boolean
  loading?: boolean
  onOpen?: () => void
  onMenu?: (e: MouseEvent) => void
  onDouble?: () => void
  title?: string
  className?: string
}) {
  const open = openProp ?? ctx.expanded.has(k)
  return (
    <div
      className={`tree-row ${ctx.selected === k ? 'sel' : ''} ${className ?? ''}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      role="treeitem"
      aria-expanded={expandable ? open : undefined}
      aria-selected={ctx.selected === k}
      data-key={k}
      title={title}
      onClick={() => {
        ctx.select(k)
        if (expandable) {
          if (onToggle) onToggle()
          else ctx.toggle(k)
          if (!open) onOpen?.()
        }
      }}
      onDoubleClick={onDouble}
      onContextMenu={(e) => {
        ctx.select(k)
        onMenu?.(e)
      }}
    >
      <span className={`tree-chev ${expandable ? '' : 'none'} ${open ? 'open' : ''}`}>{loading ? <LoaderCircle className="spin" /> : expandable && <ChevronRight />}</span>
      <span className="tree-icon">{icon}</span>
      <span className="tree-label ellipsis">{label}</span>
      {extra && <span className="tree-extra">{extra}</span>}
    </div>
  )
}

function Empty({ depth, children }: { depth: number; children: ReactNode }) {
  return <div className="tree-empty" style={{ paddingLeft: 26 + depth * 14 }}>{children}</div>
}

function ErrorRow({ depth, error }: { depth: number; error: unknown }) {
  return <div className="tree-empty error" style={{ paddingLeft: 26 + depth * 14 }} title={errorText(error)}>{errorText(error)}</div>
}

export function Navigator() {
  const ws = useWs()
  const [expanded, setExpanded] = useState(loadExpanded)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const toggle = (key: string, open?: boolean) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (open ?? !n.has(key)) n.add(key)
      else n.delete(key)
      try {
        localStorage.setItem(EXPAND_KEY, JSON.stringify([...n].slice(-500)))
      } catch {
        // 무시
      }
      return n
    })
  }
  const ctx: TreeCtx = { expanded, toggle, selected, select: setSelected, filter: filter.trim().toLowerCase() }

  return (
    <div className="navigator">
      <div className="side-head">
        <h2>{t('탐색기')}</h2>
        <span className="spacer" />
        <button className="icon-btn" title={t('새 연결')} onClick={() => ws.editConnection()}><Plus /></button>
      </div>
      <div className="side-search">
        <Search />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('표 이름 찾기')} spellCheck={false} />
        {filter && <button className="icon-btn small" onClick={() => setFilter('')} aria-label={t('지우기')}><X /></button>}
      </div>
      <div className="tree" role="tree">
        {ws.connections.length === 0 && (
          <div className="tree-intro">
            <p>{t('아직 접속 정보가 없어요.')}</p>
            <button className="btn primary" onClick={() => ws.editConnection()}><Plus />{t('새 연결')}</button>
          </div>
        )}
        {ws.connections.map((c) => <ConnNode key={c.id} c={c} ctx={ctx} />)}
      </div>
    </div>
  )
}

function ConnNode({ c, ctx }: { c: ConnectionInfo; ctx: TreeCtx }) {
  const ws = useWs()
  const ui = useUi()
  const qc = useQueryClient()
  const refresh = useRefreshConn()
  const k = 'c:' + c.id
  const isOn = ws.connected.has(c.id)
  const open = ctx.expanded.has(k) && isOn
  const dbs = useDatabases(c.id, open)

  const connect = async () => {
    if (!(await ws.ensureConnected(c.id))) ctx.toggle(k, false)
  }

  const remove = async () => {
    const ok = await ui.confirm({ title: t('접속 정보 지우기'), message: t('"{name}" 접속 정보를 지울까요? DB 자체는 그대로예요.', { name: c.name }), confirm: t('지우기'), danger: true })
    if (!ok) return
    try {
      await api.deleteConnection(c.id)
      void qc.invalidateQueries({ queryKey: ['connections'] })
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  const menu = (e: MouseEvent) => ui.menu(e, [
    isOn ? { label: t('연결 끊기'), icon: Unplug, onClick: () => void ws.disconnect(c.id) } : { label: t('연결'), icon: Plug, onClick: () => { ctx.toggle(k, true); void connect() } },
    { label: t('새 SQL 편집기'), icon: SquareTerminal, hint: 'Ctrl+]', onClick: async () => { if (await ws.ensureConnected(c.id)) ws.openEditor(c.id) } },
    isOn && { label: t('새로고침'), icon: RefreshCw, onClick: () => refresh(c.id) },
    'sep',
    { label: t('고치기'), icon: Pencil, onClick: () => ws.editConnection(c) },
    { label: t('복제'), icon: Copy, onClick: async () => { await api.duplicateConnection(c.id); void qc.invalidateQueries({ queryKey: ['connections'] }) } },
    { label: t('지우기'), icon: Trash2, danger: true, onClick: () => void remove() },
  ])

  const dbList = dbs.data?.databases ?? []
  return (
    <>
      <Row
        depth={0}
        k={k}
        ctx={ctx}
        className="conn-row"
        icon={<span className="conn-icon"><DriverBadge driver={c.driver} />{isOn && <span className="on-dot" />}</span>}
        label={<><b>{c.name}</b>{c.color && <span className="conn-color" style={{ background: c.color }} />}</>}
        extra={<span className="muted small">{connSummary(c)}</span>}
        title={connSummary(c)}
        expandable
        loading={ws.connecting.has(c.id) || (open && dbs.isFetching)}
        onOpen={() => void connect()}
        onMenu={menu}
      />
      {open && dbs.error && <ErrorRow depth={1} error={dbs.error} />}
      {open && dbs.data && dbList.length === 0 && <Empty depth={1}>{t('DB가 없어요')}</Empty>}
      {open && dbs.data && dbList.map((db) => <DbNode key={db} c={c} db={db} hasSchemas={dbs.data!.hasSchemas} ctx={ctx} />)}
    </>
  )
}

function DbNode({ c, db, hasSchemas, ctx }: { c: ConnectionInfo; db: string; hasSchemas: boolean; ctx: TreeCtx }) {
  const ws = useWs()
  const ui = useUi()
  const k = `d:${c.id}:${db}`
  const open = ctx.expanded.has(k)
  const schemas = useSchemas(c.id, db, open && hasSchemas)
  const def = defaultContext(c)
  const menu = (e: MouseEvent) => ui.menu(e, [
    { label: t('새 SQL 편집기'), icon: SquareTerminal, onClick: () => ws.openEditor(c.id, { db, schema: hasSchemas ? def.schema : '' }) },
    { label: t('이름 복사'), icon: Copy, onClick: () => void api.copyText(db) },
  ])
  return (
    <>
      <Row depth={1} k={k} ctx={ctx} icon={<Database />} label={db} expandable loading={open && schemas.isFetching} onMenu={menu} />
      {open && !hasSchemas && <ObjectFolders c={c} db={db} schema="" depth={2} ctx={ctx} />}
      {open && hasSchemas && schemas.error && <ErrorRow depth={2} error={schemas.error} />}
      {open && hasSchemas && schemas.data?.length === 0 && <Empty depth={2}>{t('스키마가 없어요')}</Empty>}
      {open && hasSchemas && schemas.data?.map((s) => <SchemaNode key={s} c={c} db={db} schema={s} ctx={ctx} />)}
    </>
  )
}

function SchemaNode({ c, db, schema, ctx }: { c: ConnectionInfo; db: string; schema: string; ctx: TreeCtx }) {
  const ws = useWs()
  const ui = useUi()
  const k = `s:${c.id}:${db}:${schema}`
  const open = ctx.expanded.has(k)
  const menu = (e: MouseEvent) => ui.menu(e, [
    { label: t('새 SQL 편집기'), icon: SquareTerminal, onClick: () => ws.openEditor(c.id, { db, schema }) },
    { label: t('이름 복사'), icon: Copy, onClick: () => void api.copyText(schema) },
  ])
  return (
    <>
      <Row depth={2} k={k} ctx={ctx} icon={<FolderTree />} label={schema} expandable onMenu={menu} />
      {open && <ObjectFolders c={c} db={db} schema={schema} depth={3} ctx={ctx} />}
    </>
  )
}

function ObjectFolders({ c, db, schema, depth, ctx }: { c: ConnectionInfo; db: string; schema: string; depth: number; ctx: TreeCtx }) {
  const objs = useObjects(c.id, db, schema, true)
  if (objs.isPending) return <Empty depth={depth}><LoaderCircle className="spin small-icon" /></Empty>
  if (objs.error) return <ErrorRow depth={depth} error={objs.error} />
  const all = objs.data ?? []
  const match = (o: DbObject) => !ctx.filter || o.name.toLowerCase().includes(ctx.filter)
  const tables = all.filter((o) => o.kind === 'table' && match(o))
  const views = all.filter((o) => o.kind === 'view' && match(o))
  return (
    <>
      <Folder2 c={c} db={db} schema={schema} kind="table" items={tables} depth={depth} ctx={ctx} />
      <Folder2 c={c} db={db} schema={schema} kind="view" items={views} depth={depth} ctx={ctx} />
    </>
  )
}

function Folder2({ c, db, schema, kind, items, depth, ctx }: { c: ConnectionInfo; db: string; schema: string; kind: ObjectKind; items: DbObject[]; depth: number; ctx: TreeCtx }) {
  const k = `f:${c.id}:${db}:${schema}:${kind}`
  // 찾기 중에는 묶음을 펼친 것으로
  const open = ctx.expanded.has(k) || (!!ctx.filter && items.length > 0)
  return (
    <>
      <Row depth={depth} k={k} ctx={ctx} icon={<Folder />} label={kind === 'table' ? t('표') : t('뷰')} extra={<span className="count">{items.length}</span>} expandable />
      {open && items.map((o) => <ObjectNode key={o.name} c={c} ref2={{ db, schema, table: o.name }} obj={o} depth={depth + 1} ctx={ctx} />)}
    </>
  )
}

function ObjectNode({ c, ref2, obj, depth, ctx }: { c: ConnectionInfo; ref2: TableRef; obj: DbObject; depth: number; ctx: TreeCtx }) {
  const ws = useWs()
  const ui = useUi()
  const qc = useQueryClient()
  const k = `t:${c.id}:${ref2.db}:${ref2.schema}:${obj.name}`
  const open = ctx.expanded.has(k)
  const isView = obj.kind === 'view'
  const selectSql = () => {
    const name = c.driver === 'mysql' || c.driver === 'mariadb' ? '`' + obj.name.replace(/`/g, '``') + '`' : c.driver === 'mssql' ? '[' + obj.name.replace(/]/g, ']]') + ']' : '"' + obj.name.replace(/"/g, '""') + '"'
    return c.driver === 'mssql' ? `SELECT TOP 100 * FROM ${name};` : `SELECT * FROM ${name} LIMIT 100;`
  }
  const menu = (e: MouseEvent) => {
    const items: MenuItem[] = [
      { label: t('데이터 보기'), icon: Table2, onClick: () => ws.openTable(c.id, ref2, obj.kind, 'data') },
      { label: t('구조 (열)'), icon: Columns3, onClick: () => ws.openTable(c.id, ref2, obj.kind, 'columns') },
      { label: t('DDL 보기'), icon: FileCode2, onClick: () => ws.openTable(c.id, ref2, obj.kind, 'ddl') },
      'sep',
      { label: t('SELECT 문으로 새 편집기'), icon: SquareTerminal, onClick: () => ws.openEditor(c.id, { db: ref2.db, schema: ref2.schema, text: selectSql() }) },
      !isView && { label: t('CSV 가져오기…'), icon: Upload, onClick: () => ui.open((close) => <ImportDialog connId={c.id} target={ref2} onClose={close} onDone={() => void qc.invalidateQueries({ queryKey: ['table-data', c.id] })} />) },
      { label: t('CSV로 내보내기…'), icon: Download, onClick: () => ws.openTable(c.id, ref2, obj.kind, 'data') },
      'sep',
      { label: t('이름 복사'), icon: Copy, onClick: () => void api.copyText(obj.name) },
      { label: t('새로고침'), icon: RefreshCw, onClick: () => {
        void qc.invalidateQueries({ queryKey: ['columns', c.id, ref2.db, ref2.schema, obj.name] })
        void qc.invalidateQueries({ queryKey: ['indexes', c.id, ref2.db, ref2.schema, obj.name] })
      } },
    ]
    ui.menu(e, items)
  }
  return (
    <>
      <Row
        depth={depth}
        k={k}
        ctx={ctx}
        icon={isView ? <Eye className="view-icon" /> : <Table2 className="table-icon" />}
        label={obj.name}
        title={obj.comment || obj.name}
        expandable
        onDouble={() => ws.openTable(c.id, ref2, obj.kind, 'data')}
        onMenu={menu}
      />
      {open && <TableChildren c={c} ref2={ref2} isView={isView} depth={depth + 1} ctx={ctx} />}
    </>
  )
}

function TableChildren({ c, ref2, isView, depth, ctx }: { c: ConnectionInfo; ref2: TableRef; isView: boolean; depth: number; ctx: TreeCtx }) {
  const base = `${c.id}:${ref2.db}:${ref2.schema}:${ref2.table}`
  // 열 묶음은 처음부터 펼쳐 둔다 (접은 것만 기억)
  const kc = 'tcx:' + base
  const ki = 'ti:' + base
  const colsOpen = !ctx.expanded.has(kc)
  const cols = useColumns(c.id, ref2, colsOpen)
  const idxOpen = ctx.expanded.has(ki)
  const idx = useIndexes(c.id, ref2, idxOpen && !isView)
  return (
    <>
      <Row depth={depth} k={kc} ctx={ctx} open={colsOpen} onToggle={() => ctx.toggle(kc)} icon={<Columns3 />} label={t('열|column')} extra={cols.data && <span className="count">{cols.data.length}</span>} expandable loading={cols.isFetching} />
      {colsOpen && cols.error && <ErrorRow depth={depth + 1} error={cols.error} />}
      {colsOpen && cols.data?.map((col) => (
        <div key={col.name} className="tree-row leaf" style={{ paddingLeft: 6 + (depth + 1) * 14 }} title={[col.type, col.nullable ? 'NULL' : 'NOT NULL', col.default !== null ? 'DEFAULT ' + col.default : '', col.comment].filter(Boolean).join(' · ')}>
          <span className="tree-chev none" />
          <span className="tree-icon">{col.pk ? <KeyRound className="pk-icon" /> : <span className="col-dot" />}</span>
          <span className="tree-label ellipsis">{col.name}</span>
          <span className="tree-extra mono muted">{col.type}{col.nullable ? '' : ' !'}</span>
        </div>
      ))}
      {!isView && (
        <>
          <Row depth={depth} k={ki} ctx={ctx} icon={<ListTree />} label={t('인덱스')} extra={idx.data && <span className="count">{idx.data.length}</span>} expandable loading={idx.isFetching} />
          {idxOpen && idx.error && <ErrorRow depth={depth + 1} error={idx.error} />}
          {idxOpen && idx.data?.length === 0 && <Empty depth={depth + 1}>{t('인덱스가 없어요')}</Empty>}
          {idxOpen && idx.data?.map((ix) => (
            <div key={ix.name} className="tree-row leaf" style={{ paddingLeft: 6 + (depth + 1) * 14 }} title={ix.columns.join(', ')}>
              <span className="tree-chev none" />
              <span className="tree-icon">{ix.primary ? <KeyRound className="pk-icon" /> : <FilePlus2 className="idx-icon" />}</span>
              <span className="tree-label ellipsis">{ix.name}</span>
              <span className="tree-extra mono muted">{ix.unique && !ix.primary ? 'UNIQUE ' : ''}({ix.columns.join(', ')})</span>
            </div>
          ))}
        </>
      )}
    </>
  )
}
