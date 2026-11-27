// 앱 틀: 제목 줄(메뉴) · 옆 칸(탐색기·실행 기록 탭) · 편집 탭(SQL 편집기·표) · 상태 줄. 탭이 없으면 시작 화면
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Database, Eye, FileCode2, History, PanelLeftClose, PanelLeftOpen, Plus, SquareTerminal, Table2, X } from 'lucide-react'
import { resolveLang, setLang, getLang, t } from './i18n'
import { api, errorText, useSettings } from './api'
import { UiProvider, useUi } from './ui'
import { useWs, WsProvider, type Tab } from './ws'
import { Navigator } from './components/Navigator'
import { HistoryPanel } from './components/HistoryPanel'
import { ScriptsPanel } from './components/ScriptsPanel'
import { Splitter, usePaneSize, clamp } from './components/Splitter'
import { TitleBar } from './components/TitleBar'
import { StatusBar } from './components/StatusBar'
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

export function tabTitle(tab: Tab): string {
  return tab.kind === 'editor' ? tab.title : tab.newTable ? t('새 표') : displayName(tab.ref)
}

const SIDE_KEY = 'dboard.side.hidden'

export interface ShellActions {
  newEditor(): void
  /** .sql 파일 열기 (고르는 창) */
  openFile(): void
  openSettings(tab?: 'general' | 'editor' | 'about'): void
  sideHidden: boolean
  toggleSide(): void
}

function Shell() {
  const ws = useWs()
  const ui = useUi()
  const qc = useQueryClient()
  const [sideW, setSideW, resetSideW] = usePaneSize('side', 300)
  const [sideHidden, setSideHidden] = useState(() => {
    try {
      return localStorage.getItem(SIDE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [drag, setDrag] = useState<string | null>(null)
  const body = useRef<HTMLDivElement>(null)

  const toggleSide = () => setSideHidden((h) => {
    try {
      localStorage.setItem(SIDE_KEY, h ? '0' : '1')
    } catch {
      // 기억 못 해도 지금은 그대로
    }
    return !h
  })

  const openSettings = (tab?: 'general' | 'editor' | 'about') => ui.open((close) => <SettingsDialog initial={ws.settings} initialTab={tab} onClose={close} />)

  const newEditor = async () => {
    const id = ws.lastConnId ?? ws.connections[0]?.id
    if (!id) {
      ws.editConnection()
      return
    }
    if (await ws.ensureConnected(id)) ws.openEditor(id)
  }

  const openFile = async () => {
    try {
      const f = await api.openSqlFile()
      if (!f) return
      ws.openScript(f)
      void qc.invalidateQueries({ queryKey: ['scripts'] })
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  const actions: ShellActions = { newEditor: () => void newEditor(), openFile: () => void openFile(), openSettings, sideHidden, toggleSide }

  // 단축키: Ctrl+] 새 SQL 편집기, Ctrl+O SQL 파일 열기, Ctrl+W 탭 닫기, Ctrl+Tab 다음 탭, Ctrl+B 옆 칸, Ctrl+, 설정
  const keys = useRef(actions)
  keys.current = actions
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const dialogOpen = !!document.querySelector('.dialog')
      if (e.key === ']') {
        e.preventDefault()
        keys.current.newEditor()
      } else if ((e.key === 'o' || e.key === 'O') && !e.shiftKey && !dialogOpen) {
        e.preventDefault()
        keys.current.openFile()
      } else if (e.key === 'w' || e.key === 'W') {
        if (ws.active && !dialogOpen) {
          e.preventDefault()
          void ws.closeTab(ws.active)
        }
      } else if (e.key === 'Tab' && ws.tabs.length > 1) {
        e.preventDefault()
        const i = ws.tabs.findIndex((x) => x.id === ws.active)
        const next = ws.tabs[(i + (e.shiftKey ? -1 : 1) + ws.tabs.length) % ws.tabs.length]
        ws.setActive(next.id)
      } else if ((e.key === 'b' || e.key === 'B') && !dialogOpen) {
        e.preventDefault()
        keys.current.toggleSide()
      } else if (e.key === ',' && !dialogOpen) {
        e.preventDefault()
        keys.current.openSettings()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [ws])

  const dropOn = (e: DragEvent, target: string) => {
    e.preventDefault()
    if (!drag || drag === target) return
    const from = ws.tabs.findIndex((x) => x.id === drag)
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const after = e.clientX > r.left + r.width / 2
    const list = ws.tabs.filter((x) => x.id !== drag)
    const at = list.findIndex((x) => x.id === target) + (after ? 1 : 0)
    list.splice(at, 0, ws.tabs[from])
    ws.reorder(list.map((x) => x.id))
    setDrag(null)
  }

  const showWelcome = ws.tabs.length === 0 || !ws.tabs.some((x) => x.id === ws.active)

  return (
    <div className="app">
      <TitleBar actions={actions} />
      <div className="body" ref={body}>
        {!sideHidden && (
          <>
            <aside className="side" style={{ width: sideW }}>
              <div className="panel-tabs" role="tablist">
                <button className={`panel-tab ${ws.panel === 'nav' ? 'on' : ''}`} role="tab" aria-selected={ws.panel === 'nav'} onClick={() => ws.setPanel('nav')}>
                  <Database />{t('탐색기')}
                </button>
                <button className={`panel-tab ${ws.panel === 'scripts' ? 'on' : ''}`} role="tab" aria-selected={ws.panel === 'scripts'} onClick={() => ws.setPanel('scripts')}>
                  <FileCode2 />{t('스크립트')}
                </button>
                <button className={`panel-tab ${ws.panel === 'history' ? 'on' : ''}`} role="tab" aria-selected={ws.panel === 'history'} onClick={() => ws.setPanel('history')}>
                  <History />{t('실행 기록')}
                </button>
                <span className="spacer" />
                <button className="icon-btn small" title={t('옆 칸 숨기기 (Ctrl+B)')} onClick={toggleSide}><PanelLeftClose /></button>
              </div>
              {ws.panel === 'nav' ? <Navigator /> : ws.panel === 'scripts' ? <ScriptsPanel onOpenFile={actions.openFile} onNewEditor={actions.newEditor} /> : <HistoryPanel />}
            </aside>
            <Splitter dir="col" onReset={resetSideW} onDrag={(x) => {
              const left = body.current?.getBoundingClientRect().left ?? 0
              setSideW(clamp(x - left, 220, 640))
            }} />
          </>
        )}
        <main className="main">
          <div className="tabbar" role="tablist">
            {sideHidden && <button className="tab-side" title={t('옆 칸 보이기 (Ctrl+B)')} onClick={toggleSide}><PanelLeftOpen /></button>}
            {ws.tabs.map((tab) => {
              const c = ws.conn(tab.connId)
              const Icon = tab.kind === 'editor' ? SquareTerminal : tab.objKind === 'view' ? Eye : Table2
              const on = ws.active === tab.id
              // 연결 색, 없고 운영 DB면 빨강
              const tint = c?.color || (c?.production ? '#e5484d' : '')
              return (
                <div
                  key={tab.id}
                  className={`tab ${tab.kind} ${on ? 'on' : ''} ${drag === tab.id ? 'dragging' : ''} ${tint ? 'tinted' : ''} ${c?.production ? 'prod' : ''}`}
                  role="tab"
                  aria-selected={on}
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
                  style={tint ? { ['--tint' as string]: tint } : undefined}
                >
                  <Icon />
                  <span className="ellipsis">{tabTitle(tab)}</span>
                  {tab.kind === 'editor' && tab.modified && <span className="tab-mod" title={t('파일에 저장하지 않은 고침')}>●</span>}
                  {c && <span className="tab-conn ellipsis">{c.name}</span>}
                  <button className="tab-close" onMouseDown={(e) => e.stopPropagation()} onClick={() => void ws.closeTab(tab.id)} aria-label={t('닫기')}><X /></button>
                </div>
              )
            })}
            <button className="tab-new" title={t('새 SQL 편집기 (Ctrl+])')} onClick={() => void newEditor()}><Plus /></button>
          </div>
          <div className="tab-content">
            {showWelcome ? <Welcome actions={actions} /> : null}
            {ws.tabs.map((tab) => (
              <div key={tab.id} className="tab-pane" style={{ display: ws.active === tab.id ? 'flex' : 'none' }}>
                {tab.kind === 'editor' ? <EditorTabView tab={tab} /> : <TableTabView tab={tab} active={ws.active === tab.id} />}
              </div>
            ))}
          </div>
        </main>
      </div>
      <StatusBar />
    </div>
  )
}
