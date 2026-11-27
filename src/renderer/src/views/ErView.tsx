// ER 다이어그램 탭: 표 상자와 외래 키 선. 끌어서 옮기기(위치 기억), 바탕 끌기·가운데 단추로 이동, Ctrl+휠 확대, 맞추기, 찾기, 그림 저장
import { useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type WheelEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Expand, FileCode2, ImageDown, KeyRound, LayoutGrid, Link2, LoaderCircle, Minus, PencilRuler, Plus, RefreshCw, Search, Table2, TriangleAlert, X } from 'lucide-react'
import { api, errorText } from '../api'
import { useWs, type ErTab } from '../ws'
import { useUi } from '../ui'
import { t } from '../i18n'
import { autoLayout, bounds, boxSize, fkColumns, linkPath, toSvg, visibleColumns, type Box, type ErMode, type Pos } from './erGeometry'

const posKey = (tab: ErTab) => `dboard.er.${tab.connId}.${tab.db}.${tab.schema}`
const MODE_KEY = 'dboard.er.mode'

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

/** 글자 폭 (상자 크기 계산) */
const canvas = document.createElement('canvas').getContext('2d')
const measure = (text: string, bold = false) => {
  if (!canvas) return text.length * 7
  canvas.font = `${bold ? 700 : 400} 12px "Segoe UI", "Malgun Gothic", sans-serif`
  return canvas.measureText(text).width
}

export function ErView({ tab, active }: { tab: ErTab; active: boolean }) {
  const ws = useWs()
  const ui = useUi()
  const isOn = ws.connected.has(tab.connId)
  const q = useQuery({ queryKey: ['er', tab.connId, tab.db, tab.schema], queryFn: () => api.erModel(tab.connId, tab.db, tab.schema), enabled: isOn && active })
  const [mode, setMode] = useState<ErMode>(() => loadJson<ErMode>(MODE_KEY, 'all'))
  const [saved, setSaved] = useState<Record<string, Pos>>(() => loadJson(posKey(tab), {}))
  const [view, setView] = useState({ x: 20, y: 20, z: 1 })
  const [sel, setSel] = useState<string | null>(tab.focus ?? null)
  const [find, setFind] = useState('')
  const host = useRef<HTMLDivElement>(null)
  const drag = useRef<{ kind: 'pan' | 'move'; name?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const fitted = useRef(false)

  // 관련 표만 보기 (표에서 열었을 때): 그 표 + 바로 이어진 표
  const model = useMemo(() => {
    const m = q.data
    if (!m || !tab.focus) return m
    const keep = new Set([tab.focus])
    for (const l of m.links) {
      if (l.from === tab.focus) keep.add(l.to)
      if (l.to === tab.focus) keep.add(l.from)
    }
    return { ...m, tables: m.tables.filter((x) => keep.has(x.name)), links: m.links.filter((l) => keep.has(l.from) && keep.has(l.to)) }
  }, [q.data, tab.focus])

  const fks = useMemo(() => (model ? fkColumns(model) : new Map<string, Set<string>>()), [model])
  const sizes = useMemo(() => new Map((model?.tables ?? []).map((x) => [x.name, boxSize(x, visibleColumns(x, fks.get(x.name), mode), measure)])), [model, fks, mode])
  const auto = useMemo(() => (model ? autoLayout(model, sizes) : new Map<string, Pos>()), [model, sizes])
  const boxes = useMemo(() => {
    const out = new Map<string, Box>()
    for (const x of model?.tables ?? []) {
      const p = saved[x.name] ?? auto.get(x.name) ?? { x: 0, y: 0 }
      out.set(x.name, { ...p, ...sizes.get(x.name)! })
    }
    return out
  }, [model, saved, auto, sizes])

  const fit = () => {
    const el = host.current
    const bb = bounds([...boxes.values()])
    if (!el || !bb.w) return
    const z = Math.min(1.25, Math.max(0.15, Math.min((el.clientWidth - 40) / bb.w, (el.clientHeight - 40) / bb.h)))
    setView({ z, x: (el.clientWidth - bb.w * z) / 2 - bb.x * z, y: (el.clientHeight - bb.h * z) / 2 - bb.y * z })
  }
  useEffect(() => {
    if (!fitted.current && boxes.size && active) {
      fitted.current = true
      fit()
    }
    // 처음 한 번만 맞춘다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, active])

  const savePositions = (next: Record<string, Pos>) => {
    setSaved(next)
    try {
      localStorage.setItem(posKey(tab), JSON.stringify(next))
    } catch {
      // 기억 못 해도 지금은 그대로
    }
  }
  const zoomAt = (factor: number, cx?: number, cy?: number) => setView((v) => {
    const el = host.current
    const x = cx ?? (el ? el.clientWidth / 2 : 0)
    const y = cy ?? (el ? el.clientHeight / 2 : 0)
    const z = Math.min(2.5, Math.max(0.1, v.z * factor))
    return { z, x: x - ((x - v.x) * z) / v.z, y: y - ((y - v.y) * z) / v.z }
  })
  const centerOn = (name: string) => {
    const b = boxes.get(name)
    const el = host.current
    if (!b || !el) return
    setSel(name)
    setView((v) => ({ ...v, x: el.clientWidth / 2 - (b.x + b.w / 2) * v.z, y: el.clientHeight / 2 - (b.y + b.h / 2) * v.z }))
  }

  const onWheel = (e: WheelEvent) => {
    const r = host.current!.getBoundingClientRect()
    if (e.ctrlKey) zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top)
    else setView((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }))
  }
  const onDown = (e: RPointerEvent, name?: string) => {
    if (e.button === 2) return
    e.stopPropagation()
    const pan = !name || e.button === 1
    const b = name ? boxes.get(name) : undefined
    drag.current = { kind: pan ? 'pan' : 'move', name, sx: e.clientX, sy: e.clientY, ox: pan ? view.x : b!.x, oy: pan ? view.y : b!.y, moved: false }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: RPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    if (d.kind === 'pan') setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }))
    else if (d.name) setSaved((s) => ({ ...s, [d.name!]: { x: Math.round(d.ox + dx / view.z), y: Math.round(d.oy + dy / view.z) } }))
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'move' && d.moved) savePositions({ ...saved })
    else if (!d.moved) setSel(d.kind === 'move' ? d.name ?? null : null)
  }

  const openData = (name: string) => ws.openTable(tab.connId, { db: tab.db, schema: tab.schema, table: name }, 'table', 'data')
  const tableMenu = (e: RMouseEvent, name: string) => {
    e.preventDefault()
    setSel(name)
    const ref = { db: tab.db, schema: tab.schema, table: name }
    ui.menu(e, [
      { label: t('데이터 보기'), icon: Table2, onClick: () => openData(name) },
      { label: t('표 설계'), icon: PencilRuler, onClick: () => ws.openTable(tab.connId, ref, 'table', 'design') },
      { label: t('DDL 보기'), icon: FileCode2, onClick: () => ws.openTable(tab.connId, ref, 'table', 'ddl') },
      { label: t('관련 표만 보기'), icon: Link2, onClick: () => ws.openEr(tab.connId, tab.db, tab.schema, name) },
    ])
  }

  const saveImage = async (kind: 'png' | 'svg') => {
    if (!model) return
    const svg = toSvg(model, boxes, mode)
    const name = `${tab.schema || tab.db || 'er'}${tab.focus ? '-' + tab.focus : ''}`
    try {
      let data = svg
      if (kind === 'png') {
        const img = new Image()
        // 화면 보안 정책(CSP)이 blob: 그림을 막아서 data: 주소로
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error(t('그림을 만들지 못했어요')))
          img.src = url
        })
        const scale = Math.min(2, 16000 / Math.max(img.width, img.height))
        const c = document.createElement('canvas')
        c.width = Math.ceil(img.width * scale)
        c.height = Math.ceil(img.height * scale)
        const g = c.getContext('2d')!
        g.scale(scale, scale)
        g.drawImage(img, 0, 0)
        data = c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
      }
      const file = await api.saveImage(name, kind, data)
      if (file) ui.notify(t('그림을 저장했어요: {name}', { name: file }), 'success')
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  if (!isOn) return <div className="center-fill"><button className="btn" onClick={() => void ws.ensureConnected(tab.connId)}>{t('연결해서 보기')}</button></div>
  if (q.error) return <div className="banner error">{errorText(q.error)}</div>
  if (!model) return <div className="center-fill"><LoaderCircle className="spin big" /></div>

  const related = new Set<string>()
  if (sel) for (const l of model.links) if (l.from === sel || l.to === sel) related.add(l.from === sel ? l.to : l.from)
  const matches = find.trim() ? model.tables.filter((x) => x.name.toLowerCase().includes(find.trim().toLowerCase())).map((x) => x.name) : []

  return (
    <div className="er-view">
      <div className="toolbar er-bar">
        <button className="tbtn" onClick={fit} title={t('전체가 보이게 맞추기')}><Expand />{t('맞추기')}</button>
        <button className="tbtn icon" onClick={() => zoomAt(1 / 1.2)} title={t('축소 (Ctrl+휠)')}><Minus /></button>
        <span className="er-zoom mono">{Math.round(view.z * 100)}%</span>
        <button className="tbtn icon" onClick={() => zoomAt(1.2)} title={t('확대 (Ctrl+휠)')}><Plus /></button>
        <span className="bar-sep" />
        <button className="tbtn" onClick={() => { savePositions({}); fitted.current = false }} title={t('옮긴 위치를 지우고 다시 배치')}><LayoutGrid />{t('자동 배치')}</button>
        <label className="ctx-pick" title={t('상자에 보일 열')}>
          <KeyRound />
          <select value={mode} onChange={(e) => {
            const m = e.target.value as ErMode
            setMode(m)
            try { localStorage.setItem(MODE_KEY, JSON.stringify(m)) } catch { /* 무시 */ }
          }}>
            <option value="all">{t('모든 열')}</option>
            <option value="keys">{t('키 열만')}</option>
            <option value="none">{t('표 이름만')}</option>
          </select>
        </label>
        <span className="bar-sep" />
        <button className="tbtn" onClick={() => void saveImage('png')}><ImageDown />PNG</button>
        <button className="tbtn" onClick={() => void saveImage('svg')}><ImageDown />SVG</button>
        <button className="tbtn icon" onClick={() => void q.refetch()} title={t('새로고침')}><RefreshCw /></button>
        {tab.focus && <button className="tbtn" onClick={() => ws.updateTab(tab.id, { focus: undefined })} title={t('스키마의 모든 표 보기')}><X />{t('관련 표만: {name}', { name: tab.focus })}</button>}
        <span className="spacer" />
        <label className="filter-box small">
          <Search />
          <input value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) centerOn(matches[0]) }} placeholder={t('표 찾기 (Enter)')} spellCheck={false} />
        </label>
        <span className="muted small">{t('표 {n}개 · 관계 {m}개', { n: model.tables.length, m: model.links.length })}</span>
      </div>
      {model.truncated && <div className="banner warn"><TriangleAlert />{t('표가 너무 많아 앞쪽 300개만 그렸어요.')}</div>}
      <div ref={host} className="er-canvas" onWheel={onWheel} onPointerDown={(e) => onDown(e)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {model.tables.length === 0 && <div className="center-fill muted">{t('표가 없어요')}</div>}
        <svg width="100%" height="100%">
          <defs>
            <marker id="er-many" viewBox="0 0 12 12" refX="0" refY="6" markerWidth="12" markerHeight="12" orient="auto"><path className="er-mark" d="M0 1 L11 6 L0 11 M0 6 L11 6" /></marker>
            <marker id="er-one" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto"><path className="er-mark" d="M7 1 L7 11 M10 1 L10 11" /></marker>
          </defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.z})`}>
            {model.links.map((l, i) => {
              const a = boxes.get(l.from)
              const b = boxes.get(l.to)
              if (!a || !b) return null
              const ta = model.tables.find((x) => x.name === l.from)!
              const tb = model.tables.find((x) => x.name === l.to)!
              const ai = visibleColumns(ta, fks.get(l.from), mode).findIndex((c) => c.name === l.fromColumns[0])
              const bi = visibleColumns(tb, fks.get(l.to), mode).findIndex((c) => c.name === l.toColumns[0])
              const on = !!sel && (l.from === sel || l.to === sel)
              return (
                <path key={i} className={`er-link ${on ? 'on' : sel ? 'dim' : ''}`} d={linkPath(a, ai, b, bi)} markerStart="url(#er-many)" markerEnd="url(#er-one)">
                  <title>{`${l.from}(${l.fromColumns.join(', ')}) → ${l.to}(${l.toColumns.join(', ')})`}</title>
                </path>
              )
            })}
            {model.tables.map((x) => {
              const b = boxes.get(x.name)!
              const cols = visibleColumns(x, fks.get(x.name), mode)
              const cls = sel === x.name ? 'sel' : related.has(x.name) ? 'rel' : sel ? 'dim' : ''
              return (
                <g key={x.name} className={`er-table ${cls} ${matches.includes(x.name) ? 'match' : ''}`} transform={`translate(${b.x} ${b.y})`} data-table={x.name}
                  onPointerDown={(e) => onDown(e, x.name)} onDoubleClick={() => openData(x.name)} onContextMenu={(e) => tableMenu(e, x.name)}>
                  <title>{x.comment ? `${x.name} — ${x.comment}` : x.name}</title>
                  <rect className="er-box" width={b.w} height={b.h} rx={6} />
                  <rect className="er-head" x={0.5} y={0.5} width={b.w - 1} height={27} rx={6} />
                  <text className="er-name" x={10} y={18}>{x.name}</text>
                  {cols.length > 0 && <line className="er-sep" x1={0} x2={b.w} y1={28} y2={28} />}
                  {cols.map((c, i) => (
                    <g key={c.name} transform={`translate(0 ${28 + i * 20})`}>
                      <text className={`er-col ${c.pk ? 'pk' : fks.get(x.name)?.has(c.name) ? 'fk' : ''}`} x={10} y={14}>{c.name}</text>
                      <text className="er-type" x={b.w - 10} y={14} textAnchor="end">{c.type}</text>
                    </g>
                  ))}
                </g>
              )
            })}
          </g>
        </svg>
      </div>
    </div>
  )
}
