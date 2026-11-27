// 작업 공간 상태: 접속 목록·연결 상태·열린 탭(편집기·표). 탭과 편집기 글은 localStorage에 기억(다시 켜도 그대로)
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AppSettings, ConnectionInfo, DriverKind, ObjectKind, SecretsInput, SqlFile, TableRef } from '../../shared/types'
import { api, DEFAULT_SETTINGS, errorText, useConnections, useSettings } from './api'
import { useUi } from './ui'
import { t } from './i18n'
import { randomKey } from './format'
import { PasswordDialog } from './dialogs/PasswordDialog'
import { ConnectionDialog } from './dialogs/ConnectionDialog'

export type TableSub = 'data' | 'columns' | 'indexes' | 'ddl' | 'design'
/** manual: 수동 커밋 (없으면 접속이 운영 DB일 때 켜짐). file: 연결된 .sql 파일, modified: 파일에 저장하지 않은 고침 */
export type EditorTab = { kind: 'editor'; id: string; connId: string; db: string; schema: string; title: string; manual?: boolean; file?: string; modified?: boolean }
/** filter·filterSeq: 외래 키 따라가기로 열 때 처음 조건 (seq가 바뀌면 다시 건다). newTable: 아직 만들지 않은 새 표(설계만) */
export type TableTab = { kind: 'table'; id: string; connId: string; ref: TableRef; objKind: ObjectKind; sub: TableSub; filter?: string; filterSeq?: number; newTable?: boolean }
/** ER 다이어그램 (focus: 그 표와 바로 이어진 표만) */
export type ErTab = { kind: 'er'; id: string; connId: string; db: string; schema: string; focus?: string }
export type Tab = EditorTab | TableTab | ErTab
export type Panel = 'nav' | 'history' | 'scripts'

interface Ws {
  connections: ConnectionInfo[]
  conn(id: string): ConnectionInfo | undefined
  connected: Set<string>
  connecting: Set<string>
  ensureConnected(id: string): Promise<boolean>
  disconnect(id: string): Promise<void>
  tabs: Tab[]
  active: string | null
  setActive(id: string): void
  closeTab(id: string): Promise<void>
  closeOthers(id: string): void
  openEditor(connId: string, o?: { db?: string; schema?: string; text?: string; file?: string; title?: string }): void
  /** .sql 파일을 편집기로 (이미 열려 있으면 그 탭) — 마지막으로 쓴 접속으로 */
  openScript(f: SqlFile): void
  openTable(connId: string, ref: TableRef, kind: ObjectKind, sub?: TableSub, filter?: string): void
  /** ER 다이어그램 탭 (같은 DB·스키마면 그 탭으로) */
  openEr(connId: string, db: string, schema: string, focus?: string): void
  /** 새 표 설계 탭 */
  openNewTable(connId: string, db: string, schema: string): void
  updateTab(id: string, patch: Partial<EditorTab> | Partial<TableTab> | Partial<ErTab>): void
  /** 탭 순서 바꾸기 (끌어 놓기) */
  reorder(ids: string[]): void
  editConnection(info?: ConnectionInfo, driver?: DriverKind): void
  settings: AppSettings
  panel: Panel
  setPanel(p: Panel): void
  /** 마지막으로 쓴 접속 (새 편집기 기본값) */
  lastConnId: string | null
}

const WsContext = createContext<Ws | null>(null)

export function useWs(): Ws {
  const ws = useContext(WsContext)
  if (!ws) throw new Error('WsProvider')
  return ws
}

const TABS_KEY = 'dboard.tabs'

/** 저장하지 않은 변경이 있는 탭 (닫을 때 묻기) */
const dirtyTabs = new Set<string>()
export function setDirty(id: string, dirty: boolean) {
  if (dirty) dirtyTabs.add(id)
  else dirtyTabs.delete(id)
}
const textKey = (id: string) => 'dboard.editor.' + id

function loadTabs(): { tabs: Tab[]; active: string | null; seq: number } {
  try {
    const v = JSON.parse(localStorage.getItem(TABS_KEY) ?? '') as { tabs: Tab[]; active: string | null; seq: number }
    if (Array.isArray(v.tabs)) return { tabs: v.tabs.filter((x) => x && (x.kind === 'editor' || x.kind === 'table' || x.kind === 'er')), active: v.active ?? null, seq: v.seq ?? 0 }
  } catch {
    // 처음
  }
  return { tabs: [], active: null, seq: 0 }
}

export function loadText(id: string): string {
  try {
    return localStorage.getItem(textKey(id)) ?? ''
  } catch {
    return ''
  }
}

const textTimers = new Map<string, number>()
/** 편집기 글 기억 (입력할 때마다가 아니라 잠깐 멈추면) */
export function saveText(id: string, text: string) {
  window.clearTimeout(textTimers.get(id))
  textTimers.set(id, window.setTimeout(() => {
    try {
      localStorage.setItem(textKey(id), text)
    } catch {
      // 너무 크면 기억 못 함
    }
  }, 400))
}

/** 새 편집기의 처음 DB·스키마 */
export function defaultContext(c: ConnectionInfo): { db: string; schema: string } {
  const db = c.database || ({ sqlite: 'main', postgres: 'postgres', mssql: 'master', mysql: '', mariadb: '' } as const)[c.driver]
  const schema = c.driver === 'postgres' ? 'public' : c.driver === 'mssql' ? 'dbo' : ''
  return { db, schema }
}

export function WsProvider({ children }: { children: ReactNode }) {
  const ui = useUi()
  const qc = useQueryClient()
  const connections = useConnections().data ?? []
  const settings = useSettings().data ?? DEFAULT_SETTINGS
  const [connected, setConnected] = useState<Set<string>>(new Set())
  const [connecting, setConnecting] = useState<Set<string>>(new Set())
  const initial = useRef(loadTabs())
  const [tabs, setTabs] = useState<Tab[]>(initial.current.tabs)
  const [active, setActiveState] = useState<string | null>(initial.current.active)
  const seq = useRef(initial.current.seq)
  const [panel, setPanel] = useState<Panel>('nav')
  const [lastConnId, setLastConnId] = useState<string | null>(null)
  const pendingConnect = useRef(new Map<string, Promise<boolean>>())

  // 메인이 이미 연결해 둔 것 (화면만 새로 고친 경우)
  useEffect(() => {
    void api.connectedIds().then((ids) => setConnected(new Set(ids)))
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active, seq: seq.current }))
    } catch {
      // 기억 못 해도 지금은 그대로
    }
  }, [tabs, active])

  // 지운 접속의 탭은 닫는다
  useEffect(() => {
    if (!connections.length && !qc.getQueryData(['connections'])) return
    const ids = new Set(connections.map((c) => c.id))
    setTabs((list) => (list.some((x) => !ids.has(x.connId)) ? list.filter((x) => ids.has(x.connId)) : list))
  }, [connections, qc])

  const conn = useCallback((id: string) => connections.find((c) => c.id === id), [connections])

  const ensureConnected = useCallback((id: string): Promise<boolean> => {
    if (connected.has(id)) return Promise.resolve(true)
    const running = pendingConnect.current.get(id)
    if (running) return running
    const p = (async () => {
      setConnecting((s) => new Set(s).add(id))
      try {
        let prompt: SecretsInput | null = null
        for (;;) {
          const r = await api.connect(id, prompt)
          if (r.ok) {
            setConnected((s) => new Set(s).add(id))
            setLastConnId(id)
            if (r.newHostKey) ui.notify(t('SSH 서버의 호스트 키를 기억했어요: {key}', { key: r.newHostKey }), 'info')
            return true
          }
          const info = connections.find((c) => c.id === id)
          const answer = await new Promise<SecretsInput | null>((resolve) => {
            ui.open((close) => <PasswordDialog name={info?.name ?? ''} need={r.need} onClose={() => { resolve(null); close() }} onSubmit={(v) => { resolve(v); close() }} />)
          })
          if (!answer) return false
          prompt = { ...(prompt ?? {}), ...answer }
        }
      } catch (e) {
        ui.notify(errorText(e), 'error')
        return false
      } finally {
        pendingConnect.current.delete(id)
        setConnecting((s) => {
          const n = new Set(s)
          n.delete(id)
          return n
        })
      }
    })()
    pendingConnect.current.set(id, p)
    return p
  }, [connected, connections, ui])

  const disconnect = useCallback(async (id: string) => {
    try {
      await api.disconnect(id)
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
    setConnected((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
    qc.removeQueries({ predicate: (q) => q.queryKey[1] === id && q.queryKey[0] !== 'connections' })
  }, [qc, ui])

  const setActive = useCallback((id: string) => {
    setActiveState(id)
    const tab = tabs.find((x) => x.id === id)
    if (tab) setLastConnId(tab.connId)
  }, [tabs])

  const closeTab = useCallback(async (id: string) => {
    const i = tabs.findIndex((x) => x.id === id)
    if (i < 0) return
    const tab = tabs[i]
    if (dirtyTabs.has(id)) {
      const ok = await ui.confirm({ title: t('저장하지 않은 변경'), message: t('이 탭에 저장하지 않은 변경이 있어요. 버리고 닫을까요?'), confirm: t('버리고 닫기'), danger: true })
      if (!ok) return
      dirtyTabs.delete(id)
    }
    if (tab.kind === 'editor') {
      void api.closeSession(id).catch(() => undefined)
      try {
        localStorage.removeItem(textKey(id))
      } catch {
        // 무시
      }
    }
    const next = tabs.filter((x) => x.id !== id)
    setTabs(next)
    if (active === id) setActiveState(next[Math.min(i, next.length - 1)]?.id ?? null)
  }, [tabs, active, ui])

  const closeOthers = useCallback((id: string) => {
    for (const x of tabs) if (x.id !== id && x.kind === 'editor') void api.closeSession(x.id).catch(() => undefined)
    setTabs(tabs.filter((x) => x.id === id))
    setActiveState(id)
  }, [tabs])

  const openEditor = useCallback((connId: string, o: { db?: string; schema?: string; text?: string; file?: string; title?: string } = {}) => {
    const c = connections.find((x) => x.id === connId)
    if (!c) return
    const def = defaultContext(c)
    const id = 'ed-' + randomKey()
    if (!o.title) seq.current += 1
    const tab: EditorTab = { kind: 'editor', id, connId, db: o.db ?? def.db, schema: o.schema ?? def.schema, title: o.title ?? t('SQL {n}', { n: seq.current }), ...(o.file ? { file: o.file } : {}) }
    if (o.text) {
      try {
        localStorage.setItem(textKey(id), o.text)
      } catch {
        // 무시
      }
    }
    setTabs((list) => [...list, tab])
    setActiveState(id)
    setLastConnId(connId)
  }, [connections])

  const openScript = useCallback((f: SqlFile) => {
    const found = tabs.find((x) => x.kind === 'editor' && !!x.file && x.file.toLowerCase() === f.path.toLowerCase())
    if (found) {
      setActiveState(found.id)
      return
    }
    const cur = tabs.find((x) => x.id === active)
    const connId = cur?.connId ?? lastConnId ?? connections[0]?.id
    if (!connId) {
      ui.notify(t('먼저 접속 정보를 만들어 주세요'), 'warn')
      return
    }
    openEditor(connId, { text: f.text, file: f.path, title: f.name })
  }, [tabs, active, lastConnId, connections, openEditor, ui])

  const openTable = useCallback((connId: string, ref: TableRef, kind: ObjectKind, sub: TableSub = 'data', filter?: string) => {
    const found = tabs.find((x) => x.kind === 'table' && !x.newTable && x.connId === connId && x.ref.db === ref.db && x.ref.schema === ref.schema && x.ref.table === ref.table)
    const f = filter === undefined ? {} : { filter, filterSeq: Date.now() }
    if (found) {
      setTabs((list) => list.map((x) => (x.id === found.id ? ({ ...x, sub, ...f } as Tab) : x)))
      setActiveState(found.id)
    } else {
      const id = 'tb-' + randomKey()
      setTabs((list) => [...list, { kind: 'table', id, connId, ref, objKind: kind, sub, ...f }])
      setActiveState(id)
    }
    setLastConnId(connId)
  }, [tabs])

  const openNewTable = useCallback((connId: string, db: string, schema: string) => {
    const id = 'tb-' + randomKey()
    setTabs((list) => [...list, { kind: 'table', id, connId, ref: { db, schema, table: '' }, objKind: 'table', sub: 'design', newTable: true }])
    setActiveState(id)
    setLastConnId(connId)
  }, [])

  const openEr = useCallback((connId: string, db: string, schema: string, focus?: string) => {
    const found = tabs.find((x) => x.kind === 'er' && x.connId === connId && x.db === db && x.schema === schema)
    if (found) {
      setTabs((list) => list.map((x) => (x.id === found.id ? ({ ...x, focus } as Tab) : x)))
      setActiveState(found.id)
    } else {
      const id = 'er-' + randomKey()
      setTabs((list) => [...list, { kind: 'er', id, connId, db, schema, ...(focus ? { focus } : {}) }])
      setActiveState(id)
    }
    setLastConnId(connId)
  }, [tabs])

  const updateTab = useCallback((id: string, patch: Partial<EditorTab> | Partial<TableTab> | Partial<ErTab>) => {
    setTabs((list) => list.map((x) => (x.id === id ? ({ ...x, ...patch } as Tab) : x)))
  }, [])

  const reorder = useCallback((ids: string[]) => {
    setTabs((list) => ids.map((id) => list.find((x) => x.id === id)).filter((x): x is Tab => !!x))
  }, [])

  const editConnection = useCallback((info?: ConnectionInfo, driver?: DriverKind) => {
    ui.open((close) => (
      <ConnectionDialog
        initial={info}
        driver={driver}
        onClose={close}
        onSaved={(saved) => {
          void qc.invalidateQueries({ queryKey: ['connections'] })
          // 고친 접속은 메인이 연결을 끊었다
          if (info) {
            setConnected((s) => {
              const n = new Set(s)
              n.delete(saved.id)
              return n
            })
            qc.removeQueries({ predicate: (q) => q.queryKey[1] === saved.id && q.queryKey[0] !== 'connections' })
          }
          close()
        }}
      />
    ))
  }, [qc, ui])

  const ws = useMemo<Ws>(() => ({
    connections, conn, connected, connecting, ensureConnected, disconnect, tabs, active, setActive, closeTab, closeOthers,
    openEditor, openScript, openTable, openNewTable, openEr, updateTab, reorder, editConnection, settings, panel, setPanel, lastConnId,
  }), [connections, conn, connected, connecting, ensureConnected, disconnect, tabs, active, setActive, closeTab, closeOthers, openEditor, openScript, openTable, openNewTable, openEr, updateTab, reorder, editConnection, settings, panel, lastConnId])

  return <WsContext.Provider value={ws}>{children}</WsContext.Provider>
}
