// 앱 틀: 왼쪽 아이콘 줄(탐색기·실행 기록·설정) · 옆 칸 · 탭(SQL 편집기·표) · 탭이 없으면 시작 화면
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Database, Eye, History, Plus, Settings, SquareTerminal, Table2, X } from 'lucide-react'
import { resolveLang, setLang, getLang, t } from './i18n'
import { useSettings } from './api'
import { UiProvider, useUi } from './ui'
import { useWs, WsProvider, type Tab } from './ws'
import { Navigator } from './components/Navigator'
import { HistoryPanel } from './components/HistoryPanel'
import { Splitter, usePaneSize, clamp } from './components/Splitter'
import UpdateChip from './components/UpdateChip'
import { DriverBadge } from './components/DriverBadge'
import { EditorTabView } from './views/EditorTab'
import { TableTabView } from './views/TableTab'
import { Welcome } from './views/Welcome'
import { SettingsDialog } from './dialogs/SettingsDialog'
import { displayName } from '../../shared/dialect'

export default function App() {
  const settings = useSettings()
  // 언어는 설정을 읽은 뒤 정하고, 바뀌면 화면 전체를 다시 그린다
  const lang = settings.data ? resolveLang(settings.data.language, navigator.language) : null
  if (lang && getLang() !== lang) setLang(lang)
  useEffect(() => {
    if (lang) document.documentElement.lang = lang
  }, [lang])
  if (!lang) return <div className="splash" />
  return (
    <UiProvider key={lang}>
      <WsProvider>
        <Shell />
      </WsProvider>
    </UiProvider>
  )
}

function tabTitle(tab: Tab): string {
  return tab.kind === 'editor' ? tab.title : displayName(tab.ref)
}

function Shell() {
  const ws = useWs()
  const ui = useUi()
  const [sideW, setSideW, resetSideW] = usePaneSize('side', 290)
  const [drag, setDrag] = useState<string | null>(null)
  const shell = useRef<HTMLDivElement>(null)

  // 단축키: Ctrl+] 새 SQL 편집기, Ctrl+W 탭 닫기, Ctrl+Tab 다음 탭
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key === ']') {
        e.preventDefault()
        const id = ws.lastConnId ?? ws.connections[0]?.id
        if (id) void ws.ensureConnected(id).then((ok) => ok && ws.openEditor(id))
        else ws.editConnection()
      } else if (e.key === 'w' || e.key === 'W') {
        if (ws.active && !document.querySelector('.dialog')) {
          e.preventDefault()
          void ws.closeTab(ws.active)
        }
      } else if (e.key === 'Tab' && ws.tabs.length > 1) {
        e.preventDefault()
        const i = ws.tabs.findIndex((x) => x.id === ws.active)
        const next = ws.tabs[(i + (e.shiftKey ? -1 : 1) + ws.tabs.length) % ws.tabs.length]
        ws.setActive(next.id)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [ws])

  const openSettings = () => ui.open((close) => <SettingsDialog initial={ws.settings} onClose={close} />)

  const newEditor = async () => {
    const id = ws.lastConnId ?? ws.connections[0]?.id
    if (!id) {
      ws.editConnection()
      return
    }
    if (await ws.ensureConnected(id)) ws.openEditor(id)
  }

  const dropOn = (e: DragEvent, target: string) => {
    e.preventDefault()
    if (!drag || drag === target) return
    const from = ws.tabs.findIndex((x) => x.id === drag)
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const after = e.clientX > r.left + r.width / 2
    const list = ws.tabs.filter((x) => x.id !== drag)
    const at = list.findIndex((x) => x.id === target) + (after ? 1 : 0)
    list.splice(at, 0, ws.tabs[from])
    reorder(list)
    setDrag(null)
  }
  const reorder = (list: Tab[]) => ws.reorder(list.map((x) => x.id))

  return (
    <div className="app" ref={shell}>
      <nav className="rail">
        <div className="rail-logo" title="DBoard"><img src="./icon.png" alt="DBoard" /></div>
        <button className={`rail-btn ${ws.panel === 'nav' ? 'on' : ''}`} title={t('탐색기')} onClick={() => ws.setPanel('nav')}><Database /></button>
        <button className={`rail-btn ${ws.panel === 'history' ? 'on' : ''}`} title={t('실행 기록')} onClick={() => ws.setPanel('history')}><History /></button>
        <button className="rail-btn" title={t('새 SQL 편집기 (Ctrl+])')} onClick={() => void newEditor()}><SquareTerminal /></button>
        <span className="spacer" />
        <button className="rail-btn" title={t('설정')} onClick={openSettings}><Settings /></button>
      </nav>
      <aside className="side" style={{ width: sideW }}>
        {ws.panel === 'nav' ? <Navigator /> : <HistoryPanel />}
      </aside>
      <Splitter dir="col" onReset={resetSideW} onDrag={(x) => {
        const left = shell.current?.getBoundingClientRect().left ?? 0
        setSideW(clamp(x - left - 52, 200, 640))
      }} />
      <main className="main">
        <div className="tabbar" role="tablist">
          {ws.tabs.map((tab) => {
            const c = ws.conn(tab.connId)
            const Icon = tab.kind === 'editor' ? SquareTerminal : tab.objKind === 'view' ? Eye : Table2
            return (
              <div
                key={tab.id}
                className={`tab ${ws.active === tab.id ? 'on' : ''} ${drag === tab.id ? 'dragging' : ''}`}
                role="tab"
                aria-selected={ws.active === tab.id}
                draggable
                onDragStart={() => setDrag(tab.id)}
                onDragEnd={() => setDrag(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => dropOn(e, tab.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    void ws.closeTab(tab.id)
                  } else if (e.button === 0) ws.setActive(tab.id)
                }}
                onContextMenu={(e) => ui.menu(e, [
                  { label: t('닫기'), icon: X, hint: 'Ctrl+W', onClick: () => void ws.closeTab(tab.id) },
                  { label: t('다른 탭 모두 닫기'), onClick: () => ws.closeOthers(tab.id) },
                ])}
                title={`${tabTitle(tab)} — ${c?.name ?? ''}`}
                style={c?.color ? { boxShadow: `inset 0 2px 0 ${c.color}` } : undefined}
              >
                <Icon />
                {c && <DriverBadge driver={c.driver} size={12} />}
                <span className="ellipsis">{tabTitle(tab)}</span>
                <button className="tab-close" onMouseDown={(e) => e.stopPropagation()} onClick={() => void ws.closeTab(tab.id)} aria-label={t('닫기')}><X /></button>
              </div>
            )
          })}
          <button className="tab-new" title={t('새 SQL 편집기 (Ctrl+])')} onClick={() => void newEditor()}><Plus /></button>
          <span className="spacer" />
          <UpdateChip />
        </div>
        <div className="tab-content">
          {ws.tabs.length === 0 || !ws.tabs.some((x) => x.id === ws.active) ? <Welcome /> : null}
          {ws.tabs.map((tab) => (
            <div key={tab.id} className="tab-pane" style={{ display: ws.active === tab.id ? 'flex' : 'none' }}>
              {tab.kind === 'editor' ? <EditorTabView tab={tab} /> : <TableTabView tab={tab} active={ws.active === tab.id} />}
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
