// 대상 고르기: 접속 → DB → (스키마). 스키마 비교·데이터 옮기기가 쓴다. 대화 상자 안이라 useWs 대신 props
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Database, FolderTree } from 'lucide-react'
import type { ConnectionInfo } from '../../../shared/types'
import { api } from '../api'
import { t } from '../i18n'
import { DriverBadge } from '../components/DriverBadge'

export interface Target {
  connId: string
  db: string
  schema: string
}

export function TargetPicker({ connections, value, onChange, ensureConnected, allow }: {
  connections: ConnectionInfo[]
  value: Target
  onChange: (v: Target) => void
  ensureConnected: (id: string) => Promise<boolean>
  /** 고를 수 없는 접속이면 이유 (같은 종류 DB만 등) */
  allow?: (c: ConnectionInfo) => string | null
}) {
  const [ready, setReady] = useState<string | null>(null)
  const conn = connections.find((c) => c.id === value.connId)
  useEffect(() => {
    let alive = true
    if (!value.connId) return
    void ensureConnected(value.connId).then((ok) => alive && setReady(ok ? value.connId : null))
    return () => {
      alive = false
    }
  }, [value.connId, ensureConnected])
  const on = ready === value.connId
  const dbs = useQuery({ queryKey: ['databases', value.connId], queryFn: () => api.databases(value.connId), enabled: on })
  const hasSchemas = !!dbs.data?.hasSchemas
  const schemas = useQuery({ queryKey: ['schemas', value.connId, value.db], queryFn: () => api.schemas(value.connId, value.db), enabled: on && hasSchemas && !!value.db })
  // DB·스키마 처음 값
  useEffect(() => {
    if (!dbs.data || !conn) return
    const list = dbs.data.databases
    if (!value.db || !list.includes(value.db)) {
      const db = list.includes(conn.database) ? conn.database : list[0] ?? ''
      onChange({ ...value, db, schema: dbs.data.hasSchemas ? dbs.data.defaultSchema : '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbs.data, conn])

  return (
    <div className="target-picker">
      <label className="ctx-pick">
        {conn && <DriverBadge driver={conn.driver} size={14} />}
        <select value={value.connId} aria-label={t('대상 접속')} onChange={(e) => onChange({ connId: e.target.value, db: '', schema: '' })}>
          <option value="" disabled>{t('(접속 고르기)')}</option>
          {connections.map((c) => {
            const why = allow?.(c) ?? null
            return <option key={c.id} value={c.id} disabled={!!why}>{c.name}{why ? ` — ${why}` : ''}</option>
          })}
        </select>
      </label>
      {conn && conn.driver !== 'sqlite' && (
        <label className="ctx-pick">
          <Database />
          <select value={value.db} aria-label={t('대상 DB')} disabled={!dbs.data} onChange={(e) => onChange({ ...value, db: e.target.value, schema: hasSchemas ? dbs.data!.defaultSchema : '' })}>
            {(dbs.data?.databases ?? (value.db ? [value.db] : [])).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
      )}
      {hasSchemas && (
        <label className="ctx-pick">
          <FolderTree />
          <select value={value.schema} aria-label={t('대상 스키마')} disabled={!schemas.data} onChange={(e) => onChange({ ...value, schema: e.target.value })}>
            {value.schema && !(schemas.data ?? []).includes(value.schema) && <option value={value.schema}>{value.schema}</option>}
            {(schemas.data ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}
    </div>
  )
}
