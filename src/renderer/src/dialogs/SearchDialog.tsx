// 전체 검색: 이름(표·뷰·열·프로시저 등, 지금 DB 또는 모든 DB)과 데이터(스키마의 표마다 글 열에 그 값이 든 행 수). 대화 상자라 useWs 금지
import { useState, type ReactNode } from 'react'
import { Columns3, Database, Eye, FileSearch, ListOrdered, LoaderCircle, Search, Square, SquareFunction, Table2, Workflow, Zap } from 'lucide-react'
import { literal, quoteIdent } from '../../../shared/dialect'
import { dialectOf, type ConnectionInfo, type DataHit, type ObjectKind, type SearchHit, type TableRef } from '../../../shared/types'
import { api, errorText } from '../api'
import { useUi } from '../ui'
import { t } from '../i18n'
import { fmtNum, randomKey } from '../format'
import { Check, Dialog } from '../components/Dialog'

const ICON = { table: Table2, view: Eye, column: Columns3, procedure: Workflow, function: SquareFunction, trigger: Zap, sequence: ListOrdered, event: Zap } as const

export function SearchDialog({ conn, db, schema, ensureConnected, openTable, openEditor, onClose }: {
  conn: ConnectionInfo
  db: string
  schema: string
  ensureConnected: (id: string) => Promise<boolean>
  openTable: (ref: TableRef, kind: ObjectKind, filter?: string) => void
  openEditor: (db: string, schema: string, text: string) => void
  onClose: () => void
}) {
  const ui = useUi()
  const d = dialectOf(conn.driver)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'names' | 'data'>('names')
  const [allDbs, setAllDbs] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [data, setData] = useState<DataHit[] | null>(null)

  const run = async () => {
    const q = text.trim()
    if (!q) return
    const key = 'sr-' + randomKey()
    setBusy(key)
    try {
      if (!(await ensureConnected(conn.id))) return
      if (mode === 'names') setHits(await api.searchNames(conn.id, q, allDbs, db))
      else setData(await api.searchData(conn.id, db, schema, q, key))
    } catch (e) {
      ui.notify(errorText(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const openHit = async (h: SearchHit) => {
    if (h.kind === 'table' || h.kind === 'view' || h.kind === 'column') {
      onClose()
      openTable({ db: h.db, schema: h.schema, table: h.table }, h.kind === 'view' ? 'view' : 'table')
      return
    }
    try {
      const x = (await api.extraObjects(conn.id, h.db, h.schema)).find((e) => e.kind === h.kind && e.name === h.name)
      if (!x) throw new Error(t('개체를 찾지 못했어요: {name}', { name: h.name }))
      const src = await api.objectSource(conn.id, h.db, h.schema, x.kind, x.id)
      onClose()
      openEditor(h.db, h.schema, src)
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  const openData = (h: DataHit) => {
    // 그 값이 든 행만 보이게 조건을 걸어 연다
    const pat = literal(d, `%${text.trim()}%`)
    const filter = h.columns.map((c) => (d === 'postgres' ? `${quoteIdent(d, c)}::text ILIKE ${pat}` : `${quoteIdent(d, c)} LIKE ${pat}`)).join(' OR ')
    onClose()
    openTable({ db, schema, table: h.table }, 'table', filter)
  }

  const where = (h: SearchHit) => [allDbs || h.db !== db ? h.db : '', h.schema, h.kind === 'column' || h.kind === 'trigger' ? h.table : ''].filter(Boolean).join(' · ')
  let body: ReactNode = null
  if (mode === 'names' && hits) {
    body = hits.length === 0 ? <p className="pad muted">{t('찾은 것이 없어요')}</p> : hits.map((h, i) => {
      const I = ICON[h.kind]
      return (
        <div key={i} className="search-row" onDoubleClick={() => void openHit(h)} onClick={() => void openHit(h)}>
          <I className={`search-icon k-${h.kind}`} />
          <b className="ellipsis">{h.name}</b>
          {h.extra && <span className="mono muted small">{h.extra}</span>}
          <span className="spacer" />
          <span className="muted small ellipsis">{where(h)}</span>
        </div>
      )
    })
  } else if (mode === 'data' && data) {
    body = data.length === 0 ? <p className="pad muted">{t('찾은 것이 없어요')}</p> : data.map((h) => (
      <div key={h.table} className="search-row" title={h.error ?? h.columns.join(', ')} onClick={() => !h.error && openData(h)}>
        <Table2 className="search-icon k-table" />
        <b className="ellipsis">{h.table}</b>
        <span className="spacer" />
        {h.error ? <span className="err small ellipsis">{h.error.split('\n')[0]}</span> : <span className="muted small">{t('{n}행', { n: fmtNum(h.count) })}</span>}
      </div>
    ))
  }

  return (
    <Dialog title={t('전체 검색 — {name}', { name: conn.name })} icon={FileSearch} width={820} onClose={() => { if (!busy) onClose() }}>
      <div className="seg search-modes">
        <button type="button" className={mode === 'names' ? 'on' : ''} onClick={() => setMode('names')}><Search />{t('이름')}</button>
        <button type="button" className={mode === 'data' ? 'on' : ''} onClick={() => setMode('data')}><Database />{t('데이터')}</button>
      </div>
      {/* 대화 상자 자체가 form이라 안에 form을 또 두면 Enter가 화면을 다시 불러온다 → Enter는 직접 받는다 */}
      <div className="search-bar">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void run() } }} placeholder={mode === 'names' ? t('표·뷰·열·프로시저 이름') : t('찾을 값 (글 열에서)')} data-autofocus spellCheck={false} />
        <button type="button" className="btn primary" disabled={!text.trim() || !!busy} onClick={() => void run()}>{busy ? <LoaderCircle className="spin" /> : <Search />}{t('찾기')}</button>
        {busy && mode === 'data' && <button type="button" className="btn" onClick={() => void api.cancelSql(busy)}><Square />{t('멈추기')}</button>}
      </div>
      <div className="search-scope muted small">
        {mode === 'names'
          ? <Check checked={allDbs} onChange={setAllDbs}>{t('이 접속의 모든 DB에서 (지금: {db})', { db: db || conn.database || '-' })}</Check>
          : <span>{t('범위: {where} — 표마다 글 열을 훑어서 느릴 수 있어요', { where: [db, schema].filter(Boolean).join(' · ') || '-' })}</span>}
      </div>
      <div className="search-results">{body}</div>
      {mode === 'names' && hits && hits.length >= 3000 && <p className="muted small">{t('앞쪽 3000개만 보여요. 더 자세히 적어 주세요.')}</p>}
    </Dialog>
  )
}
