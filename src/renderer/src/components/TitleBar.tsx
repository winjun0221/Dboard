// 제목 줄: 로고 · 메뉴(파일·보기·SQL·도움말) · 가운데 지금 탭 이름 · 업데이트·설정. 오른쪽 창 단추는 Windows가 그린다
import { useRef, useState, type MouseEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  AlignLeft, CircleCheckBig, CircleHelp, DatabaseBackup, ExternalLink, ListTree, Undo2, FilePlay, ScrollText, History, Info, Keyboard, LogOut, PanelLeft, Play, PlaySquare, Plus, RefreshCw, Settings, Square, SquareTerminal, X, Database, FolderOpen, Save, Activity, FileCode2, Download, Upload, GitCompareArrows, ArrowRightLeft,
} from 'lucide-react'
import type { AppSettings } from '../../../shared/types'
import { api, errorText } from '../api'
import { useWs } from '../ws'
import { useUi, type MenuItem } from '../ui'
import { t } from '../i18n'
import { editorActions } from '../editors'
import { tabTitle, type ShellActions } from '../App'
import UpdateChip from './UpdateChip'
import { ShortcutsDialog } from '../dialogs/ShortcutsDialog'
import { DumpDialog } from '../dialogs/DumpDialog'
import { RunFileDialog } from '../dialogs/RunFileDialog'
import { SessionsDialog } from '../dialogs/SessionsDialog'
import { CompareDialog } from '../dialogs/CompareDialog'
import { TransferDialog } from '../dialogs/TransferDialog'

type MenuName = 'file' | 'view' | 'sql' | 'help'

export function TitleBar({ actions }: { actions: ShellActions }) {
  const ws = useWs()
  const ui = useUi()
  const qc = useQueryClient()
  const [open, setOpen] = useState<MenuName | null>(null)
  const openRef = useRef<MenuName | null>(null)
  openRef.current = open
  const activeTab = ws.tabs.find((x) => x.id === ws.active)
  const activeConn = activeTab ? ws.conn(activeTab.connId) : undefined

  const setTheme = async (theme: AppSettings['theme']) => {
    try {
      qc.setQueryData(['settings'], await api.saveSettings({ ...ws.settings, theme }))
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  const checkUpdates = async () => {
    try {
      const s = await api.checkForUpdates()
      qc.setQueryData(['update'], s)
      if (s.state === 'latest') ui.notify(t('지금 쓰는 버전이 최신이에요'), 'success')
      else if (s.state === 'error') ui.notify(s.message ?? t('업데이트를 확인하지 못했어요'), 'error')
      else if (s.state === 'disabled') ui.notify(s.message ?? t('이 버전은 자동 업데이트를 쓰지 않아요'), 'info')
      else if (s.state === 'downloading') ui.notify(t('새 버전 {version}을(를) 받는 중', { version: s.newVersion ?? '' }), 'info')
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  // 지금 탭의 접속·DB·스키마 (덤프·SQL 파일 실행 대상)
  const here = activeTab
    ? activeTab.kind !== 'table'
      ? { connId: activeTab.connId, db: activeTab.db, schema: activeTab.schema, table: undefined }
      : { connId: activeTab.connId, db: activeTab.ref.db, schema: activeTab.ref.schema, table: activeTab.ref.table }
    : null
  const withConn = async (fn: (h: NonNullable<typeof here>) => void) => {
    if (here && (await ws.ensureConnected(here.connId))) fn(here)
  }

  const exportConns = async () => {
    try {
      const n = await api.exportConnections()
      if (n !== null) ui.notify(t('접속 {n}개를 내보냈어요 (비밀번호는 빼고)', { n }), 'success')
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }
  const importConns = async () => {
    try {
      const n = await api.importConnections()
      if (n === null) return
      void qc.invalidateQueries({ queryKey: ['connections'] })
      ui.notify(t('접속 {n}개를 가져왔어요. 비밀번호는 연결할 때 물어봐요.', { n }), 'success')
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  const items = (name: MenuName): MenuItem[] => {
    const ed = editorActions(activeTab?.kind === 'editor' ? activeTab.id : null)
    switch (name) {
      case 'file':
        return [
          { label: t('새 연결…'), icon: Plus, onClick: () => ws.editConnection() },
          { label: t('새 SQL 편집기'), icon: SquareTerminal, hint: 'Ctrl+]', onClick: actions.newEditor },
          { label: t('SQL 파일 열기…'), icon: FolderOpen, hint: 'Ctrl+O', onClick: actions.openFile },
          { label: t('저장'), icon: Save, hint: 'Ctrl+S', disabled: !ed, onClick: () => ed?.save(false) },
          { label: t('다른 이름으로 저장…'), hint: 'Ctrl+Shift+S', disabled: !ed, onClick: () => ed?.save(true) },
          'sep',
          { label: t('DDL 내보내기…'), icon: ScrollText, disabled: !here?.db, onClick: () => void withConn((h) => ui.open((close) => <DumpDialog conn={ws.conn(h.connId)!} db={h.db} schema={h.schema} content="structure" onClose={close} />)) },
          { label: t('SQL 덤프 내보내기…'), icon: DatabaseBackup, disabled: !here?.db, onClick: () => void withConn((h) => ui.open((close) => <DumpDialog conn={ws.conn(h.connId)!} db={h.db} schema={h.schema} only={h.table} onClose={close} />)) },
          { label: t('SQL 파일 실행…'), icon: FilePlay, disabled: !here, onClick: () => void withConn((h) => ui.open((close) => <RunFileDialog conn={ws.conn(h.connId)!} ensureConnected={() => ws.ensureConnected(h.connId)} db={h.db} schema={h.schema} onClose={close} />)) },
          { label: t('스키마 비교…'), icon: GitCompareArrows, disabled: !here, onClick: () => void withConn((h) => ui.open((close) => (
            <CompareDialog conn={ws.conn(h.connId)!} db={h.db} schema={h.schema} connections={ws.connections} ensureConnected={ws.ensureConnected} onClose={close}
              openEditor={(connId, d, s, text) => { close(); ws.openEditor(connId, { db: d, schema: s, text }) }} />
          ))) },
          { label: t('데이터 옮기기…'), icon: ArrowRightLeft, disabled: !here, onClick: () => void withConn((h) => ui.open((close) => (
            <TransferDialog conn={ws.conn(h.connId)!} db={h.db} schema={h.schema} only={h.table} connections={ws.connections} ensureConnected={ws.ensureConnected} onClose={close} />
          ))) },
          'sep',
          { label: t('접속 목록 내보내기…'), icon: Download, disabled: ws.connections.length === 0, onClick: () => void exportConns() },
          { label: t('접속 목록 가져오기…'), icon: Upload, onClick: () => void importConns() },
          'sep',
          { label: t('탭 닫기'), icon: X, hint: 'Ctrl+W', disabled: !activeTab, onClick: () => activeTab && void ws.closeTab(activeTab.id) },
          { label: t('다른 탭 모두 닫기'), disabled: ws.tabs.length < 2 || !activeTab, onClick: () => activeTab && ws.closeOthers(activeTab.id) },
          'sep',
          { label: t('설정…'), icon: Settings, hint: 'Ctrl+,', onClick: () => actions.openSettings() },
          'sep',
          { label: t('끝내기'), icon: LogOut, hint: 'Alt+F4', onClick: () => window.close() },
        ]
      case 'view':
        return [
          { label: t('탐색기'), icon: Database, checked: !actions.sideHidden && ws.panel === 'nav', onClick: () => { ws.setPanel('nav'); if (actions.sideHidden) actions.toggleSide() } },
          { label: t('스크립트'), icon: FileCode2, checked: !actions.sideHidden && ws.panel === 'scripts', onClick: () => { ws.setPanel('scripts'); if (actions.sideHidden) actions.toggleSide() } },
          { label: t('실행 기록'), icon: History, checked: !actions.sideHidden && ws.panel === 'history', onClick: () => { ws.setPanel('history'); if (actions.sideHidden) actions.toggleSide() } },
          { label: actions.sideHidden ? t('옆 칸 보이기') : t('옆 칸 숨기기'), icon: PanelLeft, hint: 'Ctrl+B', onClick: actions.toggleSide },
          'sep',
          { section: t('테마') },
          { label: t('Windows 설정 따라가기'), checked: ws.settings.theme === 'system', onClick: () => void setTheme('system') },
          { label: t('밝게'), checked: ws.settings.theme === 'light', onClick: () => void setTheme('light') },
          { label: t('어둡게'), checked: ws.settings.theme === 'dark', onClick: () => void setTheme('dark') },
          'sep',
          { label: t('세션 관리자…'), icon: Activity, disabled: !here || ws.conn(here.connId)?.driver === 'sqlite', onClick: () => void withConn((h) => ui.open((close) => <SessionsDialog conn={ws.conn(h.connId)!} onClose={close} />)) },
        ]
      case 'sql':
        return [
          { label: t('실행'), icon: Play, hint: 'Ctrl+Enter', disabled: !ed || ed.running, onClick: () => ed?.run('current') },
          { label: t('스크립트 실행'), icon: PlaySquare, hint: 'Alt+X', disabled: !ed || ed.running, onClick: () => ed?.run('script') },
          { label: t('실행 취소'), icon: Square, disabled: !ed?.running, onClick: () => ed?.cancel() },
          { label: t('실행 계획'), icon: ListTree, hint: 'Ctrl+Shift+E', disabled: !ed || ed.running, onClick: () => ed?.explain() },
          { label: t('SQL 정렬'), icon: AlignLeft, hint: 'Ctrl+Shift+F', disabled: !ed, onClick: () => ed?.format() },
          'sep',
          { label: t('수동 커밋'), checked: !!ed?.manual, disabled: !ed, onClick: () => ed?.toggleManual() },
          { label: ed?.pending ? t('커밋 ({n})', { n: ed.pending }) : t('커밋'), icon: CircleCheckBig, disabled: !ed?.manual, onClick: () => ed?.commit() },
          { label: t('롤백'), icon: Undo2, disabled: !ed?.manual, onClick: () => ed?.rollback() },
          'sep',
          { label: t('새 SQL 편집기'), icon: SquareTerminal, hint: 'Ctrl+]', onClick: actions.newEditor },
          { label: t('실행 기록'), icon: History, onClick: () => { ws.setPanel('history'); if (actions.sideHidden) actions.toggleSide() } },
        ]
      case 'help':
        return [
          { label: t('단축키'), icon: Keyboard, onClick: () => ui.open((close) => <ShortcutsDialog onClose={close} />) },
          { label: t('업데이트 확인'), icon: RefreshCw, onClick: () => void checkUpdates() },
          { label: t('GitHub 페이지'), icon: ExternalLink, onClick: () => void api.openUrl('https://github.com/winjun0221/dboard') },
          'sep',
          { label: t('DBoard 정보'), icon: Info, onClick: () => actions.openSettings('about') },
        ]
    }
  }

  const show = (name: MenuName, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setOpen(name)
    ui.menu({ x: r.left, y: r.bottom + 2 }, items(name), { onClose: () => setOpen(null), className: 'menubar-menu' })
  }

  const MENUS: { name: MenuName; label: string }[] = [
    { name: 'file', label: t('파일') },
    { name: 'view', label: t('보기') },
    { name: 'sql', label: 'SQL' },
    { name: 'help', label: t('도움말') },
  ]

  return (
    <header className="titlebar">
      <img className="titlebar-logo" src="./icon.png" alt="DBoard" />
      <nav className="menubar" role="menubar">
        {MENUS.map((m) => (
          <button
            key={m.name}
            className={`menubar-btn ${open === m.name ? 'on' : ''}`}
            role="menuitem"
            onMouseDown={(e: MouseEvent<HTMLButtonElement>) => {
              if (e.button !== 0) return
              // 열린 메뉴를 다시 누르면 닫기만 (메뉴 바깥 누름으로 이미 닫혔다)
              if (openRef.current === m.name) return
              show(m.name, e.currentTarget)
            }}
            onMouseEnter={(e) => { if (openRef.current && openRef.current !== m.name) show(m.name, e.currentTarget) }}
          >
            {m.label}
          </button>
        ))}
      </nav>
      <div className="titlebar-title ellipsis">
        {activeTab ? <>{tabTitle(activeTab)}{activeConn && <span className="muted"> — {activeConn.name}</span>}<span className="muted"> · DBoard</span></> : 'DBoard'}
      </div>
      <div className="titlebar-right">
        <UpdateChip />
        <button className="icon-btn small" title={t('단축키')} onClick={() => ui.open((close) => <ShortcutsDialog onClose={close} />)}><CircleHelp /></button>
        <button className="icon-btn small" title={t('설정')} onClick={() => actions.openSettings()}><Settings /></button>
      </div>
    </header>
  )
}
