// SQL 편집기 탭: 위 = 편집기, 아래 = 결과(표마다 탭) + 실행 로그
// Ctrl+Enter: 고른 부분(없으면 커서 아래 문장), Alt+X: 전체 스크립트. 문장을 차례로 실행하다 오류가 나면 멈춘다.
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, Database, FolderTree, History, LoaderCircle, Play, PlaySquare, Square } from 'lucide-react'
import { dialectOf, type StatementResult } from '../../../shared/types'
import { firstKeyword, isDangerous, isReadOnlyQuery, splitSql, statementAt } from '../../../shared/sql'
import { api, errorText, useCompletion, useDatabases, useSchemas } from '../api'
import { loadText, saveText, useWs, type EditorTab } from '../ws'
import { useUi } from '../ui'
import { t, tx } from '../i18n'
import { fmtNum, formatMs } from '../format'
import { SqlEditor, type SqlEditorHandle } from '../components/SqlEditor'
import { ResultView } from '../components/ResultView'
import { Splitter, usePaneSize, clamp } from '../components/Splitter'
import { DriverBadge } from '../components/DriverBadge'
import { registerEditor } from '../editors'

interface RunItem {
  sql: string
  result?: StatementResult
  error?: string
  ms: number
}

const DDL_WORDS = new Set(['CREATE', 'DROP', 'ALTER', 'RENAME', 'TRUNCATE', 'COMMENT'])

export function EditorTabView({ tab }: { tab: EditorTab }) {
  const ws = useWs()
  const ui = useUi()
  const qc = useQueryClient()
  const conn = ws.conn(tab.connId)
  const ed = useRef<SqlEditorHandle>(null)
  const split = useRef<HTMLDivElement>(null)
  const [runs, setRuns] = useState<RunItem[]>([])
  const [view, setView] = useState<number | 'log'>('log')
  const [running, setRunning] = useState(false)
  const [started, setStarted] = useState(0)
  const [, tick] = useState(0)
  const cancelled = useRef(false)
  const [editorH, setEditorH, resetEditorH] = usePaneSize('editor', 280)
  const isOn = ws.connected.has(tab.connId)
  const driver = conn?.driver ?? 'sqlite'
  const d = dialectOf(driver)
  const dbs = useDatabases(tab.connId, isOn)
  const wantSchemas = isOn && driver === 'postgres' && !!tab.db
  const schemas = useSchemas(tab.connId, tab.db, wantSchemas)
  const completion = useCompletion(tab.connId, tab.db, tab.schema, isOn && (!!tab.db || driver === 'sqlite'))

  useEffect(() => {
    registerEditor(tab.id, ed.current)
    return () => registerEditor(tab.id, null)
  }, [tab.id])

  // 실행 중 걸린 시간 표시
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => tick((x) => x + 1), 200)
    return () => window.clearInterval(id)
  }, [running])

  if (!conn) return null

  const run = async (mode: 'current' | 'script') => {
    if (running) return
    const h = ed.current
    if (!h) return
    const text = h.text()
    const sel = h.selection()
    let pieces: string[]
    if (mode === 'current' && sel.text.trim()) {
      // SQL Server는 고른 부분을 배치 하나로 (DECLARE한 변수가 이어지게), 나머지는 문장마다
      pieces = d === 'mssql' ? [sel.text] : splitSql(sel.text, d).map((s) => s.text)
    } else if (mode === 'current') {
      const st = statementAt(text, h.cursor(), d)
      pieces = st ? [st.text] : []
    } else pieces = splitSql(text, d).map((s) => s.text)
    if (pieces.length === 0) {
      ui.notify(t('실행할 SQL이 없어요'), 'warn')
      return
    }
    if (ws.settings.confirmDangerous && pieces.some((p) => isDangerous(p, d))) {
      const ok = await ui.confirm({
        title: t('WHERE 없는 UPDATE·DELETE'),
        message: t('표의 모든 행이 바뀌거나 지워질 수 있어요. 그래도 실행할까요?'),
        confirm: t('실행'),
        danger: true,
      })
      if (!ok) return
    }
    if (!(await ws.ensureConnected(tab.connId))) return
    cancelled.current = false
    setRunning(true)
    setStarted(performance.now())
    setRuns([])
    setView('log')
    const out: RunItem[] = []
    let firstResult = -1
    let ddl = false
    for (const sql of pieces) {
      const t0 = performance.now()
      try {
        const res = await api.runSql(tab.connId, tab.id, tab.db, tab.schema, sql, ws.settings.maxRows)
        for (const r of res) out.push({ sql, result: r, ms: r.ms })
        if (DDL_WORDS.has(firstKeyword(sql, d))) ddl = true
      } catch (e) {
        out.push({ sql, error: errorText(e), ms: performance.now() - t0 })
        setRuns([...out])
        break
      }
      if (firstResult < 0) firstResult = out.findIndex((x) => x.result?.columns)
      setRuns([...out])
      if (cancelled.current) break
    }
    setRunning(false)
    const failed = out.some((x) => x.error)
    const resIdx = out.findIndex((x) => x.result?.columns)
    setView(failed || resIdx < 0 ? 'log' : resIdx)
    if (ddl) {
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === tab.connId && ['objects', 'columns', 'indexes', 'completion', 'schemas', 'databases'].includes(String(q.queryKey[0])) })
    }
  }

  const cancel = async () => {
    cancelled.current = true
    try {
      await api.cancelSql(tab.id)
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  const fetchAllFor = (i: number) => {
    const item = runs[i]
    if (!item.result || !isReadOnlyQuery(item.sql, d)) return null
    return async () => {
      setRunning(true)
      setStarted(performance.now())
      try {
        const res = await api.runSql(tab.connId, tab.id, tab.db, tab.schema, item.sql, 1_000_000)
        const r = res.find((x) => x.columns)
        if (r) setRuns((list) => list.map((x, k) => (k === i ? { ...x, result: r, ms: r.ms } : x)))
      } catch (e) {
        ui.notify(errorText(e), 'error')
      } finally {
        setRunning(false)
      }
    }
  }

  const exportAllFor = (i: number) => {
    const item = runs[i]
    if (!item.result || !isReadOnlyQuery(item.sql, d)) return null
    return async (o: Parameters<typeof api.saveCsv>[3]) => {
      const r = await api.exportQueryCsv(tab.connId, tab.id, tab.db, tab.schema, item.sql, o, conn.name)
      if (r) ui.notify(t('{n}행을 저장했어요: {path}', { n: fmtNum(r.rows), path: r.path }), 'success')
    }
  }

  const switchConn = (id: string) => {
    const c = ws.conn(id)
    if (!c) return
    void api.closeSession(tab.id).catch(() => undefined)
    const def = c.database || ({ sqlite: 'main', postgres: 'postgres', mssql: 'master', mysql: '', mariadb: '' } as const)[c.driver]
    ws.updateTab(tab.id, { connId: id, db: def, schema: c.driver === 'postgres' ? 'public' : c.driver === 'mssql' ? 'dbo' : '' })
    void ws.ensureConnected(id)
  }

  const dbList = dbs.data?.databases ?? []
  const resultTabs = runs.map((r, i) => ({ r, i })).filter((x) => x.r.result?.columns)
  const elapsed = running ? performance.now() - started : runs.reduce((n, r) => n + r.ms, 0)
  const errors = runs.filter((r) => r.error).length

  return (
    <div className="editor-tab">
      <div className="editor-bar">
        <label className="ctx-pick" title={t('연결')}>
          <DriverBadge driver={driver} size={16} />
          <select value={tab.connId} onChange={(e) => switchConn(e.target.value)}>
            {ws.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {driver !== 'sqlite' && (
          <label className="ctx-pick" title={t('DB')}>
            <Database />
            <select value={tab.db} onChange={(e) => ws.updateTab(tab.id, { db: e.target.value, schema: driver === 'postgres' ? 'public' : tab.schema })} disabled={!isOn}>
              {!tab.db && <option value="">{t('(DB 고르기)')}</option>}
              {tab.db && !dbList.includes(tab.db) && <option value={tab.db}>{tab.db}</option>}
              {dbList.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
        )}
        {driver === 'postgres' && (
          <label className="ctx-pick" title={t('스키마')}>
            <FolderTree />
            <select value={tab.schema} onChange={(e) => ws.updateTab(tab.id, { schema: e.target.value })} disabled={!isOn}>
              {tab.schema && !(schemas.data ?? []).includes(tab.schema) && <option value={tab.schema}>{tab.schema}</option>}
              {(schemas.data ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
        )}
        <span className="bar-sep" />
        <button className="btn primary small" onClick={() => void run('current')} disabled={running} title={t('고른 부분, 없으면 커서가 있는 문장 (Ctrl+Enter)')}>
          <Play />{t('실행')}<kbd>Ctrl+Enter</kbd>
        </button>
        <button className="btn small" onClick={() => void run('script')} disabled={running} title={t('전체를 문장마다 차례로 (Alt+X)')}>
          <PlaySquare />{t('스크립트 실행')}<kbd>Alt+X</kbd>
        </button>
        <button className="btn small" onClick={() => void cancel()} disabled={!running} title={t('실행 중인 문장 취소')}>
          <Square />{t('취소')}
        </button>
        <span className="spacer" />
        {running && <span className="busy"><LoaderCircle className="spin" />{t('실행 중… {time}', { time: formatMs(elapsed) })}</span>}
        <button className="icon-btn" title={t('실행 기록')} onClick={() => ws.setPanel('history')}><History /></button>
      </div>
      <div className="editor-split" ref={split}>
        <div className="editor-host" style={{ height: editorH }}>
          <SqlEditor
            handle={ed}
            initial={loadText(tab.id)}
            driver={driver}
            schema={completion.data}
            fontSize={ws.settings.editorFontSize}
            placeholder={t('SQL을 입력하세요. Ctrl+Enter로 실행, Ctrl+Space로 자동 완성')}
            onChange={(text) => saveText(tab.id, text)}
            onRun={() => void run('current')}
            onRunScript={() => void run('script')}
          />
        </div>
        <Splitter dir="row" onReset={resetEditorH} onDrag={(_x, y) => {
          const top = split.current?.getBoundingClientRect().top ?? 0
          const h = split.current?.clientHeight ?? 600
          setEditorH(clamp(y - top, 80, h - 120))
        }} />
        <div className="results">
          <div className="result-tabs">
            {resultTabs.map(({ r, i }, n) => (
              <button key={i} className={`rtab ${view === i ? 'on' : ''}`} onClick={() => setView(i)} title={r.sql}>
                {t('결과 {n}', { n: n + 1 })}<span className="count">{fmtNum(r.result!.rows.length)}{r.result!.truncated ? '+' : ''}</span>
              </button>
            ))}
            <button className={`rtab ${view === 'log' ? 'on' : ''}`} onClick={() => setView('log')}>
              {t('실행 로그')}{errors > 0 && <span className="count err">{errors}</span>}
            </button>
            <span className="spacer" />
            {runs.length > 0 && !running && <span className="muted small">{t('{n}개 문장 · {time}', { n: new Set(runs.map((r) => r.sql)).size, time: formatMs(elapsed) })}</span>}
          </div>
          {view === 'log' || !runs[view]?.result ? (
            <div className="run-log">
              {runs.length === 0 && !running && (
                <div className="log-empty">
                  <p>{tx('{run} 커서가 있는 문장(또는 고른 부분)을 실행하고, {script} 전체를 차례로 실행해요.', { run: <kbd>Ctrl+Enter</kbd>, script: <kbd>Alt+X</kbd> })}</p>
                  {!isOn && <p className="muted">{t('실행하면 자동으로 연결해요.')}</p>}
                </div>
              )}
              {runs.map((r, i) => (
                <div key={i} className={`log-item ${r.error ? 'fail' : 'ok'}`} onClick={() => r.result?.columns && setView(i)}>
                  {r.error ? <CircleAlert /> : <CircleCheck />}
                  <div className="log-body">
                    <code className="log-sql ellipsis">{r.sql.replace(/\s+/g, ' ').slice(0, 300)}</code>
                    {r.error ? <pre className="log-error">{r.error}</pre> : (
                      <span className="muted small">
                        {r.result?.columns ? t('{n}행 가져옴', { n: fmtNum(r.result.rows.length) }) : r.result?.affected !== null && r.result?.affected !== undefined ? t('{n}행 바뀜', { n: fmtNum(r.result.affected) }) : t('완료')}
                        {' · '}{formatMs(r.ms)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {running && <div className="log-item running"><LoaderCircle className="spin" /><span className="muted">{t('실행 중…')}</span></div>}
            </div>
          ) : (
            <ResultView key={view} result={runs[view].result!} name={conn.name} fetchAll={fetchAllFor(view)} exportAll={exportAllFor(view)} />
          )}
        </div>
      </div>
    </div>
  )
}
