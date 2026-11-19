// 탭이 없을 때: 접속 카드(누르면 연결 + SQL 편집기), 새 연결, 단축키
import { Plug, Plus, SquareTerminal } from 'lucide-react'
import { DRIVER_KINDS } from '../../../shared/types'
import { useWs } from '../ws'
import { t } from '../i18n'
import { DRIVER_LABEL, connSummary } from '../format'
import { DriverBadge } from '../components/DriverBadge'

export function Welcome() {
  const ws = useWs()
  const open = async (id: string) => {
    if (await ws.ensureConnected(id)) ws.openEditor(id)
  }
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-hero">
          <img src="./icon.png" alt="" width={56} height={56} />
          <div>
            <h1>DBoard</h1>
            <p className="muted">{t('SQLite · MySQL · MariaDB · PostgreSQL · SQL Server를 한 곳에서')}</p>
          </div>
        </div>

        <h3 className="section-title">{t('연결')}</h3>
        <div className="card-grid">
          {ws.connections.map((c) => (
            <button key={c.id} className="conn-card" onClick={() => void open(c.id)} style={c.color ? { borderTopColor: c.color } : undefined}>
              <DriverBadge driver={c.driver} size={34} />
              <span className="conn-card-text">
                <b className="ellipsis">{c.name}</b>
                <span className="muted small ellipsis">{connSummary(c)}</span>
              </span>
              <span className={`state ${ws.connected.has(c.id) ? 'on' : ''}`}>{ws.connected.has(c.id) ? t('연결됨') : <Plug />}</span>
            </button>
          ))}
          <button className="conn-card add" onClick={() => ws.editConnection()}>
            <span className="add-icon"><Plus /></span>
            <span className="conn-card-text">
              <b>{t('새 연결')}</b>
              <span className="muted small">{t('접속 정보 만들기')}</span>
            </span>
          </button>
        </div>

        {ws.connections.length === 0 && (
          <>
            <h3 className="section-title">{t('어떤 DB에 연결할까요?')}</h3>
            <div className="driver-row">
              {DRIVER_KINDS.map((d) => (
                <button key={d} className="driver-pill" onClick={() => ws.editConnection(undefined, d)}><DriverBadge driver={d} size={22} />{DRIVER_LABEL[d]}</button>
              ))}
            </div>
          </>
        )}

        <h3 className="section-title">{t('단축키')}</h3>
        <div className="keys">
          <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd>{t('고른 부분·커서 문장 실행')}</span>
          <span><kbd>Alt</kbd>+<kbd>X</kbd>{t('스크립트 전체 실행')}</span>
          <span><kbd>Ctrl</kbd>+<kbd>Space</kbd>{t('자동 완성')}</span>
          <span><kbd>Ctrl</kbd>+<kbd>/</kbd>{t('주석 켜고 끄기')}</span>
          <span><kbd>Ctrl</kbd>+<kbd>]</kbd>{t('새 SQL 편집기')}</span>
          <span><kbd>Ctrl</kbd>+<kbd>S</kbd>{t('표 데이터 저장')}</span>
        </div>
        {ws.lastConnId && (
          <button className="btn" onClick={() => ws.lastConnId && ws.openEditor(ws.lastConnId)}><SquareTerminal />{t('새 SQL 편집기')}</button>
        )}
      </div>
    </div>
  )
}
