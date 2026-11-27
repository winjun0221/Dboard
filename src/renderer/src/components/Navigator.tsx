// 왼쪽 탐색기: 접속 → DB → (스키마) → 표·뷰 묶음 → 표 → 열·인덱스. 펼칠 때 읽고, 새로고침 전까지 기억
import { useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  ChevronRight, ChevronsDownUp, Columns3, Copy, Database, DatabaseBackup, Eraser, Eye, FilePlay, ScrollText, FileCode2, FilePlus2, Folder, FolderTree, KeyRound, ListTree, LoaderCircle, Pencil, PencilRuler, PenLine, Plug, Plus, RefreshCw, Search, SquareTerminal, Table2, Trash2, Unplug, Upload, X, Download, Workflow, SquareFunction, Zap, ListOrdered, CalendarClock, Activity, FolderInput, FolderMinus, Network, GitCompareArrows, ArrowRightLeft, FileSearch, Gauge, Users,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { dropExtraSql, objectSql, type ObjectAction } from '../../../shared/alter'
import { dialectOf, EXTRA_KINDS, type ConnectionInfo, type DbObject, type ExtraKind, type ExtraObject, type ObjectKind, type TableRef } from '../../../shared/types'
import { api, errorText, useColumns, useDatabases, useExtras, useIndexes, useObjects, useRefreshConn, useSchemas } from '../api'
import { defaultContext, useWs } from '../ws'
import { useUi, type MenuItem } from '../ui'
import { t, tk } from '../i18n'
import { connSummary } from '../format'
import { DriverBadge } from './DriverBadge'
import { ImportDialog } from '../dialogs/ImportDialog'
import { DumpDialog } from '../dialogs/DumpDialog'
import { RunFileDialog } from '../dialogs/RunFileDialog'
import { DdlDialog } from '../dialogs/DdlDialog'
import { RenameDialog } from '../dialogs/RenameDialog'
import { SessionsDialog } from '../dialogs/SessionsDialog'
import { CompareDialog } from '../dialogs/CompareDialog'
import { TransferDialog } from '../dialogs/TransferDialog'
import { SearchDialog } from '../dialogs/SearchDialog'
import { StatsDialog } from '../dialogs/StatsDialog'
import { UsersDialog } from '../dialogs/UsersDialog'

/** 전체 검색·서버 상태·사용자 창 */
export function useServerTools() {
  const ws = useWs()
  const ui = useUi()
  return {
    search: (c: ConnectionInfo, db: string, schema: string) => ui.open((close) => (
      <SearchDialog conn={c} db={db} schema={schema} ensureConnected={ws.ensureConnected} onClose={close}
        openTable={(ref, kind, filter) => ws.openTable(c.id, ref, kind, 'data', filter)}
        openEditor={(d, s, text) => ws.openEditor(c.id, { db: d, schema: s, text })} />
    )),
    stats: async (c: ConnectionInfo) => {
      if (await ws.ensureConnected(c.id)) ui.open((close) => <StatsDialog conn={c} onClose={close} />)
    },
    users: async (c: ConnectionInfo, db: string, schema: string) => {
      if (await ws.ensureConnected(c.id)) ui.open((close) => <UsersDialog conn={c} db={db} schema={schema} onClose={close} />)
    },
  }
}

/** 스키마 비교·데이터 옮기기 창 (대화 상자 안에서 useWs를 못 쓰니 필요한 것을 넘긴다) */
function useCompareTransfer() {
  const ws = useWs()
  const ui = useUi()
  return {
    compare: (c: ConnectionInfo, db: string, schema: string) => ui.open((close) => (
      <CompareDialog conn={c} db={db} schema={schema} connections={ws.connections} ensureConnected={ws.ensureConnected} onClose={close}
        openEditor={(connId, d, s, text) => { close(); ws.openEditor(connId, { db: d, schema: s, text }) }} />
    )),
    transfer: (c: ConnectionInfo, db: string, schema: string, only?: string) => ui.open((close) => (
      <TransferDialog conn={c} db={db} schema={schema} only={only} connections={ws.connections} ensureConnected={ws.ensureConnected} onClose={close} />
    )),
  }
}

/** 표·뷰 이름 바꾸기·비우기·지우기: 실행할 SQL을 보여 주고 확인받은 뒤 실행. 열린 탭도 맞춘다 */
function useObjectAction() {
  const ws = useWs()
  const ui = useUi()
  const refresh = useRefreshConn()
  return async (c: ConnectionInfo, ref: TableRef, kind: ObjectKind, action: ObjectAction) => {
    let newName = ''
    if (action === 'rename') {
      const name = await new Promise<string | null>((resolve) => {
        ui.open((close) => <RenameDialog title={kind === 'view' ? t('뷰 이름 바꾸기') : t('표 이름 바꾸기')} current={ref.table} onClose={() => { resolve(null); close() }} onSubmit={(v) => { resolve(v); close() }} />)
      })
      if (!name) return
      newName = name
    }
    let statements: string[]
    try {
      statements = objectSql(dialectOf(c.driver), ref, kind, action, newName)
    } catch (e) {
      ui.notify(errorText(e), 'error')
      return
    }
    const title = action === 'rename' ? (kind === 'view' ? t('뷰 이름 바꾸기') : t('표 이름 바꾸기')) : action === 'truncate' ? t('표 비우기') : kind === 'view' ? t('뷰 지우기') : t('표 지우기')
    const warnings = action === 'truncate' ? [t('"{name}"의 모든 행을 지워요. 되돌릴 수 없어요.', { name: ref.table })]
      : action === 'drop' ? [kind === 'view' ? t('뷰 "{name}"을(를) 지워요. 되돌릴 수 없어요.', { name: ref.table }) : t('표 "{name}"을(를) 지워요. 데이터도 함께 사라지고 되돌릴 수 없어요.', { name: ref.table })] : []
    ui.open((close) => (
      <DdlDialog title={title} driver={c.driver} statements={statements} warnings={warnings} production={c.production === true} danger={action !== 'rename'}
        submitLabel={action === 'rename' ? t('이름 바꾸기') : action === 'truncate' ? t('비우기') : t('지우기')}
        onClose={close}
        onSubmit={async () => {
          try {
            await api.runDdl(c.id, ref.db, ref.schema, statements)
          } catch (e) {
            ui.notify(errorText(e), 'error')
            return
          }
          close()
          ui.notify(action === 'rename' ? t('이름을 바꿨어요: {name}', { name: newName }) : action === 'truncate' ? t('표를 비웠어요: {name}', { name: ref.table }) : t('지웠어요: {name}', { name: ref.table }), 'success')
          refresh(c.id)
          for (const tb of ws.tabs) {
            if (tb.kind !== 'table' || tb.newTable || tb.connId !== c.id || tb.ref.db !== ref.db || tb.ref.schema !== ref.schema || tb.ref.table !== ref.table) continue
            if (action === 'drop') void ws.closeTab(tb.id)
            else if (action === 'rename') ws.updateTab(tb.id, { ref: { ...ref, table: newName } })
          }
        }}
      />
    ))
  }
}

const EXPAND_KEY = 'dboard.tree.expanded'

/** 들여쓰기: 줄 깊이 + 접속 폴더 안이면 한 칸 더 (--tree-indent) */
const pad = (px: number): CSSProperties => ({ paddingLeft: `calc(${px}px + var(--tree-indent, 0px))` })

const EXTRA_LABEL: Record<ExtraKind, string> = { procedure: tk('프로시저'), function: tk('함수'), trigger: tk('트리거'), sequence: tk('시퀀스'), event: tk('이벤트') }
const EXTRA_ICON = { procedure: Workflow, function: SquareFunction, trigger: Zap, sequence: ListOrdered, event: CalendarClock }

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
      style={pad(4 + depth * 16)}
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
  return <div className="tree-empty" style={pad(24 + depth * 16)}>{children}</div>
}

function ErrorRow({ depth, error }: { depth: number; error: unknown }) {
  return <div className="tree-empty error" style={pad(24 + depth * 16)} title={errorText(error)}>{errorText(error)}</div>
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
  const tools = useServerTools()
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
  const folders = [...new Set(ws.connections.map((c) => c.folder ?? '').filter(Boolean))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
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
        <button className="icon-btn small" title={t('전체 검색…')} disabled={!meta} onClick={() => {
          const c = meta && ws.conn(meta.connId)
          if (!c) return
          const def = defaultContext(c)
          tools.search(c, meta!.db ?? def.db, meta!.schema ?? def.schema)
        }}><FileSearch /></button>
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
        {folders.map((f) => <ConnFolder key={f} name={f} conns={ws.connections.filter((c) => c.folder === f)} folders={folders} ctx={ctx} />)}
        {ws.connections.filter((c) => !c.folder).map((c) => <ConnNode key={c.id} c={c} folders={folders} ctx={ctx} />)}
      </div>
    </div>
  )
}

/** 접속 폴더: 처음부터 펼쳐 두고 접은 것만 기억 */
function ConnFolder({ name, conns, folders, ctx }: { name: string; conns: ConnectionInfo[]; folders: string[]; ctx: TreeCtx }) {
  const ui = useUi()
  const qc = useQueryClient()
  const k = 'gc:' + name
  const open = !ctx.expanded.has(k) || !!ctx.filter
  const setFolder = async (folder: string) => {
    try {
      await api.setConnectionFolder(conns.map((c) => c.id), folder)
      void qc.invalidateQueries({ queryKey: ['connections'] })
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }
  const menu = (e: MouseEvent) => ui.menu(e, [
    { label: t('폴더 이름 바꾸기…'), icon: PenLine, onClick: () => ui.open((close) => <RenameDialog title={t('폴더 이름 바꾸기')} current={name} onClose={close} onSubmit={(v) => { close(); void setFolder(v) }} />) },
    { label: t('폴더 풀기'), icon: FolderMinus, onClick: () => void setFolder('') },
  ])
  return (
    <>
      <Row depth={0} k={k} ctx={ctx} open={open} onToggle={() => ctx.toggle(k)} icon={<Folder className="folder-icon" />} label={name} extra={<span className="count">{conns.length}</span>} expandable onMenu={menu} className="conn-folder" />
      {open && <div style={{ '--tree-indent': '16px' } as CSSProperties}>{conns.map((c) => <ConnNode key={c.id} c={c} folders={folders} ctx={ctx} />)}</div>}
    </>
  )
}

function ConnNode({ c, folders, ctx }: { c: ConnectionInfo; folders: string[]; ctx: TreeCtx }) {
  const ws = useWs()
  const ui = useUi()
  const tools = useServerTools()
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
    { label: t('전체 검색…'), icon: FileSearch, onClick: () => { const def = defaultContext(c); tools.search(c, def.db, def.schema) } },
    c.driver !== 'sqlite' && { label: t('서버 상태…'), icon: Gauge, onClick: () => void tools.stats(c) },
    c.driver !== 'sqlite' && { label: t('사용자·권한…'), icon: Users, onClick: () => { const def = defaultContext(c); void tools.users(c, def.db, def.schema) } },
    c.driver !== 'sqlite' && { label: t('세션 관리자…'), icon: Activity, onClick: async () => { if (await ws.ensureConnected(c.id)) ui.open((close) => <SessionsDialog conn={c} onClose={close} />) } },
    'sep',
    { label: t('고치기'), icon: Pencil, onClick: () => ws.editConnection(c) },
    { label: t('복제'), icon: Copy, onClick: async () => { await api.duplicateConnection(c.id); void qc.invalidateQueries({ queryKey: ['connections'] }) } },
    { label: t('폴더로 옮기기…'), icon: FolderInput, onClick: () => ui.open((close) => (
      <RenameDialog title={t('폴더로 옮기기')} label={t('폴더 이름 (비우면 폴더에서 빼기)')} current={c.folder ?? ''} allowEmpty suggestions={folders} onClose={close}
        onSubmit={(v) => {
          close()
          void api.setConnectionFolder([c.id], v).then(() => qc.invalidateQueries({ queryKey: ['connections'] }), (err) => ui.notify(errorText(err), 'error'))
        }} />
    )) },
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
  const tools = useServerTools()
  const ct = useCompareTransfer()
  const k = `d:${c.id}:${db}`
  const open = ctx.expanded.has(k)
  const schemas = useSchemas(c.id, db, open && hasSchemas)
  const def = defaultContext(c)
  const menu = (e: MouseEvent) => ui.menu(e, [
    { label: t('새 SQL 편집기'), icon: SquareTerminal, onClick: () => ws.openEditor(c.id, { db, schema: hasSchemas ? def.schema : '' }) },
    !hasSchemas && { label: t('새 표…'), icon: Plus, disabled: c.readOnly === true, onClick: () => ws.openNewTable(c.id, db, '') },
    !hasSchemas && { label: t('ER 다이어그램'), icon: Network, onClick: () => ws.openEr(c.id, db, '') },
    !hasSchemas && { label: t('스키마 비교…'), icon: GitCompareArrows, onClick: () => ct.compare(c, db, '') },
    !hasSchemas && { label: t('전체 검색…'), icon: FileSearch, onClick: () => tools.search(c, db, '') },
    !hasSchemas && { label: t('데이터 옮기기…'), icon: ArrowRightLeft, onClick: () => ct.transfer(c, db, '') },
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
  const tools = useServerTools()
  const ct = useCompareTransfer()
  const k = `s:${c.id}:${db}:${schema}`
  const open = ctx.expanded.has(k)
  const menu = (e: MouseEvent) => ui.menu(e, [
    { label: t('새 SQL 편집기'), icon: SquareTerminal, onClick: () => ws.openEditor(c.id, { db, schema }) },
    { label: t('새 표…'), icon: Plus, disabled: c.readOnly === true, onClick: () => ws.openNewTable(c.id, db, schema) },
    { label: t('ER 다이어그램'), icon: Network, onClick: () => ws.openEr(c.id, db, schema) },
    { label: t('스키마 비교…'), icon: GitCompareArrows, onClick: () => ct.compare(c, db, schema) },
    { label: t('전체 검색…'), icon: FileSearch, onClick: () => tools.search(c, db, schema) },
    { label: t('데이터 옮기기…'), icon: ArrowRightLeft, onClick: () => ct.transfer(c, db, schema) },
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
      <ExtraFolders c={c} db={db} schema={schema} depth={depth} ctx={ctx} />
    </>
  )
}

/** 프로시저·함수·트리거·시퀀스·이벤트 묶음 (있는 것만) */
function ExtraFolders({ c, db, schema, depth, ctx }: { c: ConnectionInfo; db: string; schema: string; depth: number; ctx: TreeCtx }) {
  const extras = useExtras(c.id, db, schema, true)
  if (extras.error) return <ErrorRow depth={depth} error={extras.error} />
  const all = (extras.data ?? []).filter((x) => !ctx.filter || x.name.toLowerCase().includes(ctx.filter))
  return (
    <>
      {EXTRA_KINDS.map((kind) => {
        const items = all.filter((x) => x.kind === kind)
        return items.length > 0 && <ExtraFolder key={kind} c={c} db={db} schema={schema} kind={kind} items={items} depth={depth} ctx={ctx} />
      })}
    </>
  )
}

function ExtraFolder({ c, db, schema, kind, items, depth, ctx }: { c: ConnectionInfo; db: string; schema: string; kind: ExtraKind; items: ExtraObject[]; depth: number; ctx: TreeCtx }) {
  const k = `x:${c.id}:${db}:${schema}:${kind}`
  const open = ctx.expanded.has(k) || !!ctx.filter
  return (
    <>
      <Row depth={depth} k={k} ctx={ctx} meta={{ connId: c.id, db, schema }} icon={<Folder className="folder-icon" />} label={t(EXTRA_LABEL[kind])} extra={<span className="count">{items.length}</span>} expandable />
      {open && items.map((x) => <ExtraNode key={x.id + ':' + x.args} c={c} db={db} schema={schema} x={x} depth={depth + 1} ctx={ctx} />)}
    </>
  )
}

function ExtraNode({ c, db, schema, x, depth, ctx }: { c: ConnectionInfo; db: string; schema: string; x: ExtraObject; depth: number; ctx: TreeCtx }) {
  const ws = useWs()
  const ui = useUi()
  const refresh = useRefreshConn()
  const k = `xo:${c.id}:${db}:${schema}:${x.kind}:${x.id}`
  const Icon = EXTRA_ICON[x.kind]
  const openSource = async () => {
    try {
      const text = await api.objectSource(c.id, db, schema, x.kind, x.id)
      ws.openEditor(c.id, { db, schema, text })
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }
  const drop = () => {
    const sql = dropExtraSql(dialectOf(c.driver), { db, schema }, x)
    ui.open((close) => (
      <DdlDialog title={t('지우기: {name}', { name: x.name })} driver={c.driver} statements={[sql]} production={c.production === true} danger submitLabel={t('지우기')}
        warnings={[t('"{name}"을(를) 지워요. 되돌릴 수 없어요.', { name: x.name })]}
        onClose={close}
        onSubmit={async () => {
          try {
            await api.runDdl(c.id, db, schema, [sql])
          } catch (e) {
            ui.notify(errorText(e), 'error')
            return
          }
          close()
          ui.notify(t('지웠어요: {name}', { name: x.name }), 'success')
          refresh(c.id)
        }}
      />
    ))
  }
  const detail = x.kind === 'trigger' ? x.table : x.args ? `(${x.args})` : ''
  return (
    <Row
      depth={depth}
      k={k}
      ctx={ctx}
      meta={{ connId: c.id, db, schema }}
      icon={<Icon className={`extra-icon ${x.kind}`} />}
      label={x.name}
      extra={detail && <span className="mono muted">{detail}</span>}
      title={`${x.name}${detail ? ' ' + detail : ''}\n${t('더블클릭: 원본을 새 편집기에서 열기')}`}
      expandable={false}
      onDouble={() => void openSource()}
      onMenu={(e) => ui.menu(e, [
        { label: t('원본 보기 (새 편집기)'), icon: FileCode2, onClick: () => void openSource() },
        { label: t('이름 복사'), icon: Copy, onClick: () => void api.copyText(x.name) },
        'sep',
        { label: t('지우기…'), icon: Trash2, danger: true, disabled: c.readOnly === true, onClick: drop },
      ])}
    />
  )
}

function Folder2({ c, db, schema, kind, items, depth, ctx }: { c: ConnectionInfo; db: string; schema: string; kind: ObjectKind; items: DbObject[]; depth: number; ctx: TreeCtx }) {
  const ws = useWs()
  const ui = useUi()
  const k = `f:${c.id}:${db}:${schema}:${kind}`
  const menu = kind === 'table' ? (e: MouseEvent) => ui.menu(e, [{ label: t('새 표…'), icon: Plus, disabled: c.readOnly === true, onClick: () => ws.openNewTable(c.id, db, schema) }]) : undefined
  // 찾기 중에는 묶음을 펼친 것으로
  const open = ctx.expanded.has(k) || (!!ctx.filter && items.length > 0)
  return (
    <>
      <Row depth={depth} k={k} ctx={ctx} meta={{ connId: c.id, db, schema }} icon={<Folder className="folder-icon" />} label={kind === 'table' ? t('표') : t('뷰')} extra={<span className="count">{items.length}</span>} expandable onMenu={menu} />
      {open && items.map((o) => <ObjectNode key={o.name} c={c} ref2={{ db, schema, table: o.name }} obj={o} depth={depth + 1} ctx={ctx} />)}
    </>
  )
}

function ObjectNode({ c, ref2, obj, depth, ctx }: { c: ConnectionInfo; ref2: TableRef; obj: DbObject; depth: number; ctx: TreeCtx }) {
  const ws = useWs()
  const ui = useUi()
  const ct = useCompareTransfer()
  const qc = useQueryClient()
  const objectAction = useObjectAction()
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
      !isView && { label: t('표 설계'), icon: PencilRuler, onClick: () => ws.openTable(c.id, ref2, obj.kind, 'design') },
      !isView && { label: t('ER 다이어그램 (관련 표)'), icon: Network, onClick: () => ws.openEr(c.id, ref2.db, ref2.schema, obj.name) },
      !isView && { label: t('데이터 옮기기…'), icon: ArrowRightLeft, onClick: () => ct.transfer(c, ref2.db, ref2.schema, obj.name) },
      'sep',
      { label: t('SELECT 문으로 새 편집기'), icon: SquareTerminal, onClick: () => ws.openEditor(c.id, { db: ref2.db, schema: ref2.schema, text: selectSql() }) },
      !isView && { label: t('가져오기 (CSV·엑셀·JSON)…'), icon: Upload, onClick: () => ui.open((close) => <ImportDialog connId={c.id} target={ref2} onClose={close} onDone={() => void qc.invalidateQueries({ queryKey: ['table-data', c.id] })} />) },
      { label: t('CSV로 내보내기…'), icon: Download, onClick: () => ws.openTable(c.id, ref2, obj.kind, 'data') },
      { label: t('SQL 덤프 내보내기…'), icon: DatabaseBackup, onClick: () => ui.open((close) => <DumpDialog conn={c} db={ref2.db} schema={ref2.schema} only={obj.name} onClose={close} />) },
      'sep',
      { label: t('이름 복사'), icon: Copy, onClick: () => void api.copyText(obj.name) },
      !(isView && c.driver === 'sqlite') && { label: t('이름 바꾸기…'), icon: PenLine, disabled: c.readOnly === true, onClick: () => void objectAction(c, ref2, obj.kind, 'rename') },
      !isView && { label: t('비우기…'), icon: Eraser, disabled: c.readOnly === true, onClick: () => void objectAction(c, ref2, obj.kind, 'truncate') },
      { label: t('지우기…'), icon: Trash2, danger: true, disabled: c.readOnly === true, onClick: () => void objectAction(c, ref2, obj.kind, 'drop') },
      'sep',
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
        <div key={col.name} className="tree-row leaf" style={pad(4 + (depth + 1) * 16)} title={[col.type, col.nullable ? 'NULL' : 'NOT NULL', col.default !== null ? 'DEFAULT ' + col.default : '', col.comment].filter(Boolean).join(' · ')}>
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
            <div key={ix.name} className="tree-row leaf" style={pad(4 + (depth + 1) * 16)} title={ix.columns.join(', ')}>
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
