// 설정 폴더의 파일들: 접속 정보(connections.json, 비밀번호는 Windows 암호화), 실행 기록, SSH 호스트 키
// 암호화는 바깥에서 넣어 준다(앱: Electron safeStorage = Windows DPAPI, 테스트: 가짜). 비밀 값은 화면으로 돌려주지 않는다.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { t } from '../shared/i18n'
import type { ConnectionConfig, ConnectionInfo, HistoryEntry, SecretName, SecretsInput } from '../shared/types'
import type { HostKeys } from './tunnel'

export interface Crypto {
  available(): boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

interface Stored extends ConnectionConfig {
  secrets: Partial<Record<SecretName, string>>
}

const SECRET_NAMES: SecretName[] = ['password', 'sshPassword', 'sshPassphrase']
const MAX_HISTORY = 1000

export class Store {
  constructor(private dir: string, private crypto: Crypto) {}

  private file(name: string) {
    return path.join(this.dir, name)
  }

  readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8')) as T
    } catch {
      return fallback
    }
  }

  /** 임시 파일에 쓰고 바꿔치기 (쓰다가 꺼져도 원래 파일이 깨지지 않게) */
  writeJson(name: string, value: unknown) {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.file(name + '.tmp')
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, this.file(name))
  }

  // ───────── 접속 정보 ─────────

  private readAll(): Stored[] {
    const v = this.readJson<{ connections?: Stored[] }>('connections.json', {})
    return Array.isArray(v.connections) ? v.connections.filter((c) => c && typeof c.id === 'string') : []
  }

  private writeAll(list: Stored[]) {
    this.writeJson('connections.json', { version: 1, connections: list })
  }

  private info(s: Stored): ConnectionInfo {
    const { secrets, ...config } = s
    return { ...config, saved: { password: !!secrets?.password, sshPassword: !!secrets?.sshPassword, sshPassphrase: !!secrets?.sshPassphrase } }
  }

  list(): ConnectionInfo[] {
    return this.readAll().map((s) => this.info(s))
  }

  has(id: string): boolean {
    return this.readAll().some((c) => c.id === id)
  }

  config(id: string): ConnectionConfig {
    const s = this.readAll().find((c) => c.id === id)
    if (!s) throw new Error(t('접속 정보를 찾지 못했어요'))
    const { secrets: _s, ...config } = s
    void _s
    return config
  }

  /** 저장된 비밀 값 (메인 안에서만) */
  secrets(id: string): Partial<Record<SecretName, string>> {
    const s = this.readAll().find((c) => c.id === id)
    const out: Partial<Record<SecretName, string>> = {}
    if (!s?.secrets) return out
    for (const k of SECRET_NAMES) {
      const enc = s.secrets[k]
      if (!enc) continue
      try {
        out[k] = this.crypto.decrypt(enc)
      } catch {
        // 다른 PC·사용자로 옮긴 파일 등 — 풀 수 없으면 없는 것으로 (다시 물어봄)
      }
    }
    return out
  }

  save(config: ConnectionConfig, input: SecretsInput): ConnectionInfo {
    const list = this.readAll()
    const id = config.id || crypto.randomUUID()
    const old = list.find((c) => c.id === id)
    const secrets: Partial<Record<SecretName, string>> = config.savePassword ? { ...(old?.secrets ?? {}) } : {}
    if (config.savePassword) {
      for (const k of SECRET_NAMES) {
        const v = input[k]
        if (v === undefined) continue
        if (v === '') delete secrets[k]
        else {
          if (!this.crypto.available()) throw new Error(t('이 PC에서는 비밀번호를 안전하게 저장할 수 없어요. "비밀번호 저장"을 끄고 연결할 때마다 입력해 주세요.'))
          secrets[k] = this.crypto.encrypt(v)
        }
      }
    }
    // 쓰지 않게 된 비밀 값은 지운다 (SSH 끔, 인증 방식 바꿈)
    if (!config.ssh.enabled || config.ssh.auth !== 'password') delete secrets.sshPassword
    if (!config.ssh.enabled || config.ssh.auth !== 'key') delete secrets.sshPassphrase
    if (config.driver === 'sqlite') delete secrets.password
    const stored: Stored = { ...config, id, secrets }
    const next = old ? list.map((c) => (c.id === id ? stored : c)) : [...list, stored]
    this.writeAll(next)
    return this.info(stored)
  }

  remove(id: string) {
    this.writeAll(this.readAll().filter((c) => c.id !== id))
  }

  duplicate(id: string, nameSuffix: string): ConnectionInfo {
    const list = this.readAll()
    const s = list.find((c) => c.id === id)
    if (!s) throw new Error(t('접속 정보를 찾지 못했어요'))
    const copy: Stored = { ...s, id: crypto.randomUUID(), name: s.name + nameSuffix, secrets: { ...s.secrets } }
    const i = list.indexOf(s)
    list.splice(i + 1, 0, copy)
    this.writeAll(list)
    return this.info(copy)
  }

  /** 접속을 폴더로 묶기 (비밀 값·순서는 그대로) */
  setFolder(ids: string[], folder: string) {
    const set = new Set(ids)
    this.writeAll(this.readAll().map((c) => (set.has(c.id) ? { ...c, folder } : c)))
  }

  move(id: string, to: number) {
    const list = this.readAll()
    const i = list.findIndex((c) => c.id === id)
    if (i < 0) return
    const [item] = list.splice(i, 1)
    list.splice(Math.max(0, Math.min(list.length, to)), 0, item)
    this.writeAll(list)
  }

  // ───────── 실행 기록 ─────────

  history(search: string, limit: number): HistoryEntry[] {
    const list = this.readJson<HistoryEntry[]>('history.json', [])
    const s = search.trim().toLowerCase()
    return (Array.isArray(list) ? list : []).filter((h) => !s || h.sql.toLowerCase().includes(s) || h.connName.toLowerCase().includes(s)).slice(0, limit)
  }

  addHistory(e: Omit<HistoryEntry, 'id'>) {
    const list = this.readJson<HistoryEntry[]>('history.json', [])
    const arr = Array.isArray(list) ? list : []
    const id = (arr[0]?.id ?? 0) + 1
    this.writeJson('history.json', [{ ...e, id, sql: e.sql.slice(0, 100_000) }, ...arr].slice(0, MAX_HISTORY))
  }

  clearHistory() {
    this.writeJson('history.json', [])
  }

  // ───────── SSH 호스트 키 ─────────

  hostKeys(): HostKeys & { forget(hostPort: string): void } {
    return {
      get: (hp) => this.readJson<Record<string, string>>('known_hosts.json', {})[hp],
      set: (hp, fp) => this.writeJson('known_hosts.json', { ...this.readJson<Record<string, string>>('known_hosts.json', {}), [hp]: fp }),
      forget: (hp) => {
        const all = this.readJson<Record<string, string>>('known_hosts.json', {})
        delete all[hp]
        this.writeJson('known_hosts.json', all)
      },
    }
  }
}
