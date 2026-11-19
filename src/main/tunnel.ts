// SSH 터널: SSH 서버에 붙은 뒤 이 PC의 127.0.0.1:임시 포트 → (SSH 서버에서 본) DB 주소:포트로 이어 준다.
// 호스트 키는 처음 붙을 때 기억하고(TOFU), 다음부터 다르면 연결하지 않는다(중간자 공격 방지).
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import { Client, utils } from 'ssh2'
import { t } from '../shared/i18n'
import type { SshConfig } from '../shared/types'
import type { Endpoint } from './drivers/base'

export interface HostKeys {
  get(hostPort: string): string | undefined
  set(hostPort: string, fingerprint: string): void
}

export interface Tunnel {
  port: number
  /** 처음 본 호스트 키였으면 그 지문 (화면에 알려 줌) */
  newHostKey: string | null
  close(): void
}

export interface SshSecrets {
  password: string
  passphrase: string
}

/** 개인 키에 암호가 걸려 있는지 (연결 전에 암호를 물어볼지) */
export function keyNeedsPassphrase(keyFile: string): boolean {
  try {
    const r = utils.parseKey(fs.readFileSync(keyFile))
    return r instanceof Error && /passphrase/i.test(r.message)
  } catch {
    return false
  }
}

export function openTunnel(cfg: SshConfig, secrets: SshSecrets, target: Endpoint, keys: HostKeys): Promise<Tunnel> {
  const hostPort = `${cfg.host}:${cfg.port}`
  let newHostKey: string | null = null
  let mismatch: { known: string; got: string } | null = null

  return new Promise((resolve, reject) => {
    const client = new Client()
    let server: net.Server | null = null
    let settled = false
    const fail = (e: Error) => {
      if (settled) return
      settled = true
      server?.close()
      client.end()
      reject(e)
    }

    client.on('error', (e) => {
      if (mismatch) fail(new Error(t('SSH 서버의 호스트 키가 처음과 달라요. 서버를 바꾼 게 아니라면 연결하지 마세요.\n저장된 키: {known}\n받은 키: {got}', mismatch)))
      else fail(new Error(t('SSH 연결 실패: {error}', { error: e.message })))
    })
    client.on('ready', () => {
      // 이 PC 안에서만 받는 임시 포트
      server = net.createServer((sock) => {
        client.forwardOut('127.0.0.1', sock.remotePort ?? 0, target.host, target.port, (err, stream) => {
          if (err) {
            sock.destroy()
            return
          }
          sock.pipe(stream).pipe(sock)
          const end = () => {
            sock.destroy()
            stream.destroy()
          }
          sock.on('error', end)
          stream.on('error', end)
          sock.on('close', () => stream.end())
          stream.on('close', () => sock.destroy())
        })
      })
      server.on('error', (e) => fail(e))
      server.listen(0, '127.0.0.1', () => {
        settled = true
        const port = (server!.address() as net.AddressInfo).port
        resolve({
          port,
          newHostKey,
          close: () => {
            server?.close()
            client.end()
          },
        })
      })
    })

    let privateKey: Buffer | undefined
    if (cfg.auth === 'key') {
      try {
        privateKey = fs.readFileSync(cfg.keyFile)
      } catch {
        fail(new Error(t('SSH 개인 키 파일을 읽지 못했어요: {file}', { file: cfg.keyFile })))
        return
      }
    }

    client.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.user,
      readyTimeout: 20_000,
      keepaliveInterval: 30_000,
      ...(cfg.auth === 'key' ? { privateKey, passphrase: secrets.passphrase || undefined } : { password: secrets.password }),
      hostVerifier: (key: Buffer) => {
        const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
        const known = keys.get(hostPort)
        if (!known) {
          keys.set(hostPort, fp)
          newHostKey = fp
          return true
        }
        if (known === fp) return true
        mismatch = { known, got: fp }
        return false
      },
    })
  })
}
