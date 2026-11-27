// 처음 쓸 때 내려받는 DB 엔진 (지금은 DuckDB 하나 — 네이티브 파일이 커서 설치 파일에 넣지 않는다, 사용자 결정)
// 판을 정해 둔 npm 꾸러미(.tgz)를 받아 sha512를 맞춰 본 뒤 앱 데이터 폴더에 푼다. 받는 주소·지문은 코드에 박아 둔 값만 쓴다.
// Electron을 쓰지 않는다 (받기는 main.ts가 넘겨 주는 fetch — 앱에서는 시스템 프록시를 따르는 net.fetch)
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'fflate'
import { t } from '../shared/i18n'
import type { EngineStatus } from '../shared/types'

export const DUCKDB_ENGINE = {
  /** @duckdb/node-api와 같은 판이어야 한다 (package.json의 판 그대로 — test/stage33.test.ts가 확인) */
  version: '2.0.1-r.1',
  url: 'https://registry.npmjs.org/@duckdb/node-bindings-win32-x64/-/node-bindings-win32-x64-2.0.1-r.1.tgz',
  integrity: 'sha512-tIyo4NP52GhxRz5ReL9wy6JqcMNfsRr2mVOO40lsx9GB8jE1SRyXZEVFoIskQST8jTiSZV+ezLOPIof62Va/SA==',
  /** 받을 크기 (진행 막대용 — 서버가 크기를 안 알려 줄 때) */
  size: 20_726_172,
  /** 꾸러미에서 꺼낼 파일 */
  files: ['duckdb.node', 'duckdb.dll', 'LICENSE'],
}

export type FetchFn = (url: string) => Promise<Response>

interface State {
  dir: string
  /** 앱 밖(테스트·개발)에서는 node_modules의 것을 그대로 쓴다 */
  allowNodeModules: boolean
  /** 받는 중이면 진행 */
  progress: { done: number; total: number } | null
  error: string
  /** 시험(e2e)에서만: 다른 주소·지문 */
  source: { url: string; integrity: string }
}

const state: State = { dir: '', allowNodeModules: true, progress: null, error: '', source: { url: DUCKDB_ENGINE.url, integrity: DUCKDB_ENGINE.integrity } }

declare global {
  // 묶음 안의 @duckdb/node-bindings 대신 들어가는 duckdb-binding.cjs가 이 경로의 duckdb.node를 연다
  var __dboardDuckdbBinding: string | undefined
}

/** main.ts가 앱 데이터 폴더를 알려 준다. 그러면 node_modules는 안 쓴다 */
export function configureEngines(o: { dir: string; source?: { url: string; integrity: string } }) {
  state.dir = o.dir
  state.allowNodeModules = false
  if (o.source) state.source = o.source
  const file = engineFile()
  if (fs.existsSync(file)) globalThis.__dboardDuckdbBinding = file
}

const engineDir = () => path.join(state.dir, `duckdb-${DUCKDB_ENGINE.version}-win32-x64`)
const engineFile = () => path.join(engineDir(), 'duckdb.node')

/** DuckDB를 지금 쓸 수 있는지 (앱 밖이면 node_modules에 있으면 됨) */
export function duckdbReady(): boolean {
  if (state.allowNodeModules) return true
  return !!globalThis.__dboardDuckdbBinding
}

export function engineStatus(): EngineStatus {
  return {
    installed: duckdbReady(),
    version: DUCKDB_ENGINE.version.replace(/-r\.\d+$/, ''),
    size: DUCKDB_ENGINE.size,
    progress: state.progress,
    error: state.error,
  }
}

/** .tar에서 파일 꺼내기 (ustar: 512바이트 머리 + 내용) */
export function untar(tar: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const text = (a: number, b: number) => Buffer.from(tar.subarray(a, b)).toString('utf8').replace(/\0.*$/s, '')
  let off = 0
  while (off + 512 <= tar.length) {
    const name = text(off, off + 100)
    if (!name) break
    const size = parseInt(text(off + 124, off + 136).trim() || '0', 8)
    const type = String.fromCharCode(tar[off + 156] || 48)
    const prefix = text(off + 257, off + 263) === 'ustar' ? text(off + 345, off + 500) : ''
    const full = prefix ? `${prefix}/${name}` : name
    const body = off + 512
    if (type === '0' || type === '\0') out.set(full, tar.subarray(body, body + size))
    off = body + Math.ceil(size / 512) * 512
  }
  return out
}

/** 받은 꾸러미를 확인하고 엔진 폴더에 푼다 (반쯤 푼 폴더가 남지 않게 임시 폴더 → 이름 바꾸기) */
export function installFromTgz(tgz: Uint8Array, integrity: string): string {
  const [algo, want] = integrity.split('-', 2)
  const got = crypto.createHash(algo).update(tgz).digest('base64')
  if (got !== want) throw new Error(t('받은 파일의 지문이 맞지 않아요. 중간에 바뀌었을 수 있어서 쓰지 않았어요.'))
  const files = untar(gunzipSync(tgz))
  const dir = engineDir()
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
  fs.mkdirSync(tmp, { recursive: true })
  try {
    for (const f of DUCKDB_ENGINE.files) {
      const data = files.get('package/' + f)
      if (!data) throw new Error(t('받은 파일에 {name}이(가) 없어요', { name: f }))
      fs.writeFileSync(path.join(tmp, f), data)
    }
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(tmp, dir)
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw e
  }
  return path.join(dir, 'duckdb.node')
}

let installing: Promise<void> | null = null

/** DuckDB 엔진 받기. 이미 받는 중이면 그 일을 기다린다 */
export function installDuckdb(fetchFn: FetchFn): Promise<void> {
  if (duckdbReady()) return Promise.resolve()
  if (!state.dir) return Promise.reject(new Error(t('엔진 폴더가 정해지지 않았어요')))
  installing ??= (async () => {
    state.error = ''
    state.progress = { done: 0, total: DUCKDB_ENGINE.size }
    try {
      const res = await fetchFn(state.source.url)
      if (!res.ok || !res.body) throw new Error(t('내려받지 못했어요 (HTTP {status})', { status: res.status }))
      const total = Number(res.headers.get('content-length')) || DUCKDB_ENGINE.size
      state.progress = { done: 0, total }
      const parts: Uint8Array[] = []
      let done = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done: end, value } = await reader.read()
        if (end) break
        parts.push(value)
        done += value.length
        state.progress = { done, total: Math.max(total, done) }
      }
      const all = new Uint8Array(done)
      let at = 0
      for (const p of parts) {
        all.set(p, at)
        at += p.length
      }
      globalThis.__dboardDuckdbBinding = installFromTgz(all, state.source.integrity)
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      state.progress = null
      installing = null
    }
  })()
  return installing
}
