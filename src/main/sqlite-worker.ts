// SQLite 작업 스레드: 메인 프로세스가 보낸 요청 { id, op, args }를 SqliteEngine으로 처리하고 { id, ok, data | error }로 답한다.
// 오래 걸리는 쿼리를 취소할 때는 메인이 이 스레드를 통째로 끝낸다.
import { parentPort, workerData } from 'node:worker_threads'
import { setLang, type Lang } from '../shared/i18n'
import { dispatch, SqliteEngine, type EngineOpenOptions } from './drivers/sqlite-engine'

setLang((workerData as { lang?: Lang } | undefined)?.lang ?? 'ko')

let engine: SqliteEngine | null = null

parentPort?.on('message', (m: { id: number; op: string; args: unknown[] }) => {
  try {
    let data: unknown = null
    if (m.op === 'open') engine = new SqliteEngine(m.args[0] as EngineOpenOptions)
    else if (!engine) throw new Error('SQLite not open')
    else data = dispatch(engine, m.op, m.args)
    parentPort!.postMessage({ id: m.id, ok: true, data })
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})
