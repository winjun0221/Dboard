// 실행 계획 (문장은 실행하지 않음 — ANALYZE 없이). DB마다:
// SQLite EXPLAIN QUERY PLAN(나무로 다시 그림) · PostgreSQL EXPLAIN · MySQL EXPLAIN FORMAT=TREE(안 되면 표: MariaDB 등) · SQL Server SHOWPLAN_TEXT
// · Oracle EXPLAIN PLAN + DBMS_XPLAN · ClickHouse·DuckDB EXPLAIN
import type { ExplainResult } from '../shared/types'
import type { Session } from './drivers/base'

export async function explain(s: Session, sql: string): Promise<ExplainResult> {
  const text = sql.trim().replace(/;+\s*$/, '')
  switch (s.dialect) {
    case 'sqlite': {
      const [r] = await s.runManaged('EXPLAIN QUERY PLAN ' + text, 100_000)
      const nodes = (r?.rows ?? []).map((x) => ({ id: Number(x[0]), parent: Number(x[1]), detail: String(x[3] ?? '') }))
      const lines: string[] = []
      const walk = (parent: number, depth: number) => {
        for (const n of nodes.filter((x) => x.parent === parent && x.id !== parent)) {
          lines.push('   '.repeat(Math.max(0, depth - 1)) + (depth ? '└─ ' : '') + n.detail)
          walk(n.id, depth + 1)
        }
      }
      walk(0, 0)
      return { text: lines.join('\n'), result: null }
    }
    case 'postgres': {
      const [r] = await s.runManaged('EXPLAIN ' + text, 100_000)
      return { text: (r?.rows ?? []).map((x) => String(x[0] ?? '')).join('\n'), result: null }
    }
    case 'mysql': {
      try {
        const [r] = await s.runManaged('EXPLAIN FORMAT=TREE ' + text, 100)
        return { text: String(r?.rows[0]?.[0] ?? ''), result: null }
      } catch {
        // MariaDB·오래된 MySQL은 나무 모양이 없다 → 표로
        const [r] = await s.runManaged('EXPLAIN ' + text, 10_000)
        return { text: null, result: r ?? null }
      }
    }
    case 'oracle': {
      // PLAN_TABLE에 적고 DBMS_XPLAN으로 읽는다 (문장은 실행하지 않음)
      const id = 'dboard_' + Math.random().toString(36).slice(2, 10)
      await s.runManaged(`EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${text}`, 1)
      const [r] = await s.runManaged(`SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', '${id}', 'TYPICAL'))`, 100_000)
      await s.run(`DELETE FROM plan_table WHERE statement_id = '${id}'`, 1).catch(() => undefined)
      return { text: (r?.rows ?? []).map((x) => String(x[0] ?? '')).join('\n'), result: null }
    }
    case 'clickhouse': {
      const [r] = await s.runManaged('EXPLAIN ' + text, 100_000)
      return { text: (r?.rows ?? []).map((x) => String(x[0] ?? '')).join('\n'), result: null }
    }
    case 'duckdb': {
      // explain_key·explain_value 두 열 (값이 상자 그림 글)
      const [r] = await s.runManaged('EXPLAIN ' + text, 100_000)
      return { text: (r?.rows ?? []).map((x) => String(x[1] ?? '')).join('\n'), result: null }
    }
    case 'mssql': {
      // SHOWPLAN_TEXT는 배치에 혼자 있어야 하고, 켜져 있는 동안 문장은 실행되지 않는다
      await s.run('SET SHOWPLAN_TEXT ON', 1)
      try {
        const res = await s.run(text, 100_000)
        return { text: res.filter((r) => r.columns).map((r) => r.rows.map((x) => String(x[0] ?? '')).join('\n')).join('\n\n'), result: null }
      } finally {
        await s.run('SET SHOWPLAN_TEXT OFF', 1).catch(() => undefined)
      }
    }
  }
}
