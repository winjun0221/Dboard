// 서버 상태: 2초마다 읽어 연결 수·실행 중·초당 쿼리·초당 트랜잭션·잠금 대기 등을 작은 그래프로. 대화 상자라 useWs 금지
import { useEffect, useRef, useState } from 'react'
import { Gauge, Pause, Play } from 'lucide-react'
import type { ConnectionInfo, ServerStats } from '../../../shared/types'
import { api, errorText } from '../api'
import { t, tk } from '../i18n'
import { Dialog } from '../components/Dialog'

const LABEL: Record<string, string> = {
  connections: tk('연결 수'), active: tk('실행 중'), lockWaits: tk('잠금 대기'), cacheHit: tk('캐시 적중률 (%)'),
  queries: tk('쿼리 / 초'), transactions: tk('트랜잭션 / 초'), rowsRead: tk('읽은 행 / 초'), rowsWritten: tk('바꾼 행 / 초'),
  bytesIn: tk('받은 바이트 / 초'), bytesOut: tk('보낸 바이트 / 초'), slowQueries: tk('느린 쿼리 / 초'), lockWaitEvents: tk('잠금 대기 / 초'),
}
const KEEP = 90

function uptime(s: string): string {
  const n = Number(s)
  if (!s || !Number.isFinite(n)) return '-'
  const d = Math.floor(n / 86400)
  const h = Math.floor((n % 86400) / 3600)
  const m = Math.floor((n % 3600) / 60)
  return d ? t('{d}일 {h}시간', { d, h }) : h ? t('{h}시간 {m}분', { h, m }) : t('{m}분', { m })
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className="spark" />
  const max = Math.max(1, ...values)
  const w = 220
  const h = 44
  const pts = values.map((v, i) => `${((i / (KEEP - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 6)).toFixed(1)}`).join(' ')
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" />
    </svg>
  )
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : (Math.round(v * 10) / 10).toLocaleString('en-US'))

export function StatsDialog({ conn, onClose }: { conn: ConnectionInfo; onClose: () => void }) {
  const [series, setSeries] = useState<Record<string, number[]>>({})
  const [info, setInfo] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const last = useRef<ServerStats | null>(null)

  useEffect(() => {
    if (paused) return
    let alive = true
    const tick = async () => {
      try {
        const s = await api.serverStats(conn.id)
        if (!alive) return
        const prev = last.current
        last.current = s
        setInfo(s.info)
        setError(null)
        setSeries((cur) => {
          const next = { ...cur }
          const push = (k: string, v: number) => {
            next[k] = [...(next[k] ?? []), Math.max(0, v)].slice(-KEEP)
          }
          for (const [k, v] of Object.entries(s.gauges)) push(k, v)
          // 쌓이는 값은 지난번과의 차이 ÷ 시간 = 초당
          if (prev) for (const [k, v] of Object.entries(s.counters)) push(k, (v - (prev.counters[k] ?? v)) / Math.max(0.5, (s.at - prev.at) / 1000))
          return next
        })
      } catch (e) {
        if (alive) setError(errorText(e))
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), 2000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [conn.id, paused])

  const keys = Object.keys(series).filter((k) => LABEL[k])
  return (
    <Dialog title={t('서버 상태 — {name}', { name: conn.name })} icon={Gauge} width={980} onClose={onClose}
      footer={<button type="button" className="btn" onClick={() => setPaused((p) => !p)}>{paused ? <Play /> : <Pause />}{paused ? t('다시 읽기') : t('멈추기')}</button>}>
      {error && <div className="banner error inline">{error}</div>}
      <div className="stats-info muted small">
        <span>{t('켜진 지 {time}', { time: uptime(info.uptime ?? '') })}</span>
        {info.dbSize && <span>{t('DB 크기 {size}', { size: info.dbSize })}</span>}
        <span>{t('2초마다 읽어요')}</span>
      </div>
      <div className="stats-grid">
        {keys.map((k) => {
          const v = series[k]
          return (
            <div key={k} className="stat-card">
              <div className="stat-label">{t(LABEL[k])}</div>
              <div className="stat-value">{v.length ? fmt(v[v.length - 1]) : '-'}</div>
              <Spark values={v} />
            </div>
          )
        })}
        {!keys.length && !error && <p className="pad muted">{t('읽는 중…')}</p>}
      </div>
    </Dialog>
  )
}
