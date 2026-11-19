import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import { Store } from '../src/main/store'
import { config, exercise, memoryKeys, resolved } from './exercise'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dboard-test-'))

describe('sqlite', () => {
  it('full scenario on a file', async () => {
    const dir = tmp()
    const file = path.join(dir, 'test.db')
    fs.writeFileSync(file, '')
    const m = new Manager(memoryKeys())
    try {
      await exercise(m, 'lite', resolved(config('sqlite', { file })), async () => ({ db: 'main', schema: '' }), async () => {})
    } finally {
      await m.disconnectAll()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a missing file instead of creating it', async () => {
    const m = new Manager(memoryKeys())
    const file = path.join(tmp(), 'nope.db')
    await expect(m.connect('x', resolved(config('sqlite', { file })))).rejects.toThrow(/SQLite/)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('does not allow loading extensions', async () => {
    const dir = tmp()
    const file = path.join(dir, 'x.db')
    fs.writeFileSync(file, '')
    const m = new Manager(memoryKeys())
    try {
      await m.connect('x', resolved(config('sqlite', { file })))
      const s = await m.editorSession('x', 'tab', 'main', '')
      await expect(s.run("SELECT load_extension('evil')", 10)).rejects.toThrow()
    } finally {
      await m.disconnectAll()
    }
  })
})

describe('store', () => {
  const fakeCrypto = {
    available: () => true,
    encrypt: (s: string) => 'enc:' + Buffer.from(s).toString('base64'),
    decrypt: (s: string) => Buffer.from(s.slice(4), 'base64').toString(),
  }

  it('encrypts secrets and never lists them', () => {
    const dir = tmp()
    const store = new Store(dir, fakeCrypto)
    const info = store.save({ ...config('postgres'), id: '' }, { password: 'p@ss-비밀' })
    expect(info.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(info.saved.password).toBe(true)
    expect(JSON.stringify(store.list())).not.toContain('p@ss')
    const raw = fs.readFileSync(path.join(dir, 'connections.json'), 'utf8')
    expect(raw).not.toContain('p@ss')
    expect(store.secrets(info.id).password).toBe('p@ss-비밀')
    // 안 보낸 칸은 그대로, 빈 글자는 지움
    store.save({ ...store.config(info.id), name: 'renamed' }, {})
    expect(store.secrets(info.id).password).toBe('p@ss-비밀')
    store.save(store.config(info.id), { password: '' })
    expect(store.secrets(info.id).password).toBeUndefined()
    // 저장 끄면 지움
    store.save(store.config(info.id), { password: 'x' })
    store.save({ ...store.config(info.id), savePassword: false }, {})
    expect(store.list()[0].saved.password).toBe(false)
  })

  it('refuses to save when encryption is unavailable', () => {
    const store = new Store(tmp(), { ...fakeCrypto, available: () => false })
    expect(() => store.save({ ...config('mysql'), id: '' }, { password: 'x' })).toThrow()
    expect(store.save({ ...config('mysql'), id: '', savePassword: false }, { password: 'x' }).saved.password).toBe(false)
  })

  it('duplicate, move, history cap and search', () => {
    const store = new Store(tmp(), fakeCrypto)
    const a = store.save({ ...config('mysql'), id: '', name: 'A' }, {})
    const b = store.save({ ...config('mysql'), id: '', name: 'B' }, {})
    store.duplicate(a.id, ' copy')
    expect(store.list().map((c) => c.name)).toEqual(['A', 'A copy', 'B'])
    store.move(b.id, 0)
    expect(store.list()[0].name).toBe('B')
    for (let i = 0; i < 1005; i++) store.addHistory({ at: i, connId: a.id, connName: 'A', db: '', sql: 'SELECT ' + i, ms: 1, rows: 1, error: null })
    expect(store.history('', 2000)).toHaveLength(1000)
    expect(store.history('SELECT 1004', 10)[0].sql).toBe('SELECT 1004')
  })
})
