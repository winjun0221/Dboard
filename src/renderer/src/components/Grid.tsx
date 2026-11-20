// 결과 표: 보이는 행만 그리기(수만 행도 가볍게), 칸 고르기(끌기·Shift), 열 너비 조절, 머리글 눌러 정렬, 칸 고치기, 복사
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type Ref } from 'react'
import { ArrowDown, ArrowUp, KeyRound } from 'lucide-react'
import { isBin, type Cell, type SortKey } from '../../../shared/types'
import { cellCopy, cellDisplay, cellText, isNumericType } from '../format'
import { api } from '../api'
import { t } from '../i18n'

export interface GridColumn {
  name: string
  type: string
  pk?: boolean
}

/** 고른 칸 범위 (r0 ≤ r1, c0 ≤ c1) */
export interface Sel {
  r0: number
  c0: number
  r1: number
  c1: number
}

export interface GridHandle {
  selection(): Sel | null
  copy(withHeader: boolean): void
  focus(): void
  /** 칸 고치기 시작 */
  edit(r: number, c: number): void
  select(r: number, c: number): void
}

export interface GridProps {
  columns: GridColumn[]
  rowCount: number
  cell(r: number, c: number): Cell
  cellClass?(r: number, c: number): string
  rowClass?(r: number): string
  rowLabel?(r: number): string
  /** 값 대신 보여 줄 글 (새 행의 DEFAULT 등) */
  textOf?(r: number, c: number): string | undefined
  sort?: SortKey[]
  onSort?(column: string, add: boolean): void
  canEdit?(r: number, c: number): boolean
  onEdit?(r: number, c: number, v: Cell): void
  onMenu?(e: MouseEvent, sel: Sel): void
  /** 표가 먼저 받는 키 (Delete, Ctrl+Z 등). 처리했으면 true */
  onKey?(e: KeyboardEvent, sel: Sel | null): boolean
  handle?: Ref<GridHandle>
  /** 열 너비 기억용 이름 (같은 이름이면 너비를 다시 계산하지 않음) */
  widthKey?: string
  empty?: string
}

const ROW_H = 24
const HEAD_H = 32
const MIN_W = 56
const MAX_W = 420

function autoWidths(columns: GridColumn[], rowCount: number, cell: (r: number, c: number) => Cell): number[] {
  const n = Math.min(rowCount, 60)
  return columns.map((col, c) => {
    let w = Math.max(col.name.length * 7.6, col.type.length * 6.2) + 40
    for (let r = 0; r < n; r++) w = Math.max(w, Math.min(cellDisplay(cell(r, c)).length, 60) * 7.2 + 22)
    return Math.round(Math.max(MIN_W, Math.min(MAX_W, w)))
  })
}

export function Grid(p: GridProps) {
  const { columns, rowCount, cell } = p
  const box = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const [viewH, setViewH] = useState(600)
  const [widths, setWidths] = useState<number[]>(() => autoWidths(columns, rowCount, cell))
  const widthSig = useRef(p.widthKey ?? columns.map((c) => c.name).join('\u0000'))
  const [anchor, setAnchor] = useState<[number, number] | null>(null)
  const [focusCell, setFocusCell] = useState<[number, number] | null>(null)
  const [editing, setEditing] = useState<{ r: number; c: number; value: string; dirty: boolean } | null>(null)
  const dragging = useRef(false)

  // 열이 바뀌면(다른 결과) 너비 다시
  useEffect(() => {
    const sig = p.widthKey ?? columns.map((c) => c.name).join('\u0000')
    if (sig !== widthSig.current || widths.length !== columns.length) {
      widthSig.current = sig
      setWidths(autoWidths(columns, rowCount, cell))
      setAnchor(null)
      setFocusCell(null)
      setEditing(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, p.widthKey])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const numW = Math.max(46, String(rowCount).length * 8 + 22)
  const lefts = useMemo(() => {
    const out: number[] = []
    let x = numW
    for (const w of widths) {
      out.push(x)
      x += w
    }
    out.push(x)
    return out
  }, [widths, numW])
  const totalW = lefts[lefts.length - 1] ?? numW

  const sel: Sel | null = anchor && focusCell
    ? { r0: Math.min(anchor[0], focusCell[0]), r1: Math.max(anchor[0], focusCell[0]), c0: Math.min(anchor[1], focusCell[1]), c1: Math.max(anchor[1], focusCell[1]) }
    : null
  const inSel = (r: number, c: number) => !!sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1

  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - 6)
  const last = Math.min(rowCount, Math.ceil((scroll.top + viewH) / ROW_H) + 6)

  const scrollInto = useCallback((r: number, c: number) => {
    const el = box.current
    if (!el) return
    const top = r * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight - HEAD_H) el.scrollTop = top + ROW_H - el.clientHeight + HEAD_H + 2
    const l = lefts[c]
    const rgt = lefts[c + 1]
    if (l - numW < el.scrollLeft) el.scrollLeft = l - numW
    else if (rgt > el.scrollLeft + el.clientWidth) el.scrollLeft = rgt - el.clientWidth + 2
  }, [lefts, numW])

  const moveTo = (r: number, c: number, extend: boolean) => {
    const rr = Math.max(0, Math.min(rowCount - 1, r))
    const cc = Math.max(0, Math.min(columns.length - 1, c))
    if (rowCount === 0 || columns.length === 0) return
    setFocusCell([rr, cc])
    if (!extend || !anchor) setAnchor([rr, cc])
    scrollInto(rr, cc)
  }

  const copy = useCallback((withHeader: boolean) => {
    if (!sel) return
    const lines: string[] = []
    if (withHeader) lines.push(columns.slice(sel.c0, sel.c1 + 1).map((c) => c.name).join('\t'))
    for (let r = sel.r0; r <= sel.r1; r++) {
      const row: string[] = []
      for (let c = sel.c0; c <= sel.c1; c++) row.push(cellCopy(cell(r, c)))
      lines.push(row.join('\t'))
    }
    void api.copyText(lines.join('\r\n'))
  }, [sel, columns, cell])

  const startEdit = (r: number, c: number, initial?: string) => {
    if (!p.canEdit?.(r, c)) return
    const v = cell(r, c)
    if (v !== null && isBin(v)) return
    setEditing({ r, c, value: initial ?? (v === null ? '' : cellText(v)), dirty: initial !== undefined })
    scrollInto(r, c)
  }

  const commit = (move: 'down' | 'right' | null) => {
    if (!editing) return
    const { r, c, value, dirty } = editing
    setEditing(null)
    if (dirty) p.onEdit?.(r, c, value)
    if (move === 'down') moveTo(r + 1, c, false)
    else if (move === 'right') moveTo(r, c + 1, false)
    box.current?.focus()
  }

  useImperativeHandle(p.handle, () => ({
    selection: () => sel,
    copy,
    focus: () => box.current?.focus(),
    edit: (r, c) => startEdit(r, c),
    select: (r, c) => moveTo(r, c, false),
  }))

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return
    if (p.onKey?.(e, sel)) {
      e.preventDefault()
      return
    }
    const mod = e.ctrlKey || e.metaKey
    const [r, c] = focusCell ?? [0, 0]
    const page = Math.max(1, Math.floor((viewH - HEAD_H) / ROW_H) - 1)
    let handled = true
    switch (e.key) {
      case 'ArrowDown': moveTo(mod ? rowCount - 1 : r + 1, c, e.shiftKey); break
      case 'ArrowUp': moveTo(mod ? 0 : r - 1, c, e.shiftKey); break
      case 'ArrowRight': moveTo(r, mod ? columns.length - 1 : c + 1, e.shiftKey); break
      case 'ArrowLeft': moveTo(r, mod ? 0 : c - 1, e.shiftKey); break
      case 'PageDown': moveTo(r + page, c, e.shiftKey); break
      case 'PageUp': moveTo(r - page, c, e.shiftKey); break
      case 'Home': moveTo(mod ? 0 : r, 0, e.shiftKey); break
      case 'End': moveTo(mod ? rowCount - 1 : r, columns.length - 1, e.shiftKey); break
      case 'Tab': moveTo(r, c + (e.shiftKey ? -1 : 1), false); break
      case 'Enter':
      case 'F2':
        if (focusCell) startEdit(r, c)
        break
      default:
        if (mod && (e.key === 'a' || e.key === 'A')) {
          if (rowCount && columns.length) {
            setAnchor([0, 0])
            setFocusCell([rowCount - 1, columns.length - 1])
          }
        } else if (mod && (e.key === 'c' || e.key === 'C')) copy(e.shiftKey)
        else if (!mod && !e.altKey && e.key.length === 1 && focusCell && p.canEdit?.(r, c)) startEdit(r, c, e.key)
        else handled = false
    }
    if (handled) e.preventDefault()
  }

  useEffect(() => {
    const up = () => {
      dragging.current = false
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const cellDown = (e: MouseEvent, r: number, c: number) => {
    if (e.button === 2) {
      if (!inSel(r, c)) {
        setAnchor([r, c])
        setFocusCell([r, c])
      }
      return
    }
    if (e.button !== 0) return
    if (editing) commit(null)
    if (e.shiftKey && anchor) setFocusCell([r, c])
    else {
      setAnchor([r, c])
      setFocusCell([r, c])
    }
    dragging.current = true
    box.current?.focus()
  }

  const rowDown = (e: MouseEvent, r: number) => {
    if (e.button !== 0 && !(e.button === 2 && !(sel && r >= sel.r0 && r <= sel.r1))) return
    if (e.shiftKey && anchor) setFocusCell([r, columns.length - 1])
    else {
      setAnchor([r, 0])
      setFocusCell([r, columns.length - 1])
    }
    box.current?.focus()
  }

  // 열 너비 끌기
  const resizeStart = (e: MouseEvent, c: number) => {
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX
    const w0 = widths[c]
    const move = (ev: globalThis.MouseEvent) => {
      if ((ev.buttons & 1) !== 1) return
      const w = Math.max(40, Math.min(1200, w0 + ev.clientX - x0))
      setWidths((ws) => ws.map((x, i) => (i === c ? w : x)))
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing-col')
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    document.body.classList.add('resizing-col')
  }

  const numeric = useMemo(() => columns.map((c) => isNumericType(c.type)), [columns])
  const sortOf = (name: string) => p.sort?.find((s) => s.column === name)

  const rows = []
  for (let r = first; r < last; r++) {
    const cells = []
    for (let c = 0; c < columns.length; c++) {
      const v = cell(r, c)
      const cls = ['g-cell']
      if (v === null) cls.push('null')
      else if (typeof v === 'object') cls.push('bin')
      else if (typeof v === 'number' || numeric[c]) cls.push('num')
      if (inSel(r, c)) cls.push('sel')
      if (focusCell && focusCell[0] === r && focusCell[1] === c) cls.push('focus')
      const extra = p.cellClass?.(r, c)
      if (extra) cls.push(extra)
      cells.push(
        <div key={c} className={cls.join(' ')} style={{ width: widths[c] }}
          onMouseDown={(e) => cellDown(e, r, c)}
          onMouseEnter={() => { if (dragging.current) setFocusCell([r, c]) }}
          onDoubleClick={() => startEdit(r, c)}>
          {p.textOf?.(r, c) ?? cellDisplay(v)}
        </div>,
      )
    }
    const isSelRow = !!sel && r >= sel.r0 && r <= sel.r1
    rows.push(
      <div key={r} className={`g-row ${p.rowClass?.(r) ?? ''} ${r % 2 ? 'odd' : ''}`} style={{ top: HEAD_H + r * ROW_H, width: totalW }}>
        <div className={`g-num ${isSelRow ? 'sel' : ''}`} style={{ width: numW }} onMouseDown={(e) => rowDown(e, r)}>{p.rowLabel?.(r) ?? r + 1}</div>
        {cells}
      </div>,
    )
  }

  return (
    <div
      ref={box}
      className="grid"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget
        setScroll({ top: el.scrollTop, left: el.scrollLeft })
      }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (!p.onMenu || !sel) return
        e.preventDefault()
        p.onMenu(e, sel)
      }}
    >
      <div className="g-inner" style={{ width: totalW, height: HEAD_H + rowCount * ROW_H + 8 }}>
        <div className="g-head" style={{ width: totalW, height: HEAD_H }}>
          <div className="g-num g-corner" style={{ width: numW }} title={t('모두 고르기')} onMouseDown={() => {
            if (rowCount && columns.length) {
              setAnchor([0, 0])
              setFocusCell([rowCount - 1, columns.length - 1])
              box.current?.focus()
            }
          }} />
          {columns.map((col, c) => {
            const s = sortOf(col.name)
            return (
              <div key={c} className={`g-hcell ${p.onSort ? 'sortable' : ''} ${sel && c >= sel.c0 && c <= sel.c1 ? 'sel' : ''}`} style={{ width: widths[c] }}
                title={`${col.name}${col.type ? ' · ' + col.type : ''}${p.onSort ? '\n' + t('눌러서 정렬 (Shift: 여러 열)') : ''}`}
                onClick={(e) => p.onSort?.(col.name, e.shiftKey)}>
                <span className="g-hname">
                  {col.pk && <KeyRound className="pk-icon" />}
                  <span className="ellipsis">{col.name}</span>
                  {s && (s.desc ? <ArrowDown className="sort-icon" /> : <ArrowUp className="sort-icon" />)}
                </span>
                <span className="g-htype ellipsis">{col.type}</span>
                <span className="g-resize" onMouseDown={(e) => resizeStart(e, c)} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => {
                  e.stopPropagation()
                  const w = autoWidths([col], rowCount, (r) => cell(r, c))[0]
                  setWidths((ws) => ws.map((x, i) => (i === c ? w : x)))
                }} />
              </div>
            )
          })}
        </div>
        {rows}
        {editing && (
          <input
            className="g-editor"
            autoFocus
            style={{ left: lefts[editing.c], top: HEAD_H + editing.r * ROW_H, width: Math.max(widths[editing.c], 160), height: ROW_H }}
            value={editing.value}
            onFocus={(e) => { if (!editing.dirty) e.currentTarget.select() }}
            onChange={(e) => setEditing({ ...editing, value: e.target.value, dirty: true })}
            onBlur={() => commit(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit('down') }
              else if (e.key === 'Tab') { e.preventDefault(); commit('right') }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); box.current?.focus() }
              e.stopPropagation()
            }}
          />
        )}
      </div>
      {rowCount === 0 && <div className="g-empty">{p.empty ?? t('행이 없어요')}</div>}
    </div>
  )
}
