// 데이터 옮기기: 원본 표들 → 대상 DB(다른 종류도). 없으면 표를 만들고, 같은 이름의 열만. 대화 상자라 useWs 금지
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, ArrowRightLeft, CircleCheck, CircleX, LoaderCircle, Square, TriangleAlert } from 'lucide-react'
import type { ConnectionInfo, TransferResult } from '../../../shared/types'
import { api, errorText } from '../api'
import { useUi } from '../ui'
import { t } from '../i18n'
import { fmtNum, formatMs, randomKey } from '../format'
import { Check, Dialog } from '../components/Dialog'
import { TargetPicker, type Target } from './TargetPicker'

export function TransferDialog({ conn, db, schema, only, connections, ensureConnected, onClose }: {
  conn: ConnectionInfo
  db: string
  schema: string
  /** 처음에 고를 표 (없으면 전부) */
  only?: string
  connections: ConnectionInfo[]
  ensureConnected: (id: string) => Promise<boolean>
  onClose: () => void
}) {
  const ui = useUi()
  const qc = useQueryClient()
  const objs = useQuery({ queryKey: ['objects', conn.id, db, schema], queryFn: () => api.objects(conn.id, db, schema) })
  const tables = useMemo(() => (objs.data ?? []).filter((x) => x.kind === 'table').map((x) => x.name), [objs.data])
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const sel = picked ?? new Set(only ? [only] : tables)
  const [target, setTarget] = useState<Target>({ connId: '', db: '', schema: '' })
  const [create, setCreate] = useState(true)
  const [truncate, setTruncate] = useState(false)
  const [stopOnError, setStopOnError] = useState(true)
  const [batch, setBatch] = useState(500)
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<TransferResult | null>(null)
  const dst = connections.find((c) => c.id === target.connId)
  const same = dst?.id === conn.id && target.db === db && target.schema === schema

  const toggle = (name: string, on: boolean) => {
    const n = new Set(sel)
    if (on) n.add(name)
    else n.delete(name)
    setPicked(n)
  }

  const start = async () => {
    if (!dst || sel.size === 0) return
    if (dst.production === true || truncate) {
      const ok = await ui.confirm({
        title: t('데이터 옮기기'),
        message: `${dst.production === true ? t('대상 "{name}"은(는) 운영 DB예요. ', { name: dst.name }) : ''}${truncate ? t('옮기기 전에 대상 표의 행을 모두 지워요. ') : ''}${t('계속할까요?')}`,
        confirm: t('옮기기'),
        danger: true,
      })
      if (!ok) return
    }
    const key = 'tr-' + randomKey()
    setRunning(key)
    setResult(null)
    try {
      if (!(await ensureConnected(conn.id)) || !(await ensureConnected(dst.id))) return
      const r = await api.transferData(conn.id, db, schema, dst.id, target.db, target.schema, tables.filter((x) => sel.has(x)), { create, truncate, batch, stopOnError }, key)
      setResult(r)
      const failed = r.tables.filter((x) => x.error).length
      ui.notify(failed ? t('{n}개 표에서 오류가 났어요', { n: failed }) : t('행 {n}개를 옮겼어요', { n: fmtNum(r.tables.reduce((a, x) => a + x.rows, 0)) }), failed ? 'warn' : 'success')
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === dst.id && q.queryKey[0] !== 'connections' })
    } catch (e) {
      ui.notify(errorText(e), 'error')
    } finally {
      setRunning(null)
    }
  }

  return (
    <Dialog title={t('데이터 옮기기')} icon={ArrowRightLeft} width={860} onClose={() => { if (!running) onClose() }}
      footer={
        <>
          {running && <button type="button" className="btn" onClick={() => void api.cancelSql(running)}><Square />{t('멈추기')}</button>}
          <span className="spacer" />
          <button type="button" className="btn primary" disabled={!!running || !dst || sel.size === 0 || same || dst.readOnly === true} onClick={() => void start()}>
            {running ? <LoaderCircle className="spin" /> : <ArrowRightLeft />}{t('옮기기 ({n}개 표)', { n: sel.size })}
          </button>
        </>
      }>
      <div className="compare-head">
        <div className="compare-side">
          <span className="muted small">{t('원본')}</span>
          <b>{conn.name}</b>
          <span className="muted">{[db, schema].filter(Boolean).join(' · ')}</span>
        </div>
        <ArrowRight className="compare-arrow" />
        <div className="compare-side grow">
          <span className="muted small">{t('대상')}</span>
          <TargetPicker connections={connections} value={target} onChange={setTarget} ensureConnected={ensureConnected} allow={(c) => (c.readOnly === true ? t('읽기 전용') : null)} />
        </div>
      </div>
      {same && <div className="banner warn inline"><TriangleAlert />{t('원본과 대상이 같아요')}</div>}
      <div className="transfer-body">
        <div className="transfer-tables">
          <div className="transfer-tools">
            <b>{t('옮길 표')}</b>
            <span className="spacer" />
            <button type="button" className="link-btn" onClick={() => setPicked(new Set(tables))}>{t('모두')}</button>
            <button type="button" className="link-btn" onClick={() => setPicked(new Set())}>{t('없음')}</button>
          </div>
          <div className="transfer-list">
            {objs.isPending && <LoaderCircle className="spin" />}
            {tables.map((n) => {
              const r = result?.tables.find((x) => x.name === n)
              return (
                <label key={n} className="transfer-row" title={r?.error ?? undefined}>
                  <input type="checkbox" checked={sel.has(n)} disabled={!!running} onChange={(e) => toggle(n, e.target.checked)} />
                  <span className="ellipsis">{n}</span>
                  {r && (r.error ? <span className="err"><CircleX />{r.error.split('\n')[0]}</span> : <span className="ok"><CircleCheck />{t('{n}행', { n: fmtNum(r.rows) })}{r.created ? ' · ' + t('표 만듦') : ''}</span>)}
                </label>
              )
            })}
          </div>
        </div>
        <div className="transfer-opts">
          <b>{t('설정')}</b>
          <Check checked={create} onChange={setCreate}>{t('대상에 표가 없으면 만들기 (타입을 대상 DB에 맞춤)')}</Check>
          <Check checked={truncate} onChange={setTruncate}>{t('옮기기 전에 대상 표 비우기')}</Check>
          <Check checked={stopOnError} onChange={setStopOnError}>{t('오류가 나면 멈추기 (끄면 다음 표로)')}</Check>
          <label className="field">
            <span className="field-label">{t('한 번에 넣을 행 수')}</span>
            <input type="number" min={1} max={5000} value={batch} onChange={(e) => setBatch(Math.max(1, Math.min(5000, Number(e.target.value) || 500)))} />
          </label>
          <p className="muted small">{t('같은 이름의 열만 옮겨요. 외래 키 부모 표가 먼저 들어가요. 새로 만드는 표에는 외래 키를 넣지 않아요. 표마다 한 트랜잭션이라, 실패한 표는 되돌려져요.')}</p>
          {result && <p className="muted small">{t('걸린 시간 {time}', { time: formatMs(result.ms) })}</p>}
          {running && <p className="busy"><LoaderCircle className="spin" />{t('옮기는 중… 표가 크면 오래 걸려요')}</p>}
        </div>
      </div>
    </Dialog>
  )
}
