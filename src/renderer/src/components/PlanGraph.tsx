// 실행 계획 그림: 들여쓴 계획 글(PostgreSQL·MySQL TREE·SQLite·SQL Server SHOWPLAN_TEXT)을 나무로 읽어 상자로 그린다. 비용이 큰 단계일수록 막대가 길다
import type { Dialect } from '../../../shared/types'
import { t } from '../i18n'

export interface PlanNode {
  label: string
  /** 조건·출력 같은 덧붙은 줄 */
  details: string[]
  cost: number | null
  rows: number | null
  children: PlanNode[]
}

const MARK = /^(\s*)(->\s+|└─\s*|\|--)/

function node(text: string, d: Dialect): PlanNode {
  let label = text.trim()
  let cost: number | null = null
  let rows: number | null = null
  const pg = /\s*\(cost=([\d.]+)\.\.([\d.]+) rows=(\d+)[^)]*\)/.exec(label)
  const my = /\s*\(cost=([\d.e+]+)(?: rows=([\d.e+]+))?\)/.exec(label)
  if (d === 'postgres' && pg) {
    cost = Number(pg[2])
    rows = Number(pg[3])
    label = label.replace(pg[0], '')
  } else if (my) {
    cost = Number(my[1])
    rows = my[2] ? Number(my[2]) : null
    label = label.replace(my[0], '')
  }
  return { label: label.trim(), details: [], cost, rows, children: [] }
}

/** 계획 글 → 나무 (뿌리 여러 개일 수 있음). 알아볼 수 없으면 빈 배열 */
export function parsePlan(text: string, d: Dialect): PlanNode[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const roots: PlanNode[] = []
  const stack: { depth: number; n: PlanNode }[] = []
  const hasMarks = lines.some((l) => MARK.test(l))
  lines.forEach((line, i) => {
    const m = MARK.exec(line)
    let depth: number
    let body: string
    if (m) {
      depth = m[1].length + 1
      body = line.slice(m[0].length)
    } else if (d === 'mssql' && hasMarks) {
      return // SQL Server: 맨 위 줄은 문장 글
    } else if (d === 'postgres' && i > 0 && stack.length) {
      stack[stack.length - 1].n.details.push(line.trim()) // 조건 줄
      return
    } else {
      depth = line.length - line.trimStart().length
      body = line
    }
    const n = node(body, d)
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    if (stack.length) stack[stack.length - 1].n.children.push(n)
    else roots.push(n)
    stack.push({ depth, n })
  })
  return roots
}

function Node({ n, max }: { n: PlanNode; max: number }) {
  const share = n.cost !== null && max > 0 ? n.cost / max : null
  const heavy = share !== null && share >= 0.5
  return (
    <li>
      <div className={`plan-node ${heavy ? 'heavy' : ''}`} title={[n.label, ...n.details].join('\n')}>
        <div className="plan-label">{n.label}</div>
        {(n.cost !== null || n.rows !== null) && (
          <div className="plan-meta">
            {n.cost !== null && <span>{t('비용 {n}', { n: n.cost.toLocaleString('en-US', { maximumFractionDigits: 2 }) })}</span>}
            {n.rows !== null && <span>{t('행 {n}', { n: n.rows.toLocaleString('en-US', { maximumFractionDigits: 0 }) })}</span>}
          </div>
        )}
        {share !== null && <div className="plan-bar"><span style={{ width: `${Math.max(3, Math.round(share * 100))}%` }} /></div>}
        {n.details.slice(0, 4).map((x, i) => <div key={i} className="plan-detail mono">{x}</div>)}
        {n.details.length > 4 && <div className="plan-detail muted">{t('… {n}줄 더', { n: n.details.length - 4 })}</div>}
      </div>
      {n.children.length > 0 && <ul>{n.children.map((c, i) => <Node key={i} n={c} max={max} />)}</ul>}
    </li>
  )
}

export function PlanGraph({ roots }: { roots: PlanNode[] }) {
  let max = 0
  const walk = (n: PlanNode) => {
    if (n.cost !== null) max = Math.max(max, n.cost)
    n.children.forEach(walk)
  }
  roots.forEach(walk)
  return (
    <div className="plan-graph">
      <ul className="plan-tree">{roots.map((r, i) => <Node key={i} n={r} max={max} />)}</ul>
    </div>
  )
}
