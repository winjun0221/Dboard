// SQL 편집기 (CodeMirror 6): 방언별 문법 색칠, 표·열 자동 완성(입력하면 뜨고 Tab·Enter로 넣기), Ctrl+Enter 실행, Alt+X 스크립트 실행
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { MSSQL, MySQL, MariaSQL, PostgreSQL, SQLite, sql, type SQLDialect } from '@codemirror/lang-sql'
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import {
  crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers,
  placeholder as placeholderExt, rectangularSelection,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { dialectOf, type DriverKind } from '../../../shared/types'
import { columnCompletion } from './sqlComplete'

const DIALECT: Record<DriverKind, SQLDialect> = { sqlite: SQLite, mysql: MySQL, mariadb: MariaSQL, postgres: PostgreSQL, mssql: MSSQL }

/** 방언 + 자동 완성(lang-sql: 표·키워드·표.열 / 우리 것: 문장에 나온 표의 열) */
const language = (driver: DriverKind, schema?: Record<string, string[]>) => [
  sql({ dialect: DIALECT[driver], schema, upperCaseKeywords: true }),
  DIALECT[driver].language.data.of({ autocomplete: columnCompletion(schema, dialectOf(driver)) }),
]

// 색은 CSS 변수로 (밝은·어두운 화면에 맞춰 styles.css에서 정함)
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syn-kw)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-str)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-num)' },
  { tag: [tags.lineComment, tags.blockComment, tags.comment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--syn-type)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--syn-op)' },
  { tag: [tags.special(tags.name), tags.quote], color: 'var(--syn-ident)' },
  { tag: tags.variableName, color: 'var(--text)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--text)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', border: 'none', borderRight: '1px solid var(--line-soft)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--text)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--sel-bg) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
  // 대화 상자(.dialog-backdrop z-index 200) 아래로
  '.cm-tooltip': { zIndex: '150', backgroundColor: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '8px', boxShadow: 'var(--shadow)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12px', maxHeight: '16em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px 2px 4px', lineHeight: '1.6' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginLeft: '14px', fontSize: '11px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail': { color: 'rgba(255, 255, 255, 0.8)' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--line)' },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-ran': { backgroundColor: 'var(--ran-bg)' },
})

export interface SqlEditorHandle {
  view(): EditorView | null
  text(): string
  /** 고른 부분 (없으면 '') */
  selection(): { from: number; to: number; text: string }
  cursor(): number
  insert(text: string): void
  setText(text: string): void
  focus(): void
  /** 자동 완성 목록 닫기 */
  closePopups(): void
}

export function SqlEditor({ initial, driver, schema, fontSize, readOnly, placeholder, onChange, onRun, onRunScript, handle }: {
  initial: string
  driver: DriverKind
  /** 자동 완성용 표 → 열 */
  schema?: Record<string, string[]>
  fontSize: number
  readOnly?: boolean
  placeholder?: string
  onChange?: (text: string) => void
  onRun?: () => void
  onRunScript?: () => void
  handle?: Ref<SqlEditorHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const lang = useRef(new Compartment())
  const size = useRef(new Compartment())
  const ro = useRef(new Compartment())
  const cb = useRef({ onChange, onRun, onRunScript })
  cb.current = { onChange, onRun, onRunScript }

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, icons: true }),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(highlight),
          theme,
          placeholder ? placeholderExt(placeholder) : [],
          Prec.highest(keymap.of([
            // 실행하면 자동 완성 목록은 닫는다 (뜬 채로 남아 다른 화면 위에 겹치지 않게)
            { key: 'Mod-Enter', run: (v) => { closeCompletion(v); cb.current.onRun?.(); return true } },
            { key: 'Alt-x', run: (v) => { closeCompletion(v); cb.current.onRunScript?.(); return true } },
            { key: 'Alt-X', run: (v) => { closeCompletion(v); cb.current.onRunScript?.(); return true } },
          ])),
          // 자동 완성 목록이 떠 있으면 Tab으로 넣기, 아니면 들여쓰기
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, { key: 'Tab', run: acceptCompletion }, indentWithTab]),
          lang.current.of(language(driver, schema)),
          size.current.of(EditorView.theme({ '&': { fontSize: fontSize + 'px' } })),
          ro.current.of([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange?.(u.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // 처음 한 번만 만든다 (바뀌는 설정은 아래에서 다시 맞춤)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(language(driver, schema)) })
  }, [driver, schema])

  useEffect(() => {
    view.current?.dispatch({ effects: size.current.reconfigure(EditorView.theme({ '&': { fontSize: fontSize + 'px' } })) })
  }, [fontSize])

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]) })
  }, [readOnly])

  // 읽기 전용(DDL 보기 등)은 바깥 글이 바뀌면 따라간다
  useEffect(() => {
    const v = view.current
    if (!v || !readOnly) return
    if (v.state.doc.toString() !== initial) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: initial } })
  }, [initial, readOnly])

  useImperativeHandle(handle, () => ({
    view: () => view.current,
    text: () => view.current?.state.doc.toString() ?? '',
    selection: () => {
      const v = view.current
      if (!v) return { from: 0, to: 0, text: '' }
      const r = v.state.selection.main
      return { from: r.from, to: r.to, text: v.state.sliceDoc(r.from, r.to) }
    },
    cursor: () => view.current?.state.selection.main.head ?? 0,
    insert: (text) => {
      const v = view.current
      if (!v) return
      const r = v.state.selection.main
      v.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } })
      v.focus()
    },
    setText: (text) => {
      const v = view.current
      if (!v) return
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
    },
    focus: () => view.current?.focus(),
    closePopups: () => {
      if (view.current) closeCompletion(view.current)
    },
  }))

  return <div className="sql-editor" ref={host} />
}
