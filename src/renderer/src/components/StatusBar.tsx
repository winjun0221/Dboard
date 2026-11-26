// 상태 줄: 왼쪽 = 지금 탭의 위치(접속 › DB › 스키마 › 표), 오른쪽 = 그 접속의 연결 상태 · 열린 연결 수 · 버전
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Database, Eye, FolderTree, Lock, ShieldAlert, SquareTerminal, Table2 } from 'lucide-react'
import { api } from '../api'
import { useWs } from '../ws'
import { t } from '../i18n'
import { DriverBadge } from './DriverBadge'

export function StatusBar() {
  const ws = useWs()
  const info = useQuery({ queryKey: ['app-info'], queryFn: () => api.appInfo() })
  const tab = ws.tabs.find((x) => x.id === ws.active)
  const conn = tab ? ws.conn(tab.connId) : undefined
  const isOn = !!tab && ws.connected.has(tab.connId)
  const connecting = !!tab && ws.connecting.has(tab.connId)

  const crumbs: { icon: typeof Database; text: string }[] = []
  if (tab && conn) {
    const db = tab.kind === 'editor' ? tab.db : tab.ref.db
    const schema = tab.kind === 'editor' ? tab.schema : tab.ref.schema
    if (db && conn.driver !== 'sqlite') crumbs.push({ icon: Database, text: db })
    if (schema) crumbs.push({ icon: FolderTree, text: schema })
    if (tab.kind === 'table') crumbs.push({ icon: tab.objKind === 'view' ? Eye : Table2, text: tab.ref.table })
    else crumbs.push({ icon: SquareTerminal, text: tab.title })
  }

  return (
    <footer className="statusbar">
      <div className="crumbs">
        {tab && conn ? (
          <>
            <span className="crumb"><DriverBadge driver={conn.driver} size={12} />{conn.name}</span>
            {crumbs.map((c, i) => (
              <span key={i} className="crumb">
                <ChevronRight className="crumb-sep" />
                <c.icon />{c.text}
              </span>
            ))}
          </>
        ) : (
          <span className="crumb muted">{t('열린 탭이 없어요')}</span>
        )}
      </div>
      <span className="spacer" />
      {conn?.production === true && <span className="status-item status-prod"><ShieldAlert />{t('운영 DB')}</span>}
      {conn?.readOnly === true && <span className="status-item"><Lock />{t('읽기 전용')}</span>}
      {tab && conn && (
        <span className={`status-item conn-state ${isOn ? 'on' : connecting ? 'busy' : ''}`}>
          <span className="state-dot" />
          {isOn ? t('연결됨') : connecting ? t('연결 중…') : t('연결 안 됨')}
        </span>
      )}
      <span className="status-item">{t('열린 연결 {n}개', { n: ws.connected.size })}</span>
      {info.data && <span className="status-item muted">DBoard {info.data.version}</span>}
    </footer>
  )
}
