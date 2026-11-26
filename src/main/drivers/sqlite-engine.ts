// SQLite 실제 작업 (Node 내장 node:sqlite, 동기). 앱에서는 작업 스레드(sqlite-worker.ts) 안에서 돌아서
// 오래 걸리는 쿼리가 창을 멈추지 않는다. 테스트는 같은 스레드에서 바로 쓴다.
import fs from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { firstKeyword } from '../../shared/sql'
import { t } from '../../shared/i18n'
import type { Cell, ResultColumn, StatementResult } from '../../shared/types'
import { toCell, toParam } from '../values'
import type { Rows } from './base'

const WRITE_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT'])

export interface EngineOpenOptions {
  file: string
  /** 파일이 없으면 만들기 (새 DB 파일 만들기로 고른 경우만) */
  create: boolean
}

function bind(params: Cell[]) {
  return params.map((v) => {
    const p = toParam(v)
    return typeof p === 'boolean' ? (p ? 1 : 0) : p
  })
}

const columnsOf = (st: StatementSync): ResultColumn[] => st.columns().map((c) => ({ name: c.name, type: c.type ?? '' }))

export class SqliteEngine {
  private db: DatabaseSync
  private cursors = new Map<number, { it: Iterator<unknown>; binLimit: number }>()
  private seq = 0

  constructor(o: EngineOpenOptions) {
    if (o.file !== ':memory:' && !o.create && !fs.existsSync(o.file)) throw new Error(t('SQLite 파일이 없어요: {file}', { file: o.file }))
    // 확장 불러오기는 끔(load_extension으로 아무 DLL이나 올리지 못하게), 잠겨 있으면 5초까지 기다림
    this.db = new DatabaseSync(o.file, { timeout: 5000, allowExtension: false })
  }

  private prepare(sql: string): StatementSync {
    const st = this.db.prepare(sql)
    st.setReadBigInts(true)
    st.setReturnArrays(true)
    return st
  }

  run(sql: string, maxRows: number): StatementResult {
    const t0 = performance.now()
    const st = this.prepare(sql)
    const columns = columnsOf(st)
    if (columns.length === 0) {
      const r = st.run()
      const affected = WRITE_WORDS.has(firstKeyword(sql, 'sqlite')) ? Number(r.changes) : null
      return { sql, columns: null, rows: [], truncated: false, affected, ms: performance.now() - t0 }
    }
    const rows: Cell[][] = []
    let truncated = false
    for (const r of st.iterate() as Iterable<unknown[]>) {
      if (rows.length >= maxRows) {
        truncated = true
        break
      }
      rows.push(r.map((v) => toCell(v)))
    }
    const affected = WRITE_WORDS.has(firstKeyword(sql, 'sqlite')) ? rows.length : null
    return { sql, columns, rows, truncated, affected, ms: performance.now() - t0 }
  }

  query(sql: string, params: Cell[], binLimit = 64): Rows {
    const st = this.prepare(sql)
    const columns = columnsOf(st)
    if (columns.length === 0) {
      st.run(...bind(params))
      return { columns, rows: [] }
    }
    const rows = (st.all(...bind(params)) as unknown as unknown[][]).map((r) => r.map((v) => toCell(v, binLimit)))
    return { columns, rows }
  }

  exec(sql: string, params: Cell[]): number {
    const r = this.prepare(sql).run(...bind(params))
    return Number(r.changes)
  }

  /** 많은 행을 조금씩 (CSV 내보내기) */
  openCursor(sql: string): { id: number; columns: ResultColumn[] } {
    const st = this.prepare(sql)
    const id = ++this.seq
    this.cursors.set(id, { it: (st.iterate() as Iterable<unknown>)[Symbol.iterator](), binLimit: Infinity })
    return { id, columns: columnsOf(st) }
  }

  next(id: number, n: number): { rows: Cell[][]; done: boolean } {
    const c = this.cursors.get(id)
    if (!c) return { rows: [], done: true }
    const rows: Cell[][] = []
    while (rows.length < n) {
      const r = c.it.next()
      if (r.done) {
        this.cursors.delete(id)
        return { rows, done: true }
      }
      rows.push((r.value as unknown[]).map((v) => toCell(v, c.binLimit)))
    }
    return { rows, done: false }
  }

  closeCursor(id: number) {
    const c = this.cursors.get(id)
    c?.it.return?.()
    this.cursors.delete(id)
  }

  close() {
    for (const id of [...this.cursors.keys()]) this.closeCursor(id)
    if (this.db.isOpen) this.db.close()
  }
}

/** 요청 이름 → 엔진 메서드 (작업 스레드와 같은 스레드 모드가 같이 씀) */
export function dispatch(engine: SqliteEngine, op: string, args: unknown[]): unknown {
  switch (op) {
    case 'run':
      return engine.run(args[0] as string, args[1] as number)
    case 'query':
      return engine.query(args[0] as string, args[1] as Cell[], (args[2] as number | undefined) ?? 64)
    case 'exec':
      return engine.exec(args[0] as string, args[1] as Cell[])
    case 'openCursor':
      return engine.openCursor(args[0] as string)
    case 'next':
      return engine.next(args[0] as number, args[1] as number)
    case 'closeCursor':
      return engine.closeCursor(args[0] as number)
    case 'close':
      return engine.close()
    default:
      throw new Error('unknown op ' + op)
  }
}
