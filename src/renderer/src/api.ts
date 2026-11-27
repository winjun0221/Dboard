import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Api, AppSettings, TableRef } from '../../shared/types'

declare global {
  interface Window {
    api: Api
  }
}

export const api = window.api

export const DEFAULT_SETTINGS: AppSettings = { theme: 'system', language: 'auto', zoom: 0, autoUpdate: true, maxRows: 500, pageSize: 200, editorFontSize: 13, confirmDangerous: true, queryParams: true }

export const useConnections = () => useQuery({ queryKey: ['connections'], queryFn: () => api.listConnections() })

// 배율은 단축키(Ctrl +/-/0)로 메인 쪽에서도 바뀌므로 화면을 열 때마다 다시 읽는다
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api.settings(), refetchOnMount: 'always' })

// 탐색기: 쿼리 키 두 번째 칸이 접속 id → refreshConn(id)로 그 접속 것만 다시 읽기
export const useDatabases = (connId: string, enabled: boolean) =>
  useQuery({ queryKey: ['databases', connId], queryFn: () => api.databases(connId), enabled })
export const useSchemas = (connId: string, db: string, enabled: boolean) =>
  useQuery({ queryKey: ['schemas', connId, db], queryFn: () => api.schemas(connId, db), enabled })
export const useObjects = (connId: string, db: string, schema: string, enabled: boolean) =>
  useQuery({ queryKey: ['objects', connId, db, schema], queryFn: () => api.objects(connId, db, schema), enabled })
export const useExtras = (connId: string, db: string, schema: string, enabled: boolean) =>
  useQuery({ queryKey: ['extras', connId, db, schema], queryFn: () => api.extraObjects(connId, db, schema), enabled })
export const useColumns = (connId: string, ref: TableRef, enabled: boolean) =>
  useQuery({ queryKey: ['columns', connId, ref.db, ref.schema, ref.table], queryFn: () => api.columns(connId, ref), enabled })
export const useIndexes = (connId: string, ref: TableRef, enabled: boolean) =>
  useQuery({ queryKey: ['indexes', connId, ref.db, ref.schema, ref.table], queryFn: () => api.indexes(connId, ref), enabled })
export const useCompletion = (connId: string, db: string, schema: string, enabled: boolean) =>
  useQuery({ queryKey: ['completion', connId, db, schema], queryFn: () => api.completion(connId, db, schema), enabled, retry: false })

export function useRefreshConn() {
  const qc = useQueryClient()
  return (connId: string) => {
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === connId && q.queryKey[0] !== 'connections' })
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
}

/** 자동 업데이트 상태: 받는 중이면 1초, 아니면 30초마다 */
export const useUpdateStatus = () =>
  useQuery({
    queryKey: ['update'],
    queryFn: () => api.updateStatus(),
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.state === 'downloading' || q.state.data?.state === 'checking' ? 1000 : 30_000),
  })
