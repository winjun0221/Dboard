// SQL 덤프 내보내기: 표·뷰 고르기, 구조(DDL)·데이터(INSERT)·DROP, INSERT 묶음 크기 → .sql 파일. 도는 중에 중지할 수 있다
import { useMemo, useState } from 'react'
import { DatabaseBackup, Eye, LoaderCircle, ScrollText, Search, Square, Table2 } from 'lucide-react'
import type { ConnectionInfo, DumpOptions } from '../../../shared/types'
import { api, errorText, useObjects } from '../api'
import { useUi } from '../ui'
import { t } from '../i18n'
import { fmtNum, randomKey } from '../format'
import { Check, Choice, Dialog, Field } from '../components/Dialog'
import { DriverBadge } from '../components/DriverBadge'

const KEY = 'dboard.dump'
export type DumpContent = 'both' | 'structure' | 'data'
type Content = DumpContent

function load(): { content: Content; drop: boolean; batch: number } {
  const def = { content: 'both' as Content, drop: true, batch: 100 }
  try {
    return { ...def, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<typeof def>) }
  } catch {
    return def
  }
}

const today = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

// 대화 상자는 작업 공간(WsProvider) 바깥에 그려지므로 접속 정보는 props로 받는다
export function DumpDialog({ conn, db, schema, only, content, onClose }: {
  conn: ConnectionInfo
  /** 처음 고를 내용 ('DDL 내보내기'는 structure) */
  content?: DumpContent
  db: string
  schema: string
  /** 이 표만 처음부터 고른 채로 */
  only?: string
  onClose: () => void
}) {
  const ui = useUi()
  const connId = conn.id
  const objs = useObjects(connId, db, schema, true)
  const [o, setO] = useState(() => ({ ...load(), ...(content ? { content } : {}) }))
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [filter, setFilter] = useState('')
  const [running, setRunning] = useState<string | null>(null)
  const all = useMemo(() => objs.data ?? [], [objs.data])
  // 처음 고른 것: 표 하나(only) 또는 전부
  const sel = picked ?? new Set(all.filter((x) => !only || x.name === only).map((x) => x.name))
  const shown = all.filter((x) => !filter || x.name.toLowerCase().includes(filter.toLowerCase()))
  const structure = o.content !== 'data'
  const data = o.content !== 'structure'
  const chosen = all.filter((x) => sel.has(x.name) && (structure || x.kind === 'table'))
  const toggle = (name: string, on: boolean) => {
    const n = new Set(sel)
    if (on) n.add(name)
    else n.delete(name)
    setPicked(n)
  }
  const place = [db, schema].filter(Boolean).join(' · ')

  const submit = async () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(o))
    } catch {
      // 무시
    }
    const key = 'dump-' + randomKey()
    setRunning(key)
    try {
      const opts: DumpOptions = { structure, data, drop: structure && o.drop, batch: o.batch }
      const name = `${conn.name}_${[db, schema].filter(Boolean).join('_')}${only && chosen.length === 1 ? '_' + only : ''}${o.content === 'structure' ? '_ddl' : ''}_${today()}`
      const r = await api.exportDump(connId, key, db, schema, chosen.map((x) => ({ name: x.name, kind: x.kind })), opts, name)
      if (r) {
        ui.notify(t('덤프를 저장했어요 (표 {t}개 · 뷰 {v}개 · {n}행): {path}', { t: r.tables, v: r.views, n: fmtNum(r.rows), path: r.path }), 'success')
        onClose()
      }
    } catch (e) {
      ui.notify(errorText(e), 'error')
    } finally {
      setRunning(null)
    }
  }

  return (
    <Dialog
      title={content === 'structure' ? t('DDL 내보내기') : t('SQL 덤프 내보내기')}
      icon={content === 'structure' ? ScrollText : DatabaseBackup}
      width={560}
      submitLabel={t('저장할 곳 고르기…')}
      disabled={chosen.length === 0}
      onClose={onClose}
      onSubmit={submit}
      footer={running && (
        <button type="button" className="btn" onClick={() => void api.cancelSql(running)}><Square />{t('중지')}</button>
      )}
    >
      <p className="dump-target">
        <DriverBadge driver={conn.driver} size={16} />
        <b>{conn.name}</b>
        {place && <span className="muted">· {place}</span>}
      </p>
      <Choice
        value={o.content}
        onChange={(v) => setO({ ...o, content: v })}
        options={[
          { value: 'both', label: t('구조 + 데이터'), desc: t('CREATE 문과 INSERT 문 — 다른 DB에 그대로 옮길 때') },
          { value: 'structure', label: t('구조만 (DDL)'), desc: t('표·인덱스·뷰를 만드는 CREATE 문만') },
          { value: 'data', label: t('데이터만'), desc: t('INSERT 문만 — 표가 이미 있는 DB에 넣을 때') },
        ]}
      />
      <div className="two fit">
        <Check checked={structure && o.drop} disabled={!structure} onChange={(v) => setO({ ...o, drop: v })}>{t('맨 앞에 DROP … IF EXISTS (있던 표를 지우고 새로 만들기)')}</Check>
        <Field label={t('INSERT 한 문장에 행')}>
          <input type="number" min={1} max={10000} value={o.batch} disabled={!data} style={{ width: 90 }}
            onChange={(e) => setO({ ...o, batch: Math.max(1, Math.min(10_000, Math.round(Number(e.target.value) || 1))) })} />
        </Field>
      </div>
      <div className="dump-list">
        <div className="dump-list-head">
          <span className="side-search">
            <Search />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('표 이름 찾기')} spellCheck={false} />
          </span>
          <button type="button" className="link" onClick={() => setPicked(new Set([...sel, ...shown.map((x) => x.name)]))}>{t('모두 고르기')}</button>
          <button type="button" className="link" onClick={() => setPicked(new Set([...sel].filter((n) => !shown.some((x) => x.name === n))))}>{t('모두 빼기')}</button>
        </div>
        <div className="dump-items">
          {objs.isPending && <div className="center-fill small"><LoaderCircle className="spin small-icon" /></div>}
          {objs.error && <div className="banner error inline">{errorText(objs.error)}</div>}
          {objs.data && all.length === 0 && <p className="muted small pad">{t('표가 없어요')}</p>}
          {shown.map((x) => {
            const off = x.kind === 'view' && !structure
            return (
              <label key={x.name} className={`dump-item ${off ? 'off' : ''}`} title={off ? t('뷰는 데이터가 없어서 구조를 뽑을 때만 들어가요') : x.comment || x.name}>
                <input type="checkbox" checked={sel.has(x.name) && !off} disabled={off} onChange={(e) => toggle(x.name, e.target.checked)} />
                {x.kind === 'view' ? <Eye className="view-icon" /> : <Table2 className="table-icon" />}
                <span className="ellipsis">{x.name}</span>
              </label>
            )
          })}
        </div>
        <div className="dump-list-foot muted small">
          {running ? <span className="busy"><LoaderCircle className="spin" />{t('내보내는 중… 표가 크면 오래 걸려요')}</span> : t('{n}개 고름 (표 {t}개 · 뷰 {v}개)', { n: chosen.length, t: chosen.filter((x) => x.kind === 'table').length, v: chosen.filter((x) => x.kind === 'view').length })}
        </div>
      </div>
    </Dialog>
  )
}
