// 세션 관리자: 서버에 붙은 연결 목록(사용자·DB·상태·걸린 시간·쿼리), 쿼리 취소·연결 끊기. 대화 상자라 useWs 금지: 접속은 props로
import { features } from '../../../shared/features'
import { dialectOf } from '../../../shared/types'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, CircleSlash, LoaderCircle, Plug, RefreshCw, Search, Unplug, X } from 'lucide-react'
import type { ConnectionInfo, ServerSession } from '../../../shared/types'
import { api, errorText } from '../api'
import { useUi } from '../ui'
import { t } from '../i18n'
import { Check, Dialog } from '../components/Dialog'

function duration(s: number | null): string {
  if (s === null || s < 0) return ''
  if (s < 60) return t('{n}초', { n: s })
  if (s < 3600) return t('{m}분 {s}초', { m: Math.floor(s / 60), s: s % 60 })
  return t('{h}시간 {m}분', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) })
}

const busy = (x: ServerSession) => /^(active|running|runnable|suspended|query|execute)/i.test(x.state)

export function SessionsDialog({ conn, onClose }: { conn: ConnectionInfo; onClose: () => void }) {
  const ui = useUi()
  const [auto, setAuto] = useState(true)
  const [activeOnly, setActiveOnly] = useState(false)
  const [filter, setFilter] = useState('')
  const q = useQuery({ queryKey: ['sessions', conn.id], queryFn: () => api.serverSessions(conn.id), refetchInterval: auto ? 3000 : false, staleTime: 0 })
  const canCancelQuery = features(dialectOf(conn.driver)).cancelQuery

  const kill = async (x: ServerSession, queryOnly: boolean) => {
    const ok = await ui.confirm({
      title: queryOnly ? t('쿼리 취소') : t('세션 끊기'),
      message: queryOnly
        ? t('세션 {id}({user})에서 실행 중인 쿼리를 취소할까요?', { id: x.id, user: x.user })
        : t('세션 {id}({user})의 연결을 끊을까요? 그 세션의 커밋하지 않은 작업은 되돌려져요.', { id: x.id, user: x.user }),
      confirm: queryOnly ? t('쿼리 취소') : t('끊기'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.killSession(conn.id, x.id, queryOnly)
      ui.notify(queryOnly ? t('쿼리를 취소했어요: {id}', { id: x.id }) : t('세션을 끊었어요: {id}', { id: x.id }), 'success')
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
    void q.refetch()
  }

  const needle = filter.trim().toLowerCase()
  const list = (q.data ?? []).filter((x) => (!activeOnly || busy(x)) && (!needle || [x.id, x.user, x.db, x.host, x.app, x.state, x.query].some((v) => v.toLowerCase().includes(needle))))

  return (
    <Dialog title={t('세션 관리자 — {name}', { name: conn.name })} icon={Activity} width={1100} onClose={onClose} className="sessions-dialog">
      <div className="toolbar sessions-bar">
        <button type="button" className="tbtn" onClick={() => void q.refetch()}>{q.isFetching ? <LoaderCircle className="spin" /> : <RefreshCw />}{t('새로고침')}</button>
        <Check checked={auto} onChange={setAuto}>{t('3초마다 새로고침')}</Check>
        <Check checked={activeOnly} onChange={setActiveOnly}>{t('실행 중인 것만')}</Check>
        <span className="spacer" />
        <label className="filter-box small">
          <Search />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('사용자·DB·쿼리 찾기')} spellCheck={false} />
          {filter && <button type="button" className="icon-btn small" onClick={() => setFilter('')} aria-label={t('지우기')}><X /></button>}
        </label>
        <span className="muted small">{t('{n}개', { n: list.length })}</span>
      </div>
      {q.error && <div className="banner error inline">{errorText(q.error)}</div>}
      <div className="sessions-list">
        <table className="info-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>{t('사용자')}</th>
              <th>DB</th>
              <th>{t('접속한 곳')}</th>
              <th>{t('프로그램')}</th>
              <th>{t('상태')}</th>
              <th>{t('시간')}</th>
              <th>{t('쿼리')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.id} className={`${busy(x) ? 'busy' : ''} ${x.own ? 'own' : ''}`}>
                <td className="mono">{x.id}{x.own && <span className="tag" title={t('이 목록을 읽은 연결')}>{t('이 연결')}</span>}</td>
                <td>{x.user}</td>
                <td>{x.db}</td>
                <td className="muted">{x.host}</td>
                <td className="muted">{x.app}</td>
                <td>{x.state}</td>
                <td className="mono nowrap">{duration(x.seconds)}</td>
                <td className="mono query-cell" title={x.query}>{x.query}</td>
                <td className="nowrap">
                  {canCancelQuery && <button type="button" className="icon-btn small" title={t('쿼리 취소')} aria-label={t('쿼리 취소')} disabled={x.own || !busy(x)} onClick={() => void kill(x, true)}><CircleSlash /></button>}
                  <button type="button" className="icon-btn small danger" title={t('세션 끊기')} aria-label={t('세션 끊기')} disabled={x.own} onClick={() => void kill(x, false)}><Unplug /></button>
                </td>
              </tr>
            ))}
            {q.data && list.length === 0 && <tr><td colSpan={9} className="muted"><Plug className="small-icon" /> {t('보여 줄 세션이 없어요')}</td></tr>}
          </tbody>
        </table>
      </div>
    </Dialog>
  )
}
