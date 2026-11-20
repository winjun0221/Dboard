// 왼쪽 탐색기: 접속 → DB → (스키마) → 표·뷰 묶음 → 표 → 열·인덱스. 펼칠 때 읽고, 새로고침 전까지 기억
import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  ChevronRight, ChevronsDownUp, Columns3, Copy, Database, DatabaseBackup, Eye, FilePlay, ScrollText, FileCode2, FilePlus2, Folder, FolderTree, KeyRound, ListTree, LoaderCircle, Pencil, Plug, Plus,
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
import { DumpDialog } from '../dialogs/DumpDialog'
import { RunFileDialog } from '../dialogs/RunFileDialog'

const EXPAND_KEY = 'dboard.tree.expanded'

function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPAND_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

/** 고른 줄이 가리키는 것 (위 도구 줄 단추가 쓴다) */
interface SelMeta {
  connId: string
  db?: string
  schema?: string
  table?: string
  kind?: ObjectKind
}

/** 키보드로 움직일 때 쓰는 줄 정보 (그릴 때마다 채움) */
interface RowEntry {
  meta?: SelMeta
  depth: number
  expandable: boolean
  open: boolean
  toggle(): void
  /** Enter·더블클릭: 표는 데이터 열기, 묶음은 펼치기·접기 */
  activate(): void
}

interface TreeCtx {
  expanded: Set<string>
  toggle(key: string, open?: boolean): void
  selected: string | null
  select(key: string, meta?: SelMeta): void
  filter: string
  rows: Map<string, RowEntry>
}

// 누르기: 고르기 + (묶음은) 펼치기·접기. chevronOnly인 줄(표·뷰)은 화살표를 눌러야 펼치고, 더블클릭은 바로 연다.
// 더블클릭의 두 번째 누르기(detail 2)는 펼침을 되돌리지 않는다.
function Row({ depth, k, ctx, icon, label, extra, expandable, loading, onOpen, onMenu, onDouble, title, className, open: openProp, onToggle, meta, chevronOnly }: {
  meta?: SelMeta
  /** 화살표를 눌렀을 때만 펼치기 (표·뷰: 한 번 누르면 고르기만) */
  chevronOnly?: boolean
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
  const toggle = () => {
    if (onToggle) onToggle()
    else ctx.toggle(k)
    if (!open) onOpen?.()
  }
  ctx.rows.set(k, { meta, depth, expandable, open, toggle, activate: onDouble ?? (expandable ? toggle : () => undefined) })
  return (
    <div
      className={`tree-row ${ctx.selected === k ? 'sel' : ''} ${className ?? ''}`}
      style={{ paddingLeft: 4 + depth * 16 }}
      role="treeitem"
      aria-expanded={expandable ? open : undefined}
      aria-selected={ctx.selected === k}
      data-key={k}
      title={title}
      onClick={(e) => {
        ctx.select(k, meta)
        if (!expandable || e.detail > 1) return
        if (chevronOnly && !(e.target as HTMLElement).closest('.tree-chev')) return
        toggle()
      }}
      onDoubleClick={onDouble}
      onContextMenu={(e) => {
        ctx.select(k, meta)
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
  return <div className="tree-empty" style={{ paddingLeft: 24 + depth * 16 }}>{children}</div>
}

function ErrorRow({ depth, error }: { depth: number; error: unknown }) {
  return <div className="tree-empty error" style={{ paddingLeft: 24 + depth * 16 }} title={errorText(error)}>{errorText(error)}</div>
}

function saveExpanded(n: Set<string>) {
  try {
    localStorage.setItem(EXPAND_KEY, JSON.stringify([...n].slice(-500)))
  } catch {
    // 무시
  }
}

export function Navigator() {
  const ws = useWs()
  const ui = useUi()
  const refresh = useRefreshConn()
  const [expanded, setExpanded] = useState(loadExpanded)
  const [sel, setSel] = useState<{ key: string; meta?: SelMeta } | null>(null)
  const [filter, setFilter] = useState('')

  const toggle = (key: string, open?: boolean) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (open ?? !n.has(key)) n.add(key)
      else n.delete(key)
      saveExpanded(n)
      return n
    })
  }
  const rows = useRef(new Map<string, RowEntry>()).current
  const ctx: TreeCtx = { expanded, toggle, selected: sel?.key ?? null, select: (key, meta) => setSel({ key, meta }), filter: filter.trim().toLowerCase(), rows }

  // 키보드: ↑↓ 줄 옮기기, → 펼치기(펼쳐 있으면 아래로), ← 접기(접혀 있으면 위 묶음으로), Enter 열기, Home·End
  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tree = e.currentTarget
    const keys = [...tree.querySelectorAll<HTMLElement>('.tree-row[data-key]')].map((el) => el.dataset.key!)
    if (keys.length === 0) return
    const i = sel ? keys.indexOf(sel.key) : -1
    const cur = i >= 0 ? rows.get(keys[i]) : undefined
    const go = (j: number) => {
      const key = keys[Math.max(0, Math.min(keys.length - 1, j))]
      setSel({ key, meta: rows.get(key)?.meta })
      tree.querySelector(`.tree-row[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break
      case 'ArrowUp': go(i < 0 ? 0 : i - 1); break
      case 'Home': go(0); break
      case 'End': go(keys.length - 1); break
      case 'ArrowRight':
        if (cur?.expandable && !cur.open) cur.toggle()
        else go(i + 1)
        break
      case 'ArrowLeft':
        if (cur?.expandable && cur.open) cur.toggle()
        else if (cur) {
          for (let j = i - 1; j >= 0; j--) {
            if ((rows.get(keys[j])?.depth ?? 0) < cur.depth) {
              go(j)
              break
            }
          }
        }
        break
      case 'Enter': cur?.activate(); break
      default: return
    }
    e.preventDefault()
  }

  // 도구 줄: 고른 줄의 접속(·DB·표)에 대해
  const meta = sel?.meta && ws.conn(sel.meta.connId) ? sel.meta : undefined
  const selOn = !!meta && ws.connected.has(meta.connId)
  const tableRef = meta?.table !== undefined ? { db: meta.db ?? '', schema: meta.schema ?? '', table: meta.table } : null
  const refreshSel = () => {
    if (selOn && meta) refresh(meta.connId)
    else for (const id of ws.connected) refresh(id)
  }
  const newEditorSel = async () => {
    if (!meta || !(await ws.ensureConnected(meta.connId))) return
    ws.openEditor(meta.connId, meta.db !== undefined ? { db: meta.db, schema: meta.schema ?? '' } : undefined)
  }
  const collapseAll = () => {
    const n = new Set<string>()
    saveExpanded(n)
    setExpanded(n)
  }

  return (
    <div className="navigator">
      <div className="side-tools" role="toolbar">
        <button className="icon-btn small" title={t('새 연결')} onClick={() => ws.editConnection()}><Plus /></button>
        <button className="icon-btn small" title={t('새로고침')} disabled={ws.connected.size === 0} onClick={refreshSel}><RefreshCw /></button>
        <button className="icon-btn small" title={t('연결 끊기')} disabled={!selOn} onClick={() => meta && void ws.disconnect(meta.connId)}><Unplug /></button>
        <span className="tool-sep" />
        <button className="icon-btn small" title={t('새 SQL 편집기')} disabled={!meta} onClick={() => void newEditorSel()}><SquareTerminal /></button>
        <button className="icon-btn small" title={t('데이터 보기')} disabled={!tableRef} onClick={() => meta && tableRef && ws.openTable(meta.connId, tableRef, meta.kind ?? 'table', 'data')}><Table2 /></button>
        {/* 표를 고르면 그 표의 DDL, DB·스키마를 고르면 전체 DDL 내보내기 */}
        <button
          className="tool-text"
          title={tableRef ? t('DDL 보기') : t('DDL 내보내기…')}
          disabled={!tableRef && (!selOn || meta?.db === undefined)}
          onClick={() => {
            if (!meta) return
            if (tableRef) ws.openTable(meta.connId, tableRef, meta.kind ?? 'table', 'ddl')
            else if (meta.db !== undefined) ui.open((close) => <DumpDialog conn={ws.conn(meta.connId)!} db={meta.db!} schema={meta.schema ?? ''} content="structure" onClose={close} />)
          }}
        >DDL</button>
        <button className="icon-btn small" title={t('SQL 덤프 내보내기…')} disabled={!selOn || meta?.db === undefined} onClick={() => meta && meta.db !== undefined && ui.open((close) => <DumpDialog conn={ws.conn(meta.connId)!} db={meta.db!} schema={meta.schema ?? ''} only={meta.table} onClose={close} />)}><DatabaseBackup /></button>
        <span className="spacer" />
        <button className="icon-btn small" title={t('모두 접기')} onClick={collapseAll}><ChevronsDownUp /></button>
      </div>
      <div className="side-search">
        <Search />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('표 이름 찾기')} spellCheck={false} />
        {filter && <button className="icon-btn small" onClick={() => setFilter('')} aria-label={t('지우기')}><X /></button>}
      </div>
      <div className="tree" role="tree" tabIndex={0} onKeyDown={onTreeKey}>
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
        className={`conn-row ${isOn ? 'on' : ''}`}
        meta={{ connId: c.id }}
        icon={<span className="conn-icon"><DriverBadge driver={c.driver} size={16} />{isOn && <span className="on-dot" />}</span>}
        label={<>{c.color && <span className="conn-color" style={{ background: c.color }} />}<span className="conn-name">{c.name}</span></>}
        extra={<span className="conn-host">{connSummary(c)}</span>}
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
    'sep',
    // 스키마가 있는 DB(PostgreSQL·SQL Server)는 스키마에서 덤프
    !hasSchemas && { label: t('DDL 내보내기…'), icon: ScrollText, onClick: () => ui.open((close) => <DumpDialog conn={c} db={db} schema="" content="structure" onClose={close} />) },
    !hasSchemas && { label: t('SQL 덤프 내보내기…'), icon: DatabaseBackup, onClick: () => ui.open((close) => <DumpDialog conn={c} db={db} schema="" onClose={close} />) },
    { label: t('SQL 파일 실행…'), icon: FilePlay, onClick: () => ui.open((close) => <RunFileDialog conn={c} ensureConnected={() => ws.ensureConnected(c.id)} db={db} schema={hasSchemas ? def.schema : ''} onClose={close} />) },
    'sep',
    { label: t('이름 복사'), icon: Copy, onClick: () => void api.copyText(db) },
  ])
  return (
    <>
      <Row depth={1} k={k} ctx={ctx} meta={{ connId: c.id, db, schema: hasSchemas ? def.schema : '' }} icon={<Database className="db-icon" />} label={db} expandable loading={open && schemas.isFetching} onMenu={menu} />
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
    'sep',
    { label: t('DDL 내보내기…'), icon: ScrollText, onClick: () => ui.open((close) => <DumpDialog conn={c} db={db} schema={schema} content="structure" onClose={close} />) },
    { label: t('SQL 덤프 내보내기…'), icon: DatabaseBackup, onClick: () => ui.open((close) => <DumpDialog conn={c} db={db} schema={schema} onClose={close} />) },
    { label: t('SQL 파일 실행…'), icon: FilePlay, onClick: () => ui.open((close) => <RunFileDialog conn={c} ensureConnected={() => ws.ensureConnected(c.id)} db={db} schema={schema} onClose={close} />) },
    'sep',
    { label: t('이름 복사'), icon: Copy, onClick: () => void api.copyText(schema) },
  ])
  return (
    <>
      <Row depth={2} k={k} ctx={ctx} meta={{ connId: c.id, db, schema }} icon={<FolderTree className="schema-icon" />} label={schema} expandable onMenu={menu} />
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
      <Row depth={depth} k={k} ctx={ctx} meta={{ connId: c.id, db, schema }} icon={<Folder className="folder-icon" />} label={kind === 'table' ? t('표') : t('뷰')} extra={<span className="count">{items.length}</span>} expandable />
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
      { label: t('SQL 덤프 내보내기…'), icon: DatabaseBackup, onClick: () => ui.open((close) => <DumpDialog conn={c} db={ref2.db} schema={ref2.schema} only={obj.name} onClose={close} />) },
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
        meta={{ connId: c.id, db: ref2.db, schema: ref2.schema, table: obj.name, kind: obj.kind }}
        chevronOnly
        icon={isView ? <Eye className="view-icon" /> : <Table2 className="table-icon" />}
        label={obj.name}
        title={`${obj.comment ? obj.comment + '\n' : ''}${t('더블클릭: 데이터 열기 · 화살표: 열·인덱스 보기')}`}
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
      <Row depth={depth} k={kc} ctx={ctx} meta={{ connId: c.id, db: ref2.db, schema: ref2.schema, table: ref2.table, kind: isView ? 'view' : 'table' }} open={colsOpen} onToggle={() => ctx.toggle(kc)} icon={<Columns3 />} label={t('열|column')} extra={cols.data && <span className="count">{cols.data.length}</span>} expandable loading={cols.isFetching} />
      {colsOpen && cols.error && <ErrorRow depth={depth + 1} error={cols.error} />}
      {colsOpen && cols.data?.map((col) => (
        <div key={col.name} className="tree-row leaf" style={{ paddingLeft: 4 + (depth + 1) * 16 }} title={[col.type, col.nullable ? 'NULL' : 'NOT NULL', col.default !== null ? 'DEFAULT ' + col.default : '', col.comment].filter(Boolean).join(' · ')}>
          <span className="tree-chev none" />
          <span className="tree-icon">{col.pk ? <KeyRound className="pk-icon" /> : <span className="col-dot" />}</span>
          <span className="tree-label ellipsis">{col.name}</span>
          <span className="tree-extra mono muted">{col.type}{col.nullable ? '' : ' !'}</span>
        </div>
      ))}
      {!isView && (
        <>
          <Row depth={depth} k={ki} ctx={ctx} meta={{ connId: c.id, db: ref2.db, schema: ref2.schema, table: ref2.table, kind: 'table' }} icon={<ListTree />} label={t('인덱스')} extra={idx.data && <span className="count">{idx.data.length}</span>} expandable loading={idx.isFetching} />
          {idxOpen && idx.error && <ErrorRow depth={depth + 1} error={idx.error} />}
          {idxOpen && idx.data?.length === 0 && <Empty depth={depth + 1}>{t('인덱스가 없어요')}</Empty>}
          {idxOpen && idx.data?.map((ix) => (
            <div key={ix.name} className="tree-row leaf" style={{ paddingLeft: 4 + (depth + 1) * 16 }} title={ix.columns.join(', ')}>
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
