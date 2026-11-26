// 결과·데이터 표에 붙는 것: 고른 칸 계산(개수·합계·평균·최소·최대), 행 하나를 세로로 보기
import { ChevronLeft, ChevronRight, KeyRound, Link2 } from 'lucide-react'
import type { Cell } from '../../../shared/types'
import { cellText } from '../format'
import { t } from '../i18n'
import type { GridColumn, Sel } from './Grid'

/** 너무 많이 고르면(예: Ctrl+A로 수백만 칸) 계산하지 않는다 */
const MAX_CELLS = 500_000
const NUM = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i

export interface Stats {
  cells: number
  nums: number
  sum: number
  min: number
  max: number
}

export function selectionStats(sel: Sel | null, cell: (r: number, c: number) => Cell): Stats | null {
  if (!sel) return null
  const cells = (sel.r1 - sel.r0 + 1) * (sel.c1 - sel.c0 + 1)
  if (cells < 2 || cells > MAX_CELLS) return cells > MAX_CELLS ? { cells, nums: 0, sum: 0, min: 0, max: 0 } : null
  let nums = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (let r = sel.r0; r <= sel.r1; r++) {
    for (let c = sel.c0; c <= sel.c1; c++) {
      const v = cell(r, c)
      const n = typeof v === 'number' ? v : typeof v === 'string' && NUM.test(v.trim()) ? Number(v) : NaN
      if (!Number.isFinite(n)) continue
      nums++
      sum += n
      if (n < min) min = n
      if (n > max) max = n
    }
  }
  return { cells, nums, sum, min, max }
}

const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 6 }))

export function StatsText({ stats }: { stats: Stats | null }) {
  if (!stats) return null
  if (stats.nums === 0) return <span className="sel-stats">{t('{n}칸 고름', { n: num(stats.cells) })}</span>
  return (
    <span className="sel-stats" title={t('고른 칸 중 숫자만 계산해요')}>
      {t('{n}칸', { n: num(stats.cells) })}
      <span>{t('합계')} <b>{num(stats.sum)}</b></span>
      <span>{t('평균')} <b>{num(stats.sum / stats.nums)}</b></span>
      <span>{t('최소')} <b>{num(stats.min)}</b></span>
      <span>{t('최대')} <b>{num(stats.max)}</b></span>
    </span>
  )
}

/** 행 하나를 세로로 (열 이름 · 값). 값을 누르면 onOpen(값 보기·고치기) */
export function RecordView({ columns, row, rowCount, cell, label, onRow, onOpen, cellClass }: {
  columns: GridColumn[]
  row: number
  rowCount: number
  cell: (r: number, c: number) => Cell
  label?: (r: number) => string
  onRow: (r: number) => void
  onOpen?: (r: number, c: number) => void
  cellClass?: (r: number, c: number) => string
}) {
  if (rowCount === 0) return <div className="center-fill">{t('행이 없어요')}</div>
  const r = Math.max(0, Math.min(rowCount - 1, row))
  return (
    <div className="record-view" tabIndex={0} onKeyDown={(e) => {
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') onRow(Math.max(0, r - 1))
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') onRow(Math.min(rowCount - 1, r + 1))
      else return
      e.preventDefault()
    }}>
      <div className="record-head">
        <button type="button" className="tbtn icon" onClick={() => onRow(r - 1)} disabled={r === 0} title={t('앞 행 (←)')}><ChevronLeft /></button>
        <span>{t('행 {n} / {total}', { n: label?.(r) ?? r + 1, total: rowCount })}</span>
        <button type="button" className="tbtn icon" onClick={() => onRow(r + 1)} disabled={r >= rowCount - 1} title={t('다음 행 (→)')}><ChevronRight /></button>
      </div>
      <div className="record-body">
        <table className="record-table">
          <tbody>
            {columns.map((col, c) => {
              const v = cell(r, c)
              return (
                <tr key={c}>
                  <th>
                    <span className="with-icon">{col.pk && <KeyRound className="pk-icon" />}{col.fk && <Link2 className="fk-icon" />}{col.name}</span>
                    <span className="g-htype">{col.type}</span>
                  </th>
                  <td className={`${v === null ? 'null' : ''} ${cellClass?.(r, c) ?? ''}`} onDoubleClick={() => onOpen?.(r, c)} title={onOpen ? t('더블클릭: 값 보기·고치기') : undefined}>
                    {v === null ? 'NULL' : cellText(v)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
