// DuckDB 엔진 받기: DuckDB는 네이티브 파일이 커서 설치 파일에 넣지 않고, 처음 쓸 때 한 번 받는다 (사용자 결정).
// 받는 곳(npm 레지스트리)·크기를 보여 주고, 받는 동안 진행 막대. 대화 상자라 useWs 금지
import { useEffect, useState } from 'react'
import { CircleCheck, HardDriveDownload } from 'lucide-react'
import type { EngineStatus } from '../../../shared/types'
import { api, errorText } from '../api'
import { Dialog } from '../components/Dialog'
import type { Ui } from '../ui'
import { t } from '../i18n'

const mb = (n: number) => (n / 1_000_000).toFixed(1)

export function EngineDialog({ onDone }: { onDone: (ok: boolean) => void }) {
  const [st, setSt] = useState<EngineStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const tick = () => void api.engineStatus().then((s) => alive && setSt(s)).catch(() => undefined)
    tick()
    // 받는 동안만 자주 물어본다
    const timer = window.setInterval(tick, busy ? 250 : 2000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [busy])

  const install = async () => {
    setBusy(true)
    setError('')
    try {
      await api.installEngine()
      onDone(true)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
      // 대화 상자는 닫지 않고 오류를 보여 준다
      throw e
    }
  }

  const p = st?.progress
  const pct = p && p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
  return (
    <Dialog title={t('DuckDB 엔진 받기')} icon={HardDriveDownload} width={500} submitLabel={st?.installed ? t('확인') : t('내려받기')} onClose={() => onDone(!!st?.installed)} onSubmit={st?.installed ? () => onDone(true) : install}>
      <div className="engine-box">
        {st?.installed ? (
          <p className="with-icon"><CircleCheck className="ok-icon" />{t('DuckDB 엔진 {version}이(가) 준비돼 있어요.', { version: st.version })}</p>
        ) : (
          <>
            <p>{t('DuckDB를 쓰려면 엔진(약 {size}MB)을 한 번 내려받아야 해요. 설치 파일을 작게 하려고 따로 받아요.', { size: mb(st?.size ?? 20_726_172) })}</p>
            <p className="muted small">{t('받는 곳: npm 레지스트리(registry.npmjs.org)의 DuckDB 공식 꾸러미 {version}. 받은 뒤 지문(sha512)을 맞춰 보고 앱 데이터 폴더에 둬요.', { version: st?.version ?? '' })}</p>
          </>
        )}
        {busy && (
          <div className="engine-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="engine-progress-bar" style={{ width: `${pct}%` }} />
            <span className="small muted">{p ? t('{done} / {total}MB', { done: mb(p.done), total: mb(p.total) }) : t('준비하는 중…')}</span>
          </div>
        )}
        {error && <p className="err small">{error}</p>}
      </div>
    </Dialog>
  )
}

/** DuckDB 접속 전에: 엔진이 없으면 받기 창을 띄우고, 받았으면 true */
export async function ensureDuckdbEngine(ui: Ui): Promise<boolean> {
  const st = await api.engineStatus()
  if (st.installed) return true
  return new Promise((resolve) => {
    ui.open((close) => <EngineDialog onDone={(ok) => { close(); resolve(ok) }} />)
  })
}
