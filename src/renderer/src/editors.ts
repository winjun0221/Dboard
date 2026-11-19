// 열린 SQL 편집기 찾기 (실행 기록에서 지금 편집기에 SQL 넣기)
import type { SqlEditorHandle } from './components/SqlEditor'

const editors = new Map<string, SqlEditorHandle>()

export function registerEditor(id: string, h: SqlEditorHandle | null) {
  if (h) editors.set(id, h)
  else editors.delete(id)
}

/** 넣었으면 true */
export function insertIntoEditor(id: string, sql: string): boolean {
  const h = editors.get(id)
  if (!h) return false
  const cur = h.text()
  h.insert((cur && !cur.endsWith('\n') ? '\n\n' : '') + sql)
  return true
}
