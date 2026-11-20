// 탭이 없을 때: 가운데에 할 수 있는 일(단축키와 함께)과 접속 목록(누르면 연결 + SQL 편집기)
import { useQuery } from '@tanstack/react-query'
import { History, Keyboard, Plus, Settings, SquareTerminal } from 'lucide-react'
import { DRIVER_KINDS } from '../../../shared/types'
import { api } from '../api'
import { useWs } from '../ws'
import { useUi } from '../ui'
import { t } from '../i18n'
import { DRIVER_LABEL, connSummary } from '../format'
import { DriverBadge } from '../components/DriverBadge'
import { ShortcutsDialog } from '../dialogs/ShortcutsDialog'
import type { ShellActions } from '../App'

export function Welcome({ actions }: { actions: ShellActions }) {
  const ws = useWs()
  const ui = useUi()
  const info = useQuery({ queryKey: ['app-info'], queryFn: () => api.appInfo() })
  const open = async (id: string) => {
    if (await ws.ensureConnected(id)) ws.openEditor(id)
  }
  const starts = [
    { key: 'new-conn', icon: Plus, label: t('새 연결'), hint: '', onClick: () => ws.editConnection() },
    { key: 'new-sql', icon: SquareTerminal, label: t('새 SQL 편집기'), hint: 'Ctrl+]', onClick: actions.newEditor },
    { key: 'history', icon: History, label: t('실행 기록'), hint: '', onClick: () => { ws.setPanel('history'); if (actions.sideHidden) actions.toggleSide() } },
    { key: 'keys', icon: Keyboard, label: t('단축키'), hint: '', onClick: () => ui.open((close) => <ShortcutsDialog onClose={close} />) },
    { key: 'settings', icon: Settings, label: t('설정'), hint: 'Ctrl+,', onClick: () => actions.openSettings() },
  ]
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-hero">
          <img src="./icon.png" alt="" width={44} height={44} />
          <div>
            <h1>DBoard</h1>
            <p className="muted">{t('SQLite · MySQL · MariaDB · PostgreSQL · SQL Server를 한 곳에서')}{info.data && <span className="ver"> · {info.data.version}</span>}</p>
          </div>
        </div>

        <div className="welcome-cols">
          <section>
            <h3 className="section-title">{t('시작하기')}</h3>
            <div className="wl-list">
              {starts.map((s) => (
                <button key={s.key} className={`wl-item ${s.key}`} onClick={s.onClick}>
                  <s.icon />
                  <span className="wl-label">{s.label}</span>
                  {s.hint && <kbd>{s.hint}</kbd>}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="section-title">{t('연결')}</h3>
            {ws.connections.length === 0 ? (
              <>
                <p className="muted small wl-empty">{t('어떤 DB에 연결할까요?')}</p>
                <div className="wl-list">
                  {DRIVER_KINDS.map((d) => (
                    <button key={d} className="wl-item" onClick={() => ws.editConnection(undefined, d)}>
                      <DriverBadge driver={d} size={16} />
                      <span className="wl-label">{DRIVER_LABEL[d]}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="wl-list">
                {ws.connections.map((c) => {
                  const on = ws.connected.has(c.id)
                  return (
                    <button key={c.id} className="wl-item conn" onClick={() => void open(c.id)} title={t('연결해서 SQL 편집기 열기')}>
                      <DriverBadge driver={c.driver} size={16} />
                      {c.color && <span className="conn-color" style={{ background: c.color }} />}
                      <span className="wl-label ellipsis">{c.name}</span>
                      <span className="conn-host ellipsis">{connSummary(c)}</span>
                      <span className={`state-dot ${on ? 'on' : ''}`} title={on ? t('연결됨') : t('연결 안 됨')} />
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
