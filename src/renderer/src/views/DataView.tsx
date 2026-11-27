// 표 데이터 보기·고치기: 서버 쪽 정렬·조건·더 가져오기, 칸 고치기·행 추가·삭제(저장 전엔 표시만),
// 되돌리기(Ctrl+Z·전부), 저장 전에 실행할 SQL 미리 보기 → 한 트랜잭션으로 저장.
// 외래 키 따라가기, 고른 행으로 INSERT·UPDATE·DELETE 만들기, 행 세로 보기, 고른 칸 계산, 값 보기(바이너리·JSON)
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ClipboardCopy, DatabaseBackup, Download, Filter, KeyRound, Link2, ListPlus, LoaderCircle, Lock, Pencil, Plus, RefreshCw, Save, Sigma, TableProperties, Trash2, Undo2, Upload, X, Eraser, FileCode2,
} from 'lucide-react'
import type { Cell, ObjectKind, RowChange, SortKey, TableData, TableRef } from '../../../shared/types'
import { dialectOf, isBin } from '../../../shared/types'
import { literal, quoteIdent } from '../../../shared/dialect'
import { features } from '../../../shared/features'
import { changesAsSql, previewChanges } from '../../../shared/edit'
import { api, errorText, useColumns } from '../api'
import { setDirty, useWs } from '../ws'
import { useUi } from '../ui'
import { t } from '../i18n'
import { cellText, fmtNum, formatMs } from '../format'
import { Grid, type GridHandle, type Sel } from '../components/Grid'
import { RecordView, StatsText, selectionStats } from '../components/GridExtras'
import { ExportDialog } from '../dialogs/ExportDialog'
import { ImportDialog } from '../dialogs/ImportDialog'
import { PreviewDialog } from '../dialogs/PreviewDialog'
import { ValueDialog } from '../dialogs/ValueDialog'
import { DumpDialog } from '../dialogs/DumpDialog'

interface Pending {
  /** 원래 행 → 열 → 새 값 */
  edits: Record<number, Record<number, Cell>>
  deleted: number[]
  /** 새 행: 열 → 값 (없는 열은 DB 기본값) */
  added: Record<number, Cell>[]
}

const EMPTY: Pending = { edits: {}, deleted: [], added: [] }
const count = (p: Pending) => Object.keys(p.edits).filter((r) => !p.deleted.includes(Number(r))).length + p.deleted.length + p.added.length

export function DataView({ tabId, connId, target, objKind, active, initialFilter, filterSeq }: {
  tabId: string
  connId: string
  target: TableRef
  objKind: ObjectKind
  active: boolean
  /** 외래 키 따라가기로 열 때의 조건 (filterSeq가 바뀌면 다시 건다) */
  initialFilter?: string
  filterSeq?: number
}) {
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
  const connReadOnly = conn?.readOnly === true
  // ClickHouse는 행을 하나씩 고치지 못한다 (가져오기는 된다)
  const noRowEdit = !features(d).editRows
  const readOnly = objKind === 'view' || connReadOnly || noRowEdit
  const changes = count(pending)
  const fks = useQuery({ queryKey: ['fks', connId, target.db, target.schema, target.table], queryFn: () => api.foreignKeys(connId, target), enabled: isOn && objKind === 'table' })
  const [sel, setSel] = useState<Sel | null>(null)
  const [record, setRecord] = useState(false)
  const [recRow, setRecRow] = useState(0)
  const lastSeq = useRef<number | undefined>(undefined)

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

  // 외래 키 따라가기로 열렸거나 다시 불렸으면 그 조건으로
  useEffect(() => {
    if (filterSeq === undefined || filterSeq === lastSeq.current || !active) return
    lastSeq.current = filterSeq
    started.current = true
    applyFilter(initialFilter ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSeq, active])

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
    const fkOf = (name: string) => fks.data?.find((f) => f.columns.includes(name))
    return (data?.columns ?? []).map((c) => {
      const fk = fkOf(c.name)
      return { name: c.name, type: info.get(c.name)?.type ?? c.type, pk: info.get(c.name)?.pk, fk: fk ? `${fk.ref.table} (${fk.refColumns.join(', ')})` : undefined }
    })
  }, [data, cols.data, fks.data])

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

  /** 원래 행의 키 값 (TableData.key 순서, rowid면 [rowid]) */
  const keyOf = (r: number): Cell[] => {
    if (!data) return []
    if (data.key.kind === 'rowid') return [data.rowids?.[r] ?? null]
    return data.key.columns.map((name) => base[r][data.columns.findIndex((c) => c.name === name)])
  }

  /** 고른 행으로 INSERT·UPDATE·DELETE 문 만들어 복사 (값은 지금 화면의 값, 앞부분만 있는 바이너리는 뺌) */
  const copyAsSql = (rows: number[], op: 'insert' | 'update' | 'delete') => {
    if (!data) return
    const list = rows.filter((r) => r < base.length)
    if (!list.length) return
    let skipped = 0
    const valuesOf = (r: number, keyCols: Set<string>) => {
      const out: Record<string, Cell> = {}
      columns.forEach((col, c) => {
        if (keyCols.has(col.name)) return
        const v = cellAt(r, c)
        if (v !== null && isBin(v) && v.size > v.bin.length / 2) {
          skipped++
          return
        }
        out[col.name] = v
      })
      return out
    }
    const keyCols = new Set(data.key.kind === 'pk' ? data.key.columns : [])
    const changes: RowChange[] = list.map((r) => op === 'insert' ? { op, values: valuesOf(r, new Set()) } : op === 'update' ? { op, key: keyOf(r), values: valuesOf(r, keyCols) } : { op, key: keyOf(r) })
    try {
      void api.copyText(changesAsSql(d, target, data.key, changes).join(';\n') + ';')
      ui.notify(t('{n}개 문장을 복사했어요', { n: changes.length }) + (skipped ? ' · ' + t('앞부분만 있는 바이너리 칸 {n}개는 뺐어요', { n: skipped }) : ''), 'success')
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  /** 외래 키 칸 → 참조하는 표를 그 값으로 걸러서 열기 */
  const followFk = (r: number, c: number) => {
    const name = columns[c]?.name
    return (fks.data ?? []).filter((f) => f.columns.includes(name)).map((f) => {
      const vals = f.columns.map((fc) => cellAt(r, columns.findIndex((x) => x.name === fc)))
      if (vals.some((v) => v === null || isBin(v))) return null
      const cond = f.refColumns.map((rc, i) => `${quoteIdent(d, rc)} = ${literal(d, vals[i])}`).join(' AND ')
      return { label: t('참조하는 행 보기: {table} ({cond})', { table: f.ref.table, cond: cond.length > 60 ? cond.slice(0, 60) + '…' : cond }), run: () => ws.openTable(connId, f.ref, 'table', 'data', cond) }
    }).filter((x): x is { label: string; run: () => void } => !!x)
  }

  const buildChanges = (): RowChange[] => {
    if (!data) return []
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
    <ExportDialog title={t('{name} 내보내기', { name: target.table })} rows={null} table={target.table} dialect={d} onClose={close} onSubmit={async (o) => {
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

  // 값 보기·고치기: 바이너리는 전체를 불러와 16진수·이미지, 저장된 행이면 파일로 저장도
  const editValue = (r: number, c: number) => {
    const v = cellAt(r, c)
    const col = columns[c]
    const saved = r < base.length && !(pending.edits[r] && c in pending.edits[r])
    ui.open((close) => (
      <ValueDialog
        column={col.name}
        type={col.type}
        value={v}
        readOnly={readOnly || (v !== null && isBin(v)) || deleted.has(r)}
        load={saved ? () => api.cellValue(connId, target, keyOf(r), col.name) : undefined}
        save={saved ? async () => {
          try {
            const p = await api.saveCellValue(connId, target, keyOf(r), col.name, `${target.table}_${col.name}`)
            if (p) ui.notify(t('저장했어요: {path}', { path: p }), 'success')
          } catch (e) {
            ui.notify(errorText(e), 'error')
          }
        } : undefined}
        onClose={close}
        onSubmit={(nv) => { setValue(r, c, nv); close() }}
      />
    ))
  }

  const rowsOf = (sel: { r0: number; r1: number }) => Array.from({ length: sel.r1 - sel.r0 + 1 }, (_, i) => sel.r0 + i)

  const deleted = new Set(pending.deleted)
  // 고른 칸 계산 (숫자만 합계·평균·최소·최대)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => selectionStats(sel, cellAt), [sel, pending, data])
  if (!conn) return null
  const keyKind = data?.key.kind

  return (
    <div className="data-view">
      <div className="data-bar toolbar">
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
        <button className="tbtn icon" title={t('새로고침')} onClick={() => void reload()}><RefreshCw className={loading ? 'spin' : ''} /></button>
        <span className="bar-sep" />
        {readOnly ? (
          <span className="chip" title={noRowEdit && !connReadOnly && objKind !== 'view' ? t('바꾸려면 SQL 편집기에서 ALTER TABLE … UPDATE/DELETE를 써 주세요') : undefined}>
            <Lock />{connReadOnly ? t('읽기 전용 접속') : objKind === 'view' ? t('뷰는 읽기 전용') : t('이 DB는 표에서 직접 고칠 수 없어요')}
          </span>
        ) : (
          <>
            <button className="tbtn" onClick={addRow} disabled={!data}><Plus />{t('행 추가')}</button>
            <button className="tbtn" onClick={() => { const s = grid.current?.selection(); if (s) deleteRows(rowsOf(s)) }} disabled={!data}><Trash2 />{t('행 삭제')}</button>
            <button className="tbtn" onClick={doUndo} disabled={!undo.length} title={t('마지막 변경 되돌리기 (Ctrl+Z)')}><Undo2 />{t('되돌리기')}</button>
            <button className="tbtn" onClick={() => change(() => EMPTY)} disabled={!changes} title={t('저장하지 않은 변경을 모두 버리기')}><Eraser />{t('모두 되돌리기')}</button>
            <button className={`tbtn ${changes ? 'primary' : ''}`} onClick={save} disabled={!changes} title={t('실행할 SQL을 미리 보고 저장 (Ctrl+S)')}>
              <Save />{changes ? t('저장 ({n})', { n: changes }) : t('저장')}
            </button>
          </>
        )}
        <span className="spacer" />
        <button className={`tbtn ${record ? 'on' : ''}`} disabled={!data} title={t('고른 행을 세로로 보기 (열 이름 · 값)')} onClick={() => {
          if (!record) setRecRow(sel?.r0 ?? 0)
          else window.setTimeout(() => grid.current?.select(recRow, sel?.c0 ?? 0), 30)
          setRecord(!record)
        }}><TableProperties />{t('세로 보기')}</button>
        <span className="bar-sep" />
        <button className="tbtn" onClick={doExport} disabled={!data} title={t('CSV·엑셀·JSON 등으로 내보내기')}><Download />{t('내보내기')}</button>
        <button className="tbtn" onClick={() => conn && ui.open((close) => <DumpDialog conn={conn} db={target.db} schema={target.schema} only={target.table} onClose={close} />)} title={t('이 표를 CREATE·INSERT 문으로 내보내기')}><DatabaseBackup />SQL</button>
        {!(objKind === 'view' || connReadOnly) && <button className="tbtn" onClick={doImport}><Upload />{t('가져오기')}</button>}
      </div>
      {keyKind === 'all' && !readOnly && <div className="banner warn"><KeyRound />{t('기본 키가 없는 표예요. 고치거나 지울 때 모든 열 값이 같은 행 하나를 찾아요.')}</div>}
      {error && <div className="banner error">{error}</div>}
      {data && record ? (
        <RecordView
          columns={columns}
          row={recRow}
          rowCount={rowCount}
          cell={cellAt}
          label={(r) => (r >= base.length ? '+' : String(r + 1))}
          onRow={(r) => setRecRow(Math.max(0, Math.min(rowCount - 1, r)))}
          onOpen={editValue}
          cellClass={(r, c) => (r >= base.length ? 'added' : deleted.has(r) ? 'deleted' : pending.edits[r] && c in pending.edits[r] ? 'edited' : '')}
        />
      ) : data ? (
        <Grid
          onSelect={setSel}
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
              ...(one && sel.r0 < base.length ? followFk(sel.r0, sel.c0).map((f) => ({ label: f.label, icon: Link2, onClick: f.run })) : []),
              one && { label: readOnly ? t('값 보기…') : t('값 보기·고치기…'), icon: Pencil, onClick: () => editValue(sel.r0, sel.c0) },
              sel.r0 < base.length && 'sep',
              sel.r0 < base.length && { label: t('INSERT 문으로 복사'), icon: FileCode2, onClick: () => copyAsSql(rows, 'insert') },
              sel.r0 < base.length && { label: t('UPDATE 문으로 복사'), onClick: () => copyAsSql(rows, 'update') },
              sel.r0 < base.length && { label: t('DELETE 문으로 복사'), onClick: () => copyAsSql(rows, 'delete') },
              !readOnly && 'sep',
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
            {!record && <StatsText stats={stats} />}
            {changes > 0 && <span className="pending-chip">{t('저장 안 한 변경 {n}건', { n: changes })}</span>}
          </>
        )}
      </div>
    </div>
  )
}
