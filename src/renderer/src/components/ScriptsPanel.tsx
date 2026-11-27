// 스크립트: 스크립트 폴더(앱 데이터 아래 Scripts)의 .sql 파일과 최근 연 파일. 누르면 편집기로 열기 (이미 열려 있으면 그 탭)
import { useState, type MouseEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eraser, FileCode2, FolderOpen, FolderInput, RefreshCw, Search, SquareTerminal, X } from 'lucide-react'
import type { ScriptEntry } from '../../../shared/types'
import { api, errorText } from '../api'
import { useWs } from '../ws'
import { useUi } from '../ui'
import { t } from '../i18n'

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function ScriptsPanel({ onOpenFile, onNewEditor }: { onOpenFile: () => void; onNewEditor: () => void }) {
  const ws = useWs()
  const ui = useUi()
  const q = useQuery({ queryKey: ['scripts'], queryFn: () => api.listScripts(), refetchOnWindowFocus: true })
  const [filter, setFilter] = useState('')
  const active = ws.tabs.find((x) => x.id === ws.active)
  const activeFile = active?.kind === 'editor' ? active.file : undefined

  const open = async (f: ScriptEntry) => {
    try {
      ws.openScript(await api.readSqlFile(f.path))
    } catch (e) {
      ui.notify(errorText(e), 'error')
      void q.refetch()
    }
  }
  const menu = (e: MouseEvent, f: ScriptEntry) => ui.menu(e, [
    { label: t('열기'), icon: SquareTerminal, onClick: () => void open(f) },
    { label: t('Windows 탐색기에서 보기'), icon: FolderOpen, onClick: () => void api.revealScript(f.path).catch((err) => ui.notify(errorText(err), 'error')) },
    f.folder === null && { label: t('목록에서 빼기'), icon: Eraser, onClick: async () => { await api.forgetScript(f.path); void q.refetch() } },
  ])

  const needle = filter.trim().toLowerCase()
  const all = (q.data?.files ?? []).filter((f) => !needle || f.name.toLowerCase().includes(needle) || (f.folder ?? '').toLowerCase().includes(needle))
  const inFolder = all.filter((f) => f.folder !== null).sort((a, b) => (a.folder! + '/' + a.name < b.folder! + '/' + b.name ? -1 : 1))
  const recent = all.filter((f) => f.folder === null)
  const row = (f: ScriptEntry) => (
    <div key={f.path} className={`tree-row script-row ${activeFile && samePath(activeFile, f.path) ? 'sel' : ''}`} style={{ paddingLeft: 8 }} role="treeitem" tabIndex={-1}
      title={f.path} onClick={() => void open(f)} onContextMenu={(e) => menu(e, f)}>
      <span className="tree-icon"><FileCode2 className="sql-icon" /></span>
      <span className="tree-label ellipsis">{f.folder ? <span className="muted">{f.folder}/</span> : null}{f.name}</span>
      <span className="tree-extra muted">{new Date(f.mtime).toLocaleDateString()}</span>
    </div>
  )

  return (
    <div className="navigator scripts-panel">
      <div className="side-tools" role="toolbar">
        <button className="icon-btn small" title={t('새 SQL 편집기')} onClick={onNewEditor}><SquareTerminal /></button>
        <button className="icon-btn small" title={t('SQL 파일 열기… (Ctrl+O)')} onClick={onOpenFile}><FolderOpen /></button>
        <button className="icon-btn small" title={t('새로고침')} onClick={() => void q.refetch()}><RefreshCw /></button>
        <span className="spacer" />
        <button className="icon-btn small" title={t('스크립트 폴더 열기')} onClick={() => void api.revealScript(null)}><FolderInput /></button>
      </div>
      <div className="side-search">
        <Search />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('스크립트 찾기')} spellCheck={false} />
        {filter && <button className="icon-btn small" onClick={() => setFilter('')} aria-label={t('지우기')}><X /></button>}
      </div>
      <div className="tree" role="tree">
        <div className="tree-section" title={q.data?.dir}>{t('스크립트 폴더')}</div>
        {q.error && <div className="tree-empty error">{errorText(q.error)}</div>}
        {q.data && inFolder.length === 0 && <div className="tree-empty">{needle ? t('맞는 스크립트가 없어요') : t('아직 저장한 스크립트가 없어요. 편집기에서 Ctrl+S로 저장하면 여기에 보여요.')}</div>}
        {inFolder.map(row)}
        {recent.length > 0 && <div className="tree-section">{t('최근 연 파일')}</div>}
        {recent.map(row)}
      </div>
    </div>
  )
}
