// 열린 연결 관리: 접속 정보 하나당 터널 + 시스템 표 읽는 연결(PostgreSQL은 DB마다) + SQL 편집기 탭마다 연결 하나
// Electron을 쓰지 않아서 테스트에서 그대로 쓴다.
import { t } from '../shared/i18n'
import type { ConnectionConfig } from '../shared/types'
import type { DriverModule, Endpoint, Session } from './drivers/base'
import { driverOf } from './drivers'
import { openTunnel, type HostKeys, type Tunnel } from './tunnel'

export interface Resolved {
  config: ConnectionConfig
  password: string
  sshPassword: string
  sshPassphrase: string
}

export class Live {
  readonly mod: DriverModule
  private meta = new Map<string, Promise<Session>>()
  version = ''
  newHostKey: string | null = null

  constructor(readonly r: Resolved, private endpoint: Endpoint, private tunnel: Tunnel | null) {
    this.mod = driverOf(r.config.driver)
  }

  get config() {
    return this.r.config
  }

  get defaultDb(): string {
    return this.mod.defaultDatabase(this.r.config)
  }

  async open(db: string): Promise<Session> {
    const s = await this.mod.open({ config: this.r.config, endpoint: this.endpoint, password: this.r.password, database: db })
    if (this.r.config.readOnly === true) {
      try {
        await s.applyReadOnly()
      } catch (e) {
        await s.close().catch(() => undefined)
        throw e
      }
    }
    return s
  }

  /** 시스템 표 읽기·표 데이터용 연결. PostgreSQL만 DB마다 따로 */
  async metaSession(db = ''): Promise<Session> {
    const key = this.mod.perDatabase ? db || this.defaultDb : ''
    const cur = this.meta.get(key)
    if (cur) {
      const s = await cur.catch(() => null)
      if (s && !s.dead) return s
      this.meta.delete(key)
      void s?.close().catch(() => undefined)
    }
    const p = this.open(this.mod.perDatabase ? key : this.r.config.database)
    this.meta.set(key, p)
    p.catch(() => this.meta.delete(key))
    return p
  }

  async close() {
    const all = [...this.meta.values()]
    this.meta.clear()
    await Promise.all(all.map((p) => p.then((s) => s.close()).catch(() => undefined)))
    this.tunnel?.close()
  }
}

interface Editor {
  connId: string
  db: string
  schema: string
  session: Promise<Session>
}

export class Manager {
  private live = new Map<string, Live>()
  private connecting = new Map<string, Promise<Live>>()
  private editors = new Map<string, Editor>()

  constructor(private hostKeys: HostKeys) {}

  /** 터널을 열고 시스템 표 연결로 확인. 이미 열려 있으면 그대로 */
  async connect(id: string, r: Resolved): Promise<Live> {
    const cur = this.live.get(id)
    if (cur) return cur
    const pending = this.connecting.get(id)
    if (pending) return pending
    const p = (async () => {
      const c = r.config
      let tunnel: Tunnel | null = null
      let endpoint: Endpoint = { host: c.host, port: c.port }
      if (c.ssh.enabled && c.driver !== 'sqlite') {
        tunnel = await openTunnel(c.ssh, { password: r.sshPassword, passphrase: r.sshPassphrase }, endpoint, this.hostKeys)
        endpoint = { host: '127.0.0.1', port: tunnel.port }
      }
      const live = new Live(r, endpoint, tunnel)
      live.newHostKey = tunnel?.newHostKey ?? null
      try {
        const s = await live.metaSession()
        live.version = await live.mod.version(s)
      } catch (e) {
        await live.close()
        throw e
      }
      this.live.set(id, live)
      return live
    })()
    this.connecting.set(id, p)
    try {
      return await p
    } finally {
      this.connecting.delete(id)
    }
  }

  isConnected(id: string) {
    return this.live.has(id)
  }

  connectedIds() {
    return [...this.live.keys()]
  }

  get(id: string): Live {
    const l = this.live.get(id)
    if (!l) throw new Error(t('연결되지 않았어요. 먼저 연결해 주세요.'))
    return l
  }

  async disconnect(id: string) {
    for (const [key, e] of [...this.editors]) if (e.connId === id) await this.closeEditor(key)
    const l = this.live.get(id)
    this.live.delete(id)
    await l?.close()
  }

  async disconnectAll() {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id)))
  }

  /** 편집기 탭의 연결. DB가 바뀌면 USE(되면) 아니면 새로 열고, 스키마는 search_path */
  async editorSession(connId: string, tabKey: string, db: string, schema: string): Promise<Session> {
    const live = this.get(connId)
    const want = db || live.defaultDb
    let e = this.editors.get(tabKey)
    if (e && e.connId !== connId) {
      await this.closeEditor(tabKey)
      e = undefined
    }
    if (e) {
      const s = await e.session.catch(() => null)
      if (!s || s.dead) {
        this.editors.delete(tabKey)
        e = undefined
      } else {
        if (e.db !== want) {
          if (await s.useDatabase(want)) e.db = want
          else {
            await this.closeEditor(tabKey)
            e = undefined
          }
        }
        if (e && e.schema !== schema) {
          await s.setSchema(schema)
          e.schema = schema
        }
        if (e) return s
      }
    }
    const p = (async () => {
      const s = await live.open(want)
      try {
        if (want && live.mod.dialect !== 'postgres') await s.useDatabase(want)
        if (schema) await s.setSchema(schema)
      } catch (err) {
        await s.close().catch(() => undefined)
        throw err
      }
      return s
    })()
    this.editors.set(tabKey, { connId, db: want, schema, session: p })
    p.catch(() => {
      if (this.editors.get(tabKey)?.session === p) this.editors.delete(tabKey)
    })
    return p
  }

  /** 이미 열린 편집기 연결 (없으면 null — 커밋·롤백할 것도 없다) */
  async existingEditor(tabKey: string): Promise<Session | null> {
    const e = this.editors.get(tabKey)
    if (!e) return null
    const s = await e.session.catch(() => null)
    return s && !s.dead ? s : null
  }

  async cancel(tabKey: string) {
    const e = this.editors.get(tabKey)
    if (!e) return
    const s = await e.session.catch(() => null)
    await s?.cancel()
  }

  async closeEditor(tabKey: string) {
    const e = this.editors.get(tabKey)
    if (!e) return
    this.editors.delete(tabKey)
    const s = await e.session.catch(() => null)
    await s?.close().catch(() => undefined)
  }
}
