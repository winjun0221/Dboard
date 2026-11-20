// 열린 SQL 편집기 찾기: 실행 기록에서 지금 편집기에 SQL 넣기, 제목 줄 SQL 메뉴에서 실행·취소
import type { SqlEditorHandle } from './components/SqlEditor'

export interface EditorActions {
  run(mode: 'current' | 'script'): void
  cancel(): void
  running: boolean
}

const editors = new Map<string, SqlEditorHandle>()
const actions = new Map<string, EditorActions>()

export function registerEditor(id: string, h: SqlEditorHandle | null) {
  if (h) editors.set(id, h)
  else editors.delete(id)
}

export function registerActions(id: string, a: EditorActions | null) {
  if (a) actions.set(id, a)
  else actions.delete(id)
}

export const editorActions = (id: string | null) => (id ? actions.get(id) : undefined)

/** 넣었으면 true */
export function insertIntoEditor(id: string, sql: string): boolean {
  const h = editors.get(id)
  if (!h) return false
  const cur = h.text()
  h.insert((cur && !cur.endsWith('\n') ? '\n\n' : '') + sql)
  return true
}
