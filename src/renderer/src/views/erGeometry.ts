// ER 다이어그램 계산: 표 상자 크기, 자동 배치(참조되는 표는 왼쪽, 참조하는 표는 오른쪽), 선 모양, SVG 파일 글
import type { ErModel, ErTable } from '../../../shared/types'

export type ErMode = 'all' | 'keys' | 'none'
export interface Pos { x: number; y: number }
export interface Box extends Pos { w: number; h: number }
export type Measure = (text: string, bold?: boolean) => number

export const HEAD = 28
export const ROW = 20
const PAD = 6
const GAP_X = 96
const GAP_Y = 28
const COLUMN_MAX_H = 1800

/** 표마다 외래 키 열 이름 */
export function fkColumns(model: ErModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const l of model.links) {
    const set = out.get(l.from) ?? new Set<string>()
    for (const c of l.fromColumns) set.add(c)
    out.set(l.from, set)
  }
  return out
}

export function visibleColumns(t: ErTable, fk: Set<string> | undefined, mode: ErMode) {
  if (mode === 'none') return []
  if (mode === 'keys') return t.columns.filter((c) => c.pk || fk?.has(c.name))
  return t.columns
}

export function boxSize(t: ErTable, cols: ErTable['columns'], measure: Measure): { w: number; h: number } {
  let w = measure(t.name, true) + 44
  for (const c of cols) w = Math.max(w, 26 + measure(c.name) + 18 + measure(c.type) + 12)
  return { w: Math.round(Math.min(420, Math.max(150, w))), h: HEAD + cols.length * ROW + (cols.length ? PAD : 0) }
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** 자동 배치: 외래 키로 이어진 표는 단계(참조 깊이)마다 세로 줄로, 이어지지 않은 표는 아래에 격자로 */
export function autoLayout(model: ErModel, sizes: Map<string, { w: number; h: number }>): Map<string, Pos> {
  const parents = new Map<string, Set<string>>()
  const linked = new Set<string>()
  for (const l of model.links) {
    if (l.from === l.to) continue
    const set = parents.get(l.from) ?? new Set<string>()
    set.add(l.to)
    parents.set(l.from, set)
    linked.add(l.from)
    linked.add(l.to)
  }
  const level = new Map<string, number>()
  const visiting = new Set<string>()
  const levelOf = (t: string): number => {
    const known = level.get(t)
    if (known !== undefined) return known
    if (visiting.has(t)) return 0 // 서로 참조(고리)는 끊는다
    visiting.add(t)
    let lv = 0
    for (const p of parents.get(t) ?? []) lv = Math.max(lv, levelOf(p) + 1)
    visiting.delete(t)
    level.set(t, lv)
    return lv
  }
  const names = model.tables.map((t) => t.name)
  const columns: string[][] = []
  for (const n of names.filter((x) => linked.has(x))) (columns[levelOf(n)] ??= []).push(n)

  const pos = new Map<string, Pos>()
  const order = new Map<string, number>()
  let x = 0
  let maxY = 0
  let maxX = 0
  for (const raw of columns) {
    if (!raw?.length) continue
    // 부모들의 평균 위치 순서로 (선이 덜 엇갈리게)
    const key = (n: string) => {
      const ps = [...(parents.get(n) ?? [])].map((p) => order.get(p)).filter((v): v is number => v !== undefined)
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Number.MAX_SAFE_INTEGER
    }
    const col = [...raw].sort((a, b) => key(a) - key(b) || byName(a, b))
    // 너무 길면 여러 줄로 나눈다
    const chunks: string[][] = [[]]
    let h = 0
    for (const n of col) {
      const sz = sizes.get(n)!
      if (h > 0 && h + sz.h > COLUMN_MAX_H) {
        chunks.push([])
        h = 0
      }
      chunks[chunks.length - 1].push(n)
      h += sz.h + GAP_Y
    }
    for (const chunk of chunks) {
      let y = 0
      let w = 0
      for (const n of chunk) {
        const sz = sizes.get(n)!
        pos.set(n, { x, y })
        order.set(n, order.size)
        y += sz.h + GAP_Y
        w = Math.max(w, sz.w)
      }
      maxY = Math.max(maxY, y)
      x += w + GAP_X
      maxX = x
    }
  }
  // 이어지지 않은 표: 아래쪽 격자
  const loose = names.filter((n) => !linked.has(n)).sort(byName)
  const rowLimit = Math.max(1400, maxX)
  let gx = 0
  let gy = pos.size ? maxY + 60 : 0
  let rowH = 0
  for (const n of loose) {
    const sz = sizes.get(n)!
    if (gx > 0 && gx + sz.w > rowLimit) {
      gx = 0
      gy += rowH + GAP_Y
      rowH = 0
    }
    pos.set(n, { x: gx, y: gy })
    gx += sz.w + 40
    rowH = Math.max(rowH, sz.h)
  }
  return pos
}

/** 열 줄의 가운데 y (안 보이는 열이면 머리 가운데) */
export const rowY = (b: Box, index: number) => (index < 0 ? b.y + HEAD / 2 : b.y + HEAD + index * ROW + ROW / 2)

/** 외래 키 선: 자식(from) → 부모(to). 가로로 나가서 곡선으로 */
export function linkPath(a: Box, ai: number, b: Box, bi: number): string {
  const y1 = rowY(a, ai)
  const y2 = rowY(b, bi)
  if (a === b) {
    const x = a.x + a.w
    return `M ${x} ${y1} C ${x + 40} ${y1}, ${x + 40} ${y2}, ${x} ${y2}`
  }
  const right = a.x + a.w / 2 < b.x + b.w / 2
  const x1 = right ? a.x + a.w : a.x
  const x2 = right ? b.x : b.x + b.w
  const dx = Math.max(30, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + (right ? dx : -dx)} ${y1}, ${x2 + (right ? -dx : dx)} ${y2}, ${x2} ${y2}`
}

export function bounds(boxes: Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 파일로 저장할 SVG (밝은 색 고정, 글꼴은 시스템 글꼴) */
export function toSvg(model: ErModel, boxes: Map<string, Box>, mode: ErMode): string {
  const fks = fkColumns(model)
  const all = [...boxes.values()]
  const bb = bounds(all)
  const m = 24
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(bb.w + m * 2)}" height="${Math.ceil(bb.h + m * 2)}" viewBox="${bb.x - m} ${bb.y - m} ${Math.ceil(bb.w + m * 2)} ${Math.ceil(bb.h + m * 2)}" font-family="Segoe UI, Malgun Gothic, sans-serif" font-size="12">`)
  out.push(`<rect x="${bb.x - m}" y="${bb.y - m}" width="${bb.w + m * 2}" height="${bb.h + m * 2}" fill="#ffffff"/>`)
  out.push('<defs><marker id="many" viewBox="0 0 12 12" refX="0" refY="6" markerWidth="12" markerHeight="12" orient="auto"><path d="M0 1 L11 6 L0 11 M0 6 L11 6" fill="none" stroke="#8a919c" stroke-width="1.2"/></marker>')
  out.push('<marker id="one" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto"><path d="M7 1 L7 11 M10 1 L10 11" fill="none" stroke="#8a919c" stroke-width="1.2"/></marker></defs>')
  for (const l of model.links) {
    const a = boxes.get(l.from)
    const b = boxes.get(l.to)
    if (!a || !b) continue
    const fa = visibleColumns(model.tables.find((t) => t.name === l.from)!, fks.get(l.from), mode)
    const fb = visibleColumns(model.tables.find((t) => t.name === l.to)!, fks.get(l.to), mode)
    const d = linkPath(a, fa.findIndex((c) => c.name === l.fromColumns[0]), b, fb.findIndex((c) => c.name === l.toColumns[0]))
    out.push(`<path d="${d}" fill="none" stroke="#8a919c" stroke-width="1.2" marker-start="url(#many)" marker-end="url(#one)"/>`)
  }
  for (const t of model.tables) {
    const b = boxes.get(t.name)
    if (!b) continue
    const cols = visibleColumns(t, fks.get(t.name), mode)
    out.push(`<g><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="#ffffff" stroke="#c9ced6"/>`)
    out.push(`<path d="M ${b.x} ${b.y + HEAD} H ${b.x + b.w}" stroke="#c9ced6"/><rect x="${b.x + 0.5}" y="${b.y + 0.5}" width="${b.w - 1}" height="${HEAD - 1}" rx="6" fill="#eef2f8"/>`)
    out.push(`<text x="${b.x + 10}" y="${b.y + HEAD / 2 + 4}" font-weight="700" fill="#1f2328">${esc(t.name)}</text>`)
    cols.forEach((c, i) => {
      const y = b.y + HEAD + i * ROW + ROW / 2 + 4
      const fk = fks.get(t.name)?.has(c.name)
      out.push(`<text x="${b.x + 10}" y="${y}" fill="${c.pk ? '#b7791f' : fk ? '#2f6fd6' : '#1f2328'}" font-weight="${c.pk ? 700 : 400}">${esc(c.name)}</text>`)
      out.push(`<text x="${b.x + b.w - 10}" y="${y}" fill="#8a919c" text-anchor="end">${esc(c.type)}</text>`)
    })
    out.push('</g>')
  }
  out.push('</svg>')
  return out.join('\n')
}
