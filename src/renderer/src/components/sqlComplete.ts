// 자동 완성 보탬: 지금 문장의 FROM·JOIN 등에 나온 표의 열 이름 (표.열·별칭.열·표 이름·키워드는 lang-sql이 한다)
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { Dialect } from '../../../shared/types'
import { referencedTables, statementAt } from '../../../shared/sql'
import { quoteIdent } from '../../../shared/dialect'

const WORD = /[\p{L}\p{N}_$]+/u
const VALID = /^[\p{L}\p{N}_$]*$/u
const PLAIN = /^[A-Za-z_][A-Za-z0-9_$]*$/
/** 문서가 아주 크면 커서 둘레만 본다 */
const WINDOW = 40_000

export function columnCompletion(schema: Record<string, string[]> | undefined, d: Dialect) {
  const byLower = new Map<string, string>()
  for (const k of Object.keys(schema ?? {})) byLower.set(k.toLowerCase(), k)

  return (ctx: CompletionContext): CompletionResult | null => {
    if (!schema || byLower.size === 0) return null
    const word = ctx.matchBefore(WORD)
    if (!word && !ctx.explicit) return null
    const from = word?.from ?? ctx.pos
    // 점 뒤(표.열)는 lang-sql 몫
    if (ctx.state.sliceDoc(Math.max(0, from - 1), from) === '.') return null
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1)
    if (/String|Comment|QuotedIdentifier/i.test(node.type.name)) return null

    const start = Math.max(0, ctx.pos - WINDOW)
    const text = ctx.state.sliceDoc(start, Math.min(ctx.state.doc.length, ctx.pos + WINDOW))
    const st = statementAt(text, ctx.pos - start, d)
    if (!st) return null

    const options = new Map<string, Completion>()
    for (const name of referencedTables(st.text, d)) {
      const table = byLower.get(name.toLowerCase())
      if (!table) continue
      for (const col of schema[table]) {
        const had = options.get(col)
        if (had) had.detail += ', ' + table
        else options.set(col, { label: col, type: 'property', detail: table, boost: 2, ...(PLAIN.test(col) ? {} : { apply: quoteIdent(d, col) }) })
      }
    }
    if (options.size === 0) return null
    return { from, options: [...options.values()], validFor: VALID }
  }
}
