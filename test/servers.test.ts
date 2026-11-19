// 실제 DB 서버(Docker) 시험: npm run test:db 로 돌린다 (DBOARD_TEST_DBS=1이 없으면 건너뜀)
import { describe, expect, it } from 'vitest'
import { Manager } from '../src/main/conn'
import { quoteIdent } from '../src/shared/dialect'
import { config, exercise, memoryKeys, resolved } from './exercise'

const ON = process.env.DBOARD_TEST_DBS === '1'
const rand = () => Math.random().toString(36).slice(2, 8)

describe.skipIf(!ON)('real servers', () => {
  for (const kind of ['mysql', 'mariadb'] as const) {
    it(kind, async () => {
      const m = new Manager(memoryKeys())
      const db = 'dboard_t_' + rand()
      try {
        await exercise(m, kind, resolved(config(kind)), async (mm) => {
          await (await mm.get(kind).metaSession()).exec(`CREATE DATABASE ${quoteIdent('mysql', db)} CHARACTER SET utf8mb4`)
          return { db, schema: '' }
        }, async (mm) => {
          await (await mm.get(kind).metaSession()).exec(`DROP DATABASE ${quoteIdent('mysql', db)}`)
        })
      } finally {
        await m.disconnectAll()
      }
    })
  }

  it('postgres', async () => {
    const m = new Manager(memoryKeys())
    const schema = 't_' + rand()
    try {
      await exercise(m, 'pg', resolved(config('postgres', { database: 'dboard_test' })), async (mm) => {
        await (await mm.get('pg').metaSession('dboard_test')).exec(`CREATE SCHEMA ${quoteIdent('postgres', schema)}`)
        return { db: 'dboard_test', schema }
      }, async (mm) => {
        await (await mm.get('pg').metaSession('dboard_test')).exec(`DROP SCHEMA ${quoteIdent('postgres', schema)} CASCADE`)
      })
    } finally {
      await m.disconnectAll()
    }
  })

  it('sql server', async () => {
    const m = new Manager(memoryKeys())
    const db = 'dboard_t_' + rand()
    try {
      await exercise(m, 'ms', resolved(config('mssql')), async (mm) => {
        await (await mm.get('ms').metaSession()).exec(`CREATE DATABASE ${quoteIdent('mssql', db)}`)
        return { db, schema: 'dbo' }
      }, async (mm) => {
        await mm.disconnect('ms')
        const again = await mm.connect('ms2', resolved(config('mssql')))
        await (await again.metaSession()).exec(`DROP DATABASE ${quoteIdent('mssql', db)}`)
      })
    } finally {
      await m.disconnectAll()
    }
  })

  it('ssh tunnel to postgres (host key remembered, then mismatch refused)', async () => {
    const keys = memoryKeys()
    const ssh = { enabled: true, host: '127.0.0.1', port: 22221, user: 'dboard', auth: 'password' as const, keyFile: '' }
    // 터널 너머에서 본 주소: 같은 Docker 망의 postgres:5432
    const c = config('postgres', { host: 'postgres', port: 5432, database: 'dboard_test', ssh })
    const m = new Manager(keys)
    try {
      const live = await m.connect('t', resolved(c, { sshPassword: 'dboard_test' }))
      expect(live.version).toMatch(/PostgreSQL/)
      expect(live.newHostKey).toMatch(/^SHA256:/)
      const s = await m.editorSession('t', 'tab-ssh', 'dboard_test', 'public')
      expect((await s.run('SELECT 42', 10))[0].rows[0][0]).toBe(42)
      await m.disconnect('t')
      // 다시: 기억한 키와 같으면 새 키 알림 없음
      expect((await m.connect('t', resolved(c, { sshPassword: 'dboard_test' }))).newHostKey).toBeNull()
      await m.disconnect('t')
      // 틀린 비밀번호
      await expect(m.connect('t', resolved(c, { sshPassword: 'wrong' }))).rejects.toThrow(/SSH/)
      // 키가 바뀐 것처럼
      keys.map.set('127.0.0.1:22221', 'SHA256:different')
      await expect(m.connect('t', resolved(c, { sshPassword: 'dboard_test' }))).rejects.toThrow(/호스트 키/)
    } finally {
      await m.disconnectAll()
    }
  })

  it('wrong password gives a clear error', async () => {
    const m = new Manager(memoryKeys())
    await expect(m.connect('x', resolved(config('postgres'), { password: 'nope' }))).rejects.toThrow(/password/i)
    await expect(m.connect('y', resolved(config('mysql'), { password: 'nope' }))).rejects.toThrow(/denied/i)
    await expect(m.connect('z', resolved(config('mssql'), { password: 'nope' }))).rejects.toThrow(/Login failed/i)
  })
})
