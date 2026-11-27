// 자동 완성 보탬: 지금 문장의 FROM·JOIN 등에 나온 표의 열 이름 (표.열·별칭.열·표 이름·키워드는 lang-sql이 한다)
import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
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

/** 코드 템플릿: sel + Tab → SELECT * FROM … (넣은 뒤 Tab으로 다음 칸). ${1:x}처럼 같은 번호는 같이 바뀐다 */
const TEMPLATES: [string, string][] = [
  ['sel', 'SELECT * FROM ${table}'],
  ['selw', 'SELECT * FROM ${table} WHERE ${condition}'],
  ['cnt', 'SELECT COUNT(*) FROM ${table}'],
  ['gb', 'SELECT ${1:column}, COUNT(*) FROM ${2:table} GROUP BY ${1:column}'],
  ['ins', 'INSERT INTO ${table} (${columns}) VALUES (${values})'],
  ['upd', 'UPDATE ${table} SET ${column} = ${value} WHERE ${condition}'],
  ['del', 'DELETE FROM ${table} WHERE ${condition}'],
  ['join', 'JOIN ${table} ON ${condition}'],
]

export function templateCompletion(d: Dialect) {
  const list: [string, string][] = [...TEMPLATES, ['top', d === 'mssql' ? 'SELECT TOP 100 * FROM ${table}' : 'SELECT * FROM ${table} LIMIT 100']]
  const options = list.map(([label, tpl]) => snippetCompletion(tpl, { label, detail: tpl.replace(/\$\{(?:\d+:)?([^}]*)\}/g, '$1'), type: 'text', boost: 99 }))
  return (ctx: CompletionContext): CompletionResult | null => {
    const w = ctx.matchBefore(/[A-Za-z]+/)
    if (!w || (w.from === w.to && !ctx.explicit)) return null
    // 문자열·주석·이름(점 뒤) 안에서는 띄우지 않는다
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1)
    if (/String|Comment|QuotedIdentifier/.test(node.name)) return null
    if (w.from > 0 && ctx.state.sliceDoc(w.from - 1, w.from) === '.') return null
    return { from: w.from, options, validFor: /^[A-Za-z]*$/ }
  }
}
