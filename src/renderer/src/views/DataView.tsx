// 표 데이터 보기·고치기: 서버 쪽 정렬·조건·더 가져오기, 칸 고치기·행 추가·삭제(저장 전엔 표시만),
// 되돌리기(Ctrl+Z·전부), 저장 전에 실행할 SQL 미리 보기 → 한 트랜잭션으로 저장
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ClipboardCopy, Download, Filter, KeyRound, ListPlus, LoaderCircle, Lock, Pencil, Plus, RefreshCw, Save, Sigma, Trash2, Undo2, Upload, X, Eraser,
} from 'lucide-react'
import type { Cell, ObjectKind, RowChange, SortKey, TableData, TableRef } from '../../../shared/types'
import { dialectOf, isBin } from '../../../shared/types'
import { literal, quoteIdent } from '../../../shared/dialect'
import { previewChanges } from '../../../shared/edit'
import { api, errorText, useColumns } from '../api'
import { setDirty, useWs } from '../ws'
import { useUi } from '../ui'
import { t } from '../i18n'
import { cellText, fmtNum, formatMs } from '../format'
import { Grid, type GridHandle } from '../components/Grid'
import { ExportDialog } from '../dialogs/ExportDialog'
import { ImportDialog } from '../dialogs/ImportDialog'
import { PreviewDialog } from '../dialogs/PreviewDialog'
import { ValueDialog } from '../dialogs/ValueDialog'

interface Pending {
  /** 원래 행 → 열 → 새 값 */
  edits: Record<number, Record<number, Cell>>
  deleted: number[]
  /** 새 행: 열 → 값 (없는 열은 DB 기본값) */
  added: Record<number, Cell>[]
}

const EMPTY: Pending = { edits: {}, deleted: [], added: [] }
const count = (p: Pending) => Object.keys(p.edits).filter((r) => !p.deleted.includes(Number(r))).length + p.deleted.length + p.added.length

export function DataView({ tabId, connId, target, objKind, active }: { tabId: string; connId: string; target: TableRef; objKind: ObjectKind; active: boolean }) {
  const ws = useWs()
  const ui = useUi()
  const qc = useQueryClient()
  const conn = ws.conn(connId)
  const d = dialectOf(conn?.driver ?? 'sqlite')
  const [data, setData] = useState<TableData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filterInput, setFilterInput] = useState('')
  const [filter, setFilter] = useState('')
  const [order, setOrder] = useState<SortKey[]>([])
  const [pending, setPending] = useState<Pending>(EMPTY)
  const [undo, setUndo] = useState<Pending[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const grid = useRef<GridHandle>(null)
  const started = useRef(false)
  const isOn = ws.connected.has(connId)
  const cols = useColumns(connId, target, isOn)
  const readOnly = objKind === 'view'
  const changes = count(pending)

  useEffect(() => {
    setDirty(tabId, changes > 0)
    return () => setDirty(tabId, false)
  }, [tabId, changes])

  const load = async (reset: boolean, q: { filter: string; order: SortKey[] } = { filter, order }) => {
    if (!(await ws.ensureConnected(connId))) return
    setLoading(true)
    setError(null)
    try {
      const offset = reset ? 0 : data?.rows.length ?? 0
      const r = await api.tableData(connId, target, { filter: q.filter, order: q.order, offset, limit: ws.settings.pageSize })
      if (reset || !data) {
        setData(r)
        setPending(EMPTY)
        setUndo([])
        setTotal(null)
      } else setData({ ...r, rows: [...data.rows, ...r.rows], rowids: r.rowids && data.rowids ? [...data.rowids, ...r.rowids] : null })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }

  // 처음 보일 때 읽는다 (다시 켰을 때 열려 있던 탭이 한꺼번에 연결하지 않게)
  useEffect(() => {
    if (active && !started.current) {
      started.current = true
      void load(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  /** 바뀐 것을 버려도 되는지 */
  const discardOk = async () => {
    if (changes === 0) return true
    return ui.confirm({ title: t('저장하지 않은 변경'), message: t('저장하지 않은 변경 {n}건을 버릴까요?', { n: changes }), confirm: t('버리기'), danger: true })
  }

  const reload = async (q?: { filter: string; order: SortKey[] }) => {
    if (!(await discardOk())) return
    await load(true, q)
  }

  const columns = useMemo(() => {
    const info = new Map((cols.data ?? []).map((c) => [c.name, c]))
    return (data?.columns ?? []).map((c) => ({ name: c.name, type: info.get(c.name)?.type ?? c.type, pk: info.get(c.name)?.pk }))
  }, [data, cols.data])

  const base = data?.rows ?? []
  const rowCount = base.length + pending.added.length

  const cellAt = (r: number, c: number): Cell => {
    if (r < base.length) {
      const e = pending.edits[r]
      return e && c in e ? e[c] : base[r][c]
    }
    const a = pending.added[r - base.length]
    return a && c in a ? a[c] : null
  }

  const change = (fn: (p: Pending) => Pending) => {
    setUndo((u) => [...u.slice(-200), pending])
    setPending(fn)
  }

  const setValue = (r: number, c: number, v: Cell) => {
    if (readOnly) return
    if (r < base.length) {
      const orig = base[r][c]
      change((p) => {
        const row = { ...(p.edits[r] ?? {}) }
        // 원래 값으로 돌아오면 바뀐 것에서 뺀다
        if ((orig === null && v === null) || (orig !== null && v !== null && !isBin(orig) && cellText(orig) === cellText(v))) delete row[c]
        else row[c] = v
        const edits = { ...p.edits }
        if (Object.keys(row).length) edits[r] = row
        else delete edits[r]
        return { ...p, edits }
      })
    } else {
      const i = r - base.length
      change((p) => ({ ...p, added: p.added.map((a, k) => (k === i ? { ...a, [c]: v } : a)) }))
    }
  }

  const deleteRows = (rows: number[]) => {
    if (readOnly || rows.length === 0) return
    const baseRows = rows.filter((r) => r < base.length)
    const newRows = new Set(rows.filter((r) => r >= base.length).map((r) => r - base.length))
    change((p) => ({ ...p, deleted: [...new Set([...p.deleted, ...baseRows])], added: p.added.filter((_, i) => !newRows.has(i)) }))
  }

  const revertRows = (rows: number[]) => {
    const set = new Set(rows)
    change((p) => {
      const edits = { ...p.edits }
      for (const r of rows) delete edits[r]
      return { ...p, edits, deleted: p.deleted.filter((r) => !set.has(r)) }
    })
  }

  const addRow = () => {
    if (readOnly) return
    change((p) => ({ ...p, added: [...p.added, {}] }))
    const r = base.length + pending.added.length
    window.setTimeout(() => {
      const first = columns.findIndex((c) => !(cols.data?.find((x) => x.name === c.name)?.autoIncrement))
      grid.current?.select(r, Math.max(0, first))
      grid.current?.edit(r, Math.max(0, first))
    }, 30)
  }

  const doUndo = () => {
    if (!undo.length) return
    setPending(undo[undo.length - 1])
    setUndo((u) => u.slice(0, -1))
  }

  const buildChanges = (): RowChange[] => {
    if (!data) return []
    const keyOf = (r: number): Cell[] => {
      if (data.key.kind === 'rowid') return [data.rowids?.[r] ?? null]
      return data.key.columns.map((name) => base[r][data.columns.findIndex((c) => c.name === name)])
    }
    const out: RowChange[] = []
    for (const [rs, e] of Object.entries(pending.edits)) {
      const r = Number(rs)
      if (pending.deleted.includes(r)) continue
      out.push({ op: 'update', key: keyOf(r), values: Object.fromEntries(Object.entries(e).map(([c, v]) => [columns[Number(c)].name, v])) })
    }
    for (const r of [...pending.deleted].sort((a, b) => a - b)) out.push({ op: 'delete', key: keyOf(r) })
    for (const a of pending.added) out.push({ op: 'insert', values: Object.fromEntries(Object.entries(a).map(([c, v]) => [columns[Number(c)].name, v])) })
    return out
  }

  const save = () => {
    if (!data || changes === 0) return
    const list = buildChanges()
    const sql = previewChanges(d, target, data.key, list)
    ui.open((close) => (
      <PreviewDialog
        driver={conn?.driver ?? 'sqlite'}
        sql={sql.join(';\n') + ';'}
        summary={t('수정 {u} · 추가 {i} · 삭제 {d}', { u: list.filter((x) => x.op === 'update').length, i: list.filter((x) => x.op === 'insert').length, d: list.filter((x) => x.op === 'delete').length })}
        warn={data.key.kind === 'all' ? t('기본 키가 없어서 모든 열 값이 같은 행 하나를 찾아 바꿔요.') : undefined}
        onClose={close}
        onSubmit={async () => {
          try {
            const n = await api.applyChanges(connId, target, list)
            ui.notify(t('저장했어요 ({n}건)', { n }), 'success')
            close()
            void qc.invalidateQueries({ queryKey: ['table-data', connId] })
            await load(true)
          } catch (e) {
            ui.notify(errorText(e), 'error')
          }
        }}
      />
    ))
  }

  const applyFilter = (f: string) => {
    setFilterInput(f)
    void (async () => {
      if (!(await discardOk())) return
      setFilter(f)
      await load(true, { filter: f, order })
    })()
  }

  const onSort = (column: string, add: boolean) => {
    const ex = order.find((s) => s.column === column)
    const next = !ex ? { column, desc: false } : !ex.desc ? { column, desc: true } : null
    const rest = add ? order.filter((s) => s.column !== column) : []
    const o = next ? [...rest, next] : rest
    void (async () => {
      if (!(await discardOk())) return
      setOrder(o)
      await load(true, { filter, order: o })
    })()
  }

  const countAll = async () => {
    try {
      setTotal(await api.countRows(connId, target, filter))
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  const doExport = () => ui.open((close) => (
    <ExportDialog title={t('{name} CSV로 내보내기', { name: target.table })} rows={null} onClose={close} onSubmit={async (o) => {
      try {
        const r = await api.exportTableCsv(connId, target, filter, order, o)
        if (r) ui.notify(t('{n}행을 저장했어요: {path}', { n: fmtNum(r.rows), path: r.path }), 'success')
        close()
      } catch (e) {
        ui.notify(errorText(e), 'error')
      }
    }} />
  ))

  const doImport = () => ui.open((close) => <ImportDialog connId={connId} target={target} onClose={close} onDone={() => void load(true)} />)

  const editValue = (r: number, c: number) => {
    const v = cellAt(r, c)
    if (v !== null && isBin(v)) {
      ui.notify(t('바이너리 값은 여기서 바꿀 수 없어요'), 'warn')
      return
    }
    ui.open((close) => <ValueDialog column={columns[c].name} type={columns[c].type} value={v} readOnly={readOnly} onClose={close} onSubmit={(nv) => { setValue(r, c, nv); close() }} />)
  }

  const rowsOf = (sel: { r0: number; r1: number }) => Array.from({ length: sel.r1 - sel.r0 + 1 }, (_, i) => sel.r0 + i)

  if (!conn) return null
  const keyKind = data?.key.kind
  const deleted = new Set(pending.deleted)

  return (
    <div className="data-view">
      <div className="data-bar">
        <div className="filter-box">
          <Filter />
          <span className="kw">WHERE</span>
          <input
            value={filterInput}
            onChange={(e) => setFilterInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyFilter(filterInput.trim()) }}
            placeholder={t("조건 (예: id > 10 AND name LIKE '%a%') — Enter")}
            spellCheck={false}
            className="mono"
          />
          {filter && <button className="icon-btn small" title={t('조건 지우기')} onClick={() => applyFilter('')}><X /></button>}
        </div>
        <button className="icon-btn" title={t('새로고침')} onClick={() => void reload()}><RefreshCw className={loading ? 'spin' : ''} /></button>
        <span className="bar-sep" />
        {readOnly ? (
          <span className="chip"><Lock />{t('뷰는 읽기 전용')}</span>
        ) : (
          <>
            <button className="btn small" onClick={addRow} disabled={!data}><Plus />{t('행 추가')}</button>
            <button className="btn small" onClick={() => { const s = grid.current?.selection(); if (s) deleteRows(rowsOf(s)) }} disabled={!data}><Trash2 />{t('행 삭제')}</button>
            <button className="btn small" onClick={doUndo} disabled={!undo.length} title={t('마지막 변경 되돌리기 (Ctrl+Z)')}><Undo2 />{t('되돌리기')}</button>
            <button className="btn small" onClick={() => change(() => EMPTY)} disabled={!changes} title={t('저장하지 않은 변경을 모두 버리기')}><Eraser />{t('모두 되돌리기')}</button>
            <button className={`btn small ${changes ? 'primary' : ''}`} onClick={save} disabled={!changes} title={t('실행할 SQL을 미리 보고 저장 (Ctrl+S)')}>
              <Save />{changes ? t('저장 ({n})', { n: changes }) : t('저장')}
            </button>
          </>
        )}
        <span className="spacer" />
        <button className="btn small" onClick={doExport} disabled={!data}><Download />{t('CSV')}</button>
        {!readOnly && <button className="btn small" onClick={doImport}><Upload />{t('가져오기')}</button>}
      </div>
      {keyKind === 'all' && !readOnly && <div className="banner warn"><KeyRound />{t('기본 키가 없는 표예요. 고치거나 지울 때 모든 열 값이 같은 행 하나를 찾아요.')}</div>}
      {error && <div className="banner error">{error}</div>}
      {data ? (
        <Grid
          handle={grid}
          columns={columns}
          rowCount={rowCount}
          cell={cellAt}
          rowLabel={(r) => (r >= base.length ? '+' : String(r + 1))}
          textOf={(r, c) => (r >= base.length && !(c in (pending.added[r - base.length] ?? {})) ? 'DEFAULT' : undefined)}
          rowClass={(r) => (r >= base.length ? 'added' : deleted.has(r) ? 'deleted' : '')}
          cellClass={(r, c) => {
            if (r >= base.length) return c in (pending.added[r - base.length] ?? {}) ? 'edited' : 'default'
            return pending.edits[r] && c in pending.edits[r] ? 'edited' : ''
          }}
          sort={order}
          onSort={onSort}
          widthKey={`${connId}:${target.db}:${target.schema}:${target.table}`}
          canEdit={(r) => !readOnly && !deleted.has(r)}
          onEdit={setValue}
          onKey={(e, sel) => {
            const mod = e.ctrlKey || e.metaKey
            if (mod && (e.key === 'z' || e.key === 'Z')) { doUndo(); return true }
            if (mod && (e.key === 's' || e.key === 'S')) { save(); return true }
            if (e.key === 'Delete' && sel && !readOnly) { deleteRows(rowsOf(sel)); return true }
            return false
          }}
          onMenu={(e, sel) => {
            const one = sel.r0 === sel.r1 && sel.c0 === sel.c1
            const v = cellAt(sel.r0, sel.c0)
            const col = columns[sel.c0]
            const rows = rowsOf(sel)
            ui.menu(e, [
              { label: t('복사'), icon: ClipboardCopy, hint: 'Ctrl+C', onClick: () => grid.current?.copy(false) },
              { label: t('열 이름과 함께 복사'), hint: 'Ctrl+Shift+C', onClick: () => grid.current?.copy(true) },
              one && col && sel.r0 < base.length && { label: t('이 값으로 거르기'), icon: Filter, onClick: () => applyFilter(v === null ? `${quoteIdent(d, col.name)} IS NULL` : `${quoteIdent(d, col.name)} = ${literal(d, v)}`) },
              !readOnly && 'sep',
              !readOnly && one && { label: t('값 고치기…'), icon: Pencil, hint: 'Enter', onClick: () => editValue(sel.r0, sel.c0) },
              !readOnly && { label: t('NULL로'), onClick: () => { for (const r of rows) for (let c = sel.c0; c <= sel.c1; c++) setValue(r, c, null) } },
              !readOnly && 'sep',
              !readOnly && { label: t('행 추가'), icon: Plus, onClick: addRow },
              !readOnly && { label: t('행 삭제'), icon: Trash2, hint: 'Delete', danger: true, onClick: () => deleteRows(rows) },
              !readOnly && rows.some((r) => pending.edits[r] || deleted.has(r)) && { label: t('이 행 되돌리기'), icon: Undo2, onClick: () => revertRows(rows) },
            ])
          }}
        />
      ) : (
        <div className="center-fill">{loading ? <LoaderCircle className="spin big" /> : !isOn ? <button className="btn" onClick={() => void load(true)}>{t('연결해서 보기')}</button> : null}</div>
      )}
      <div className="data-foot">
        {data && (
          <>
            <span>{t('{n}행', { n: fmtNum(base.length) })}{data.hasMore ? '+' : ''}</span>
            {data.hasMore && <button className="link" onClick={() => void load(false)} disabled={loading}><ListPlus />{t('다음 {n}행 더 가져오기', { n: ws.settings.pageSize })}</button>}
            <span className="sep-dot" />
            {total === null ? <button className="link" onClick={() => void countAll()}><Sigma />{t('전체 행 수 세기')}</button> : <span>{t('전체 {n}행', { n: fmtNum(total) })}</span>}
            <span className="sep-dot" />
            <span className="muted">{formatMs(data.ms)}</span>
            {keyKind && <span className="muted small">· {keyKind === 'pk' ? t('기본 키로 행 찾기') : keyKind === 'rowid' ? t('rowid로 행 찾기') : t('모든 열로 행 찾기')}</span>}
            <span className="spacer" />
            {changes > 0 && <span className="pending-chip">{t('저장 안 한 변경 {n}건', { n: changes })}</span>}
          </>
        )}
      </div>
    </div>
  )
}
