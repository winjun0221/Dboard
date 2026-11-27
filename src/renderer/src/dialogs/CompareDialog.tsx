// 스키마 비교: 원본(여기) ↔ 대상(고름). 표마다 바뀐 점과 대상을 원본처럼 만드는 SQL, 골라서 대상에 실행. 대화 상자라 useWs 금지
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, CircleAlert, CircleCheck, CircleMinus, CirclePlus, Eye, GitCompareArrows, LoaderCircle, Play, SquareTerminal, Table2, TriangleAlert } from 'lucide-react'
import { dialectOf, type CompareItem, type CompareResult, type ConnectionInfo } from '../../../shared/types'
import { api, errorText } from '../api'
import { useUi } from '../ui'
import { t, tk } from '../i18n'
import { Check, Dialog } from '../components/Dialog'
import { SqlEditor } from '../components/SqlEditor'
import { DdlDialog } from './DdlDialog'
import { TargetPicker, type Target } from './TargetPicker'

const STATUS = {
  same: { icon: CircleCheck, label: tk('같음') },
  changed: { icon: CircleAlert, label: tk('다름') },
  source: { icon: CirclePlus, label: tk('원본에만') },
  target: { icon: CircleMinus, label: tk('대상에만') },
} as const

export function CompareDialog({ conn, db, schema, connections, ensureConnected, openEditor, onClose }: {
  conn: ConnectionInfo
  db: string
  schema: string
  connections: ConnectionInfo[]
  ensureConnected: (id: string) => Promise<boolean>
  openEditor: (connId: string, db: string, schema: string, text: string) => void
  onClose: () => void
}) {
  const ui = useUi()
  const qc = useQueryClient()
  const d = dialectOf(conn.driver)
  const [target, setTarget] = useState<Target>({ connId: '', db: '', schema: '' })
  const [result, setResult] = useState<CompareResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<string | null>(null)
  const [hideSame, setHideSame] = useState(true)
  const dst = connections.find((c) => c.id === target.connId)

  const compare = async () => {
    if (!target.connId) return
    setBusy(true)
    try {
      if (!(await ensureConnected(conn.id)) || !(await ensureConnected(target.connId))) return
      const r = await api.compareSchemas(conn.id, db, schema, target.connId, target.db, target.schema)
      setResult(r)
      setPicked(new Set(r.items.filter((x) => (x.status === 'source' || x.status === 'changed') && x.statements.length && !x.error).map((x) => x.name)))
      setSel(r.items.find((x) => x.status !== 'same')?.name ?? null)
    } catch (e) {
      ui.notify(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const chosen = (result?.items ?? []).filter((x) => picked.has(x.name) && x.statements.length)
  const statements = chosen.flatMap((x) => x.statements)
  const warnings = [...new Set(chosen.flatMap((x) => x.warnings))]
  const items = (result?.items ?? []).filter((x) => !hideSame || x.status !== 'same')
  const cur = result?.items.find((x) => x.name === sel) ?? null
  const counts = (s: CompareItem['status']) => result?.items.filter((x) => x.status === s).length ?? 0

  const apply = () => {
    if (!dst || !statements.length) return
    ui.open((close) => (
      <DdlDialog title={t('대상에 실행: {name}', { name: dst.name })} driver={dst.driver} statements={statements} warnings={warnings} production={dst.production === true} onClose={close}
        onSubmit={async () => {
          try {
            await api.runDdl(dst.id, target.db, target.schema, statements)
          } catch (e) {
            ui.notify(errorText(e), 'error')
            return
          }
          close()
          ui.notify(t('대상을 원본처럼 바꿨어요 (문장 {n}개)', { n: statements.length }), 'success')
          void qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === dst.id && q.queryKey[0] !== 'connections' })
          void compare()
        }} />
    ))
  }

  const toggle = (name: string, on: boolean) => setPicked((s) => {
    const n = new Set(s)
    if (on) n.add(name)
    else n.delete(name)
    return n
  })

  return (
    <Dialog title={t('스키마 비교')} icon={GitCompareArrows} width={1180} onClose={onClose} className="compare-dialog"
      footer={result && (
        <>
          <button type="button" className="btn" disabled={!statements.length || !dst} onClick={() => dst && openEditor(dst.id, target.db, target.schema, statements.join(dst.driver === 'mssql' ? '\nGO\n' : ';\n') + (dst.driver === 'mssql' ? '' : ';'))}>
            <SquareTerminal />{t('SQL 편집기로 열기')}
          </button>
          <button type="button" className="btn primary" disabled={!statements.length || dst?.readOnly === true} onClick={apply}><Play />{t('대상에 실행… ({n}개 표)', { n: chosen.length })}</button>
        </>
      )}>
      <div className="compare-head">
        <div className="compare-side">
          <span className="muted small">{t('원본')}</span>
          <b>{conn.name}</b>
          <span className="muted">{[db, schema].filter(Boolean).join(' · ')}</span>
        </div>
        <ArrowRight className="compare-arrow" />
        <div className="compare-side grow">
          <span className="muted small">{t('대상 (원본처럼 바꿀 쪽)')}</span>
          <TargetPicker connections={connections} value={target} onChange={setTarget} ensureConnected={ensureConnected}
            allow={(c) => (dialectOf(c.driver) !== d ? t('다른 종류') : null)} />
        </div>
        <button type="button" className="btn primary" disabled={!target.connId || busy} onClick={() => void compare()}>{busy ? <LoaderCircle className="spin" /> : <GitCompareArrows />}{t('비교')}</button>
      </div>
      {result && (
        <>
          <div className="compare-summary">
            <span>{t('다름 {n}', { n: counts('changed') })}</span>
            <span>{t('원본에만 {n}', { n: counts('source') })}</span>
            <span>{t('대상에만 {n}', { n: counts('target') })}</span>
            <span className="muted">{t('같음 {n}', { n: counts('same') })}</span>
            <span className="spacer" />
            <Check checked={hideSame} onChange={setHideSame}>{t('같은 것 숨기기')}</Check>
          </div>
          <div className="compare-body">
            <div className="compare-list">
              {items.length === 0 && <p className="pad muted">{t('다른 점이 없어요')}</p>}
              {items.map((x) => {
                const S = STATUS[x.status]
                const can = x.statements.length > 0 && !x.error
                return (
                  <div key={x.kind + x.name} className={`compare-row ${sel === x.name ? 'sel' : ''} st-${x.status} kind-${x.kind}`} onClick={() => setSel(x.name)}>
                    <input type="checkbox" aria-label={t('고르기')} checked={picked.has(x.name)} disabled={!can} onClick={(e) => e.stopPropagation()} onChange={(e) => toggle(x.name, e.target.checked)} />
                    <S.icon className="st-icon" />
                    {x.kind === 'view' ? <Eye className="kind-icon" /> : <Table2 className="kind-icon" />}
                    <span className="ellipsis name">{x.name}</span>
                    <span className="muted small ellipsis">{x.error ? t('SQL을 만들지 못했어요') : t(S.label)}</span>
                  </div>
                )
              })}
            </div>
            <div className="compare-detail">
              {!cur && <p className="pad muted">{t('왼쪽에서 표를 골라 주세요')}</p>}
              {cur && (
                <>
                  <h3>{cur.name}</h3>
                  {cur.error && <div className="banner error inline"><TriangleAlert />{cur.error}</div>}
                  {cur.warnings.map((w) => <div key={w} className="banner warn inline"><TriangleAlert />{w}</div>)}
                  {cur.changes.length > 0 && <ul className="compare-changes">{cur.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
                  {cur.kind === 'view' && cur.status !== 'same' && <p className="muted small">{t('뷰는 SQL을 만들지 않아요. 원본의 DDL을 보고 직접 맞춰 주세요.')}</p>}
                  {cur.status === 'target' && cur.kind === 'table' && <p className="muted small">{t('대상에만 있는 표예요. 고르면 대상에서 지워요.')}</p>}
                  {cur.statements.length > 0 && (
                    <div className="compare-sql">
                      <SqlEditor key={cur.name} initial={cur.statements.join(conn.driver === 'mssql' ? '\nGO\n' : ';\n') + (conn.driver === 'mssql' ? '' : ';')} driver={dst?.driver ?? conn.driver} fontSize={12.5} readOnly />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </Dialog>
  )
}
