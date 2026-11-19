// 실행 기록: 찾기, 누르면 지금 편집기에 넣기(같은 접속이 없으면 새 편집기), 복사
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, ClipboardCopy, Search, SquareTerminal, Trash2, X } from 'lucide-react'
import type { HistoryEntry } from '../../../shared/types'
import { api } from '../api'
import { useWs } from '../ws'
import { useUi } from '../ui'
import { t } from '../i18n'
import { fmtNum, formatMs } from '../format'
import { insertIntoEditor } from '../editors'

function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 60) return t('방금')
  if (s < 3600) return t('{n}분 전', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n}시간 전', { n: Math.floor(s / 3600) })
  return new Date(at).toLocaleDateString()
}

export function HistoryPanel() {
  const ws = useWs()
  const ui = useUi()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const list = useQuery({ queryKey: ['history', search], queryFn: () => api.history(search, 300), staleTime: 0, refetchInterval: 3000 })

  const open = (h: HistoryEntry, fresh: boolean) => {
    const cur = ws.tabs.find((x) => x.id === ws.active)
    if (!fresh && cur?.kind === 'editor' && cur.connId === h.connId && insertIntoEditor(cur.id, h.sql)) return
    if (!ws.conn(h.connId)) {
      ui.notify(t('이 기록의 접속 정보가 없어요'), 'warn')
      return
    }
    ws.openEditor(h.connId, { db: h.db, text: h.sql })
  }

  const clear = async () => {
    const ok = await ui.confirm({ title: t('실행 기록 지우기'), message: t('실행 기록을 모두 지울까요?'), confirm: t('지우기'), danger: true })
    if (!ok) return
    await api.clearHistory()
    void qc.invalidateQueries({ queryKey: ['history'] })
  }

  return (
    <div className="history-panel">
      <div className="side-head">
        <h2>{t('실행 기록')}</h2>
        <span className="spacer" />
        <button className="icon-btn" title={t('모두 지우기')} onClick={() => void clear()}><Trash2 /></button>
      </div>
      <div className="side-search">
        <Search />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('SQL·접속 이름 찾기')} spellCheck={false} />
        {search && <button className="icon-btn small" onClick={() => setSearch('')} aria-label={t('지우기')}><X /></button>}
      </div>
      <div className="history-list">
        {list.data?.length === 0 && <p className="pad muted small">{t('아직 실행한 SQL이 없어요.')}</p>}
        {list.data?.map((h) => (
          <div key={h.id} className={`hist-item ${h.error ? 'fail' : ''}`} title={h.error ?? h.sql} onClick={() => open(h, false)}
            onContextMenu={(e) => ui.menu(e, [
              { label: t('지금 편집기에 넣기'), icon: SquareTerminal, onClick: () => open(h, false) },
              { label: t('새 편집기에서 열기'), icon: SquareTerminal, onClick: () => open(h, true) },
              { label: t('SQL 복사'), icon: ClipboardCopy, onClick: () => void api.copyText(h.sql) },
            ])}>
            <code className="hist-sql">{h.sql.trim().slice(0, 400)}</code>
            <span className="hist-meta">
              {h.error && <CircleAlert className="err-icon" />}
              <span className="ellipsis">{h.connName}{h.db ? ' · ' + h.db : ''}</span>
              <span className="spacer" />
              <span>{h.error ? t('오류') : h.rows !== null ? t('{n}행', { n: fmtNum(h.rows) }) : ''}</span>
              <span>{formatMs(h.ms)}</span>
              <span>{ago(h.at)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
