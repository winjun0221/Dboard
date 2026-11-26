// SQL 편집기 탭: 위 = 편집기, 아래 = 결과(표마다 탭) + 실행 로그
// Ctrl+Enter: 고른 부분(없으면 커서 아래 문장), Alt+X: 전체 스크립트. 문장을 차례로 실행하다 오류가 나면 멈춘다.
// 수동 커밋(커밋·롤백 단추), SQL 정렬(Ctrl+Shift+F), 실행 계획(Ctrl+Shift+E), 운영 DB 확인·읽기 전용 막기
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { format as formatSql } from 'sql-formatter'
import {
  AlignLeft, CheckCheck, CircleAlert, CircleCheck, CircleCheckBig, Database, FolderTree, GitCommitHorizontal, History, ListTree, LoaderCircle, Lock, Play,
  PlaySquare, ShieldAlert, Square, Undo2,
} from 'lucide-react'
import { dialectOf, type DriverKind, type ExplainResult, type StatementResult } from '../../../shared/types'
import { firstKeyword, isDangerous, isReadOnlyQuery, splitSql, statementAt } from '../../../shared/sql'
import { api, errorText, useCompletion, useDatabases, useSchemas } from '../api'
import { loadText, saveText, setDirty, useWs, type EditorTab } from '../ws'
import { useUi } from '../ui'
import { t, tx } from '../i18n'
import { fmtNum, formatMs } from '../format'
import { SqlEditor, type SqlEditorHandle } from '../components/SqlEditor'
import { ResultView } from '../components/ResultView'
import { Splitter, usePaneSize, clamp } from '../components/Splitter'
import { DriverBadge } from '../components/DriverBadge'
import { registerActions, registerEditor, type EditorActions } from '../editors'
import { Dialog } from '../components/Dialog'

interface RunItem {
  sql: string
  result?: StatementResult
  error?: string
  ms: number
}

const DDL_WORDS = new Set(['CREATE', 'DROP', 'ALTER', 'RENAME', 'TRUNCATE', 'COMMENT'])
const END_WORDS = new Set(['COMMIT', 'ROLLBACK', 'END', 'ABORT'])
const FORMAT_LANG: Record<DriverKind, 'sqlite' | 'mysql' | 'mariadb' | 'postgresql' | 'transactsql'> = { sqlite: 'sqlite', mysql: 'mysql', mariadb: 'mariadb', postgres: 'postgresql', mssql: 'transactsql' }

/** 수동 커밋을 끄거나 닫을 때: 남은 변경을 커밋할지 롤백할지 */
function TxEndDialog({ n, onClose, onPick }: { n: number; onClose: () => void; onPick: (commit: boolean) => void }) {
  return (
    <Dialog title={t('커밋하지 않은 변경')} icon={GitCommitHorizontal} width={460} submitLabel={t('커밋')} onClose={onClose} onSubmit={() => onPick(true)}
      footer={<button type="button" className="btn" onClick={() => onPick(false)}><Undo2 />{t('롤백')}</button>}>
      <p className="confirm-text">{t('이 편집기에 아직 커밋하지 않은 문장이 {n}개 있어요. 커밋할까요, 되돌릴까요?', { n })}</p>
    </Dialog>
  )
}

export function EditorTabView({ tab }: { tab: EditorTab }) {
  const ws = useWs()
  const ui = useUi()
  const qc = useQueryClient()
  const conn = ws.conn(tab.connId)
  const ed = useRef<SqlEditorHandle>(null)
  const split = useRef<HTMLDivElement>(null)
  const [runs, setRuns] = useState<RunItem[]>([])
  const [view, setView] = useState<number | 'log' | 'plan'>('log')
  const [plan, setPlan] = useState<{ sql: string; result?: ExplainResult; error?: string } | null>(null)
  /** 수동 커밋에서 아직 커밋하지 않은 (데이터를 바꾸는) 문장 수 */
  const [pending, setPending] = useState(0)
  const manual = tab.manual ?? conn?.production === true
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

  // 제목 줄 SQL 메뉴에서 실행·취소 (그때그때 최신 함수로)
  const actions = useRef<EditorActions | null>(null)
  useEffect(() => {
    registerActions(tab.id, {
      run: (mode) => actions.current?.run(mode),
      cancel: () => actions.current?.cancel(),
      format: () => actions.current?.format(),
      explain: () => actions.current?.explain(),
      commit: () => actions.current?.commit(),
      rollback: () => actions.current?.rollback(),
      toggleManual: () => actions.current?.toggleManual(),
      get running() {
        return actions.current?.running ?? false
      },
      get manual() {
        return actions.current?.manual ?? false
      },
      get pending() {
        return actions.current?.pending ?? 0
      },
    })
    return () => registerActions(tab.id, null)
  }, [tab.id])

  // 커밋하지 않은 변경이 있으면 탭을 닫을 때 묻는다 (닫으면 연결과 함께 되돌려짐)
  useEffect(() => {
    setDirty(tab.id, pending > 0)
    return () => setDirty(tab.id, false)
  }, [tab.id, pending])

  // 실행 중 걸린 시간 표시
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => tick((x) => x + 1), 200)
    return () => window.clearInterval(id)
  }, [running])

  if (!conn) return null

  /** 실행할 문장들: 고른 부분(SQL Server는 통째로 배치 하나) / 커서 문장 / 전체 */
  const piecesFor = (mode: 'current' | 'script'): string[] => {
    const h = ed.current
    if (!h) return []
    const text = h.text()
    const sel = h.selection()
    if (mode === 'current' && sel.text.trim()) return d === 'mssql' ? [sel.text] : splitSql(sel.text, d).map((s) => s.text)
    if (mode === 'current') {
      const st = statementAt(text, h.cursor(), d)
      return st ? [st.text] : []
    }
    return splitSql(text, d).map((s) => s.text)
  }

  const run = async (mode: 'current' | 'script') => {
    if (running) return
    const h = ed.current
    if (!h) return
    h.closePopups()
    const pieces = piecesFor(mode)
    if (pieces.length === 0) {
      ui.notify(t('실행할 SQL이 없어요'), 'warn')
      return
    }
    const writes = pieces.filter((p) => !isReadOnlyQuery(p, d) && !END_WORDS.has(firstKeyword(p, d)))
    if (conn.readOnly === true && writes.length) {
      ui.notify(t('읽기 전용 접속이라 데이터나 구조를 바꾸는 문장은 실행할 수 없어요'), 'error')
      return
    }
    // 운영 DB: 자동 커밋이면 바로 반영되니 한 번 더 묻는다 (수동 커밋이면 커밋할 때 묻는다)
    if (conn.production === true && !manual && writes.length) {
      const ok = await ui.confirm({
        title: t('운영 DB'),
        message: t('운영 DB "{name}"에서 데이터나 구조를 바꾸는 문장 {n}개를 바로 실행해요(자동 커밋). 계속할까요?', { name: conn.name, n: writes.length }),
        confirm: t('실행'),
        danger: true,
      })
      if (!ok) return
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
        const res = await api.runSql(tab.connId, tab.id, tab.db, tab.schema, sql, ws.settings.maxRows, manual)
        for (const r of res) out.push({ sql, result: r, ms: r.ms })
        const kw = firstKeyword(sql, d)
        if (DDL_WORDS.has(kw)) ddl = true
        if (manual) {
          if (END_WORDS.has(kw) && !/\bTO\b/i.test(sql)) setPending(0)
          else if (!isReadOnlyQuery(sql, d)) setPending((n) => n + 1)
        }
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
        const res = await api.runSql(tab.connId, tab.id, tab.db, tab.schema, item.sql, 1_000_000, manual)
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

  /** 실행 계획: 고른 부분(첫 문장) 또는 커서 문장. 실행하지 않는다 */
  const showPlan = async () => {
    if (running) return
    ed.current?.closePopups()
    const sql = piecesFor('current')[0]
    if (!sql) {
      ui.notify(t('실행 계획을 볼 SQL이 없어요'), 'warn')
      return
    }
    if (!(await ws.ensureConnected(tab.connId))) return
    setRunning(true)
    setStarted(performance.now())
    try {
      setPlan({ sql, result: await api.explain(tab.connId, tab.id, tab.db, tab.schema, sql, manual) })
    } catch (e) {
      setPlan({ sql, error: errorText(e) })
    } finally {
      setRunning(false)
      setView('plan')
    }
  }

  /** SQL 정렬: 고른 부분 또는 전체 (SQL Server는 GO마다 따로) */
  const formatText = () => {
    const h = ed.current
    if (!h) return
    const sel = h.selection()
    const src = sel.text.trim() ? sel.text : h.text()
    if (!src.trim()) return
    try {
      const one = (x: string) => formatSql(x, { language: FORMAT_LANG[driver], keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 })
      const out = d === 'mssql' ? src.split(/^\s*GO\s*$/im).map((b) => (b.trim() ? one(b) : '')).filter(Boolean).join('\nGO\n') : one(src)
      if (sel.text.trim()) h.insert(out)
      else h.setText(out)
    } catch (e) {
      ui.notify(t('SQL을 정렬하지 못했어요: {error}', { error: errorText(e) }), 'error')
    }
  }

  /** 수동 커밋의 커밋·롤백 */
  const endTx = async (commit: boolean) => {
    if (commit && conn.production === true && pending > 0) {
      const ok = await ui.confirm({ title: t('운영 DB'), message: t('운영 DB "{name}"에 바뀐 내용({n}개 문장)을 커밋할까요?', { name: conn.name, n: pending }), confirm: t('커밋'), danger: true })
      if (!ok) return false
    }
    try {
      await (commit ? api.commitTx(tab.id) : api.rollbackTx(tab.id))
      setPending(0)
      ui.notify(commit ? t('커밋했어요') : t('롤백했어요'), 'success')
      return true
    } catch (e) {
      ui.notify(errorText(e), 'error')
      return false
    }
  }

  /** 남은 변경이 있으면 커밋·롤백을 물어본 뒤 true (그만두면 false) */
  const settlePending = () => new Promise<boolean>((resolve) => {
    if (pending === 0) return resolve(true)
    ui.open((close) => <TxEndDialog n={pending} onClose={() => { resolve(false); close() }} onPick={async (commit) => { close(); resolve(await endTx(commit)) }} />)
  })

  const toggleManual = async () => {
    if (manual && !(await settlePending())) return
    ws.updateTab(tab.id, { manual: !manual })
  }

  const switchConn = async (id: string) => {
    const c = ws.conn(id)
    if (!c) return
    if (!(await settlePending())) return
    setPending(0)
    void api.closeSession(tab.id).catch(() => undefined)
    const def = c.database || ({ sqlite: 'main', postgres: 'postgres', mssql: 'master', mysql: '', mariadb: '' } as const)[c.driver]
    ws.updateTab(tab.id, { connId: id, db: def, schema: c.driver === 'postgres' ? 'public' : c.driver === 'mssql' ? 'dbo' : '' })
    void ws.ensureConnected(id)
  }

  actions.current = {
    run: (mode) => void run(mode), cancel: () => void cancel(), running, format: formatText, explain: () => void showPlan(),
    commit: () => void endTx(true), rollback: () => void endTx(false), toggleManual: () => void toggleManual(), manual, pending,
  }

  const dbList = dbs.data?.databases ?? []
  const resultTabs = runs.map((r, i) => ({ r, i })).filter((x) => x.r.result?.columns)
  const elapsed = running ? performance.now() - started : runs.reduce((n, r) => n + r.ms, 0)
  const errors = runs.filter((r) => r.error).length

  return (
    <div className="editor-tab">
      <div className="editor-bar toolbar">
        <button className="tbtn run" onClick={() => void run('current')} disabled={running} title={t('고른 부분, 없으면 커서가 있는 문장 (Ctrl+Enter)')}>
          <Play />{t('실행')}<kbd>Ctrl+Enter</kbd>
        </button>
        <button className="tbtn run" onClick={() => void run('script')} disabled={running} title={t('전체를 문장마다 차례로 (Alt+X)')}>
          <PlaySquare />{t('스크립트 실행')}<kbd>Alt+X</kbd>
        </button>
        <button className="tbtn stop" onClick={() => void cancel()} disabled={!running} title={t('실행 중인 문장 취소')}>
          <Square />{t('취소')}
        </button>
        <span className="bar-sep" />
        <button className="tbtn" onClick={formatText} title={t('SQL 줄 맞추기 — 고른 부분 또는 전체 (Ctrl+Shift+F)')}><AlignLeft />{t('정렬')}</button>
        <button className="tbtn" onClick={() => void showPlan()} disabled={running} title={t('실행하지 않고 실행 계획만 보기 (Ctrl+Shift+E)')}><ListTree />{t('실행 계획')}</button>
        <span className="bar-sep" />
        <button className={`tbtn tx-mode ${manual ? 'manual' : ''}`} onClick={() => void toggleManual()} disabled={running}
          title={manual ? t('수동 커밋: 커밋을 눌러야 반영돼요. 눌러서 자동 커밋으로') : t('자동 커밋: 문장마다 바로 반영돼요. 눌러서 수동 커밋으로')}>
          {manual ? <GitCommitHorizontal /> : <CheckCheck />}{manual ? t('수동 커밋') : t('자동 커밋')}
        </button>
        {manual && (
          <>
            <button className="tbtn commit" onClick={() => void endTx(true)} disabled={running} title={t('바뀐 내용을 DB에 반영')}>
              <CircleCheckBig />{t('커밋')}{pending > 0 && <span className="count warn">{pending}</span>}
            </button>
            <button className="tbtn" onClick={() => void endTx(false)} disabled={running} title={t('커밋하지 않은 변경을 되돌리기')}><Undo2 />{t('롤백')}</button>
          </>
        )}
        <span className="bar-sep" />
        <button className="tbtn icon" title={t('실행 기록')} onClick={() => ws.setPanel('history')}><History /></button>
        {running && <span className="busy"><LoaderCircle className="spin" />{t('실행 중… {time}', { time: formatMs(elapsed) })}</span>}
        <span className="spacer" />
        {conn.production === true && <span className="chip danger" title={t('운영 DB로 표시한 접속이에요')}><ShieldAlert />{t('운영 DB')}</span>}
        {conn.readOnly === true && <span className="chip" title={t('바꾸는 문장은 실행되지 않아요')}><Lock />{t('읽기 전용')}</span>}
        <label className="ctx-pick" title={t('연결')}>
          <DriverBadge driver={driver} size={14} />
          <select value={tab.connId} onChange={(e) => void switchConn(e.target.value)}>
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
            onFormat={formatText}
            onExplain={() => void showPlan()}
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
            {plan && <button className={`rtab ${view === 'plan' ? 'on' : ''}`} onClick={() => setView('plan')} title={plan.sql}><ListTree />{t('실행 계획')}</button>}
            <span className="spacer" />
            {runs.length > 0 && !running && <span className="muted small">{t('{n}개 문장 · {time}', { n: new Set(runs.map((r) => r.sql)).size, time: formatMs(elapsed) })}</span>}
          </div>
          {view === 'plan' && plan ? (
            <div className="plan-view">
              <code className="plan-sql ellipsis">{plan.sql.replace(/\s+/g, ' ').slice(0, 300)}</code>
              {plan.error ? <pre className="log-error plan-error">{plan.error}</pre>
                : plan.result?.text !== null && plan.result?.text !== undefined ? <pre className="plan-text">{plan.result.text || t('(계획이 비어 있어요)')}</pre>
                  : plan.result?.result ? <ResultView result={plan.result.result} name={conn.name} dialect={d} fetchAll={null} exportAll={null} /> : null}
            </div>
          ) : view === 'log' || view === 'plan' || !runs[view]?.result ? (
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
            <ResultView key={view} result={runs[view].result!} name={conn.name} dialect={d} fetchAll={fetchAllFor(view)} exportAll={exportAllFor(view)} />
          )}
        </div>
      </div>
    </div>
  )
}
