// SQL 파일 실행 (덤프 다시 넣기 등): 파일 고르기 → 이 접속·DB에 문장마다 차례로. 오류 나면 멈추고 어디서인지 보여 준다
import { useState } from 'react'
import { FileCode2, FolderOpen, LoaderCircle, Square, TriangleAlert } from 'lucide-react'
import { api, errorText, useRefreshConn } from '../api'
import type { ConnectionInfo } from '../../../shared/types'
import { useUi } from '../ui'
import { t } from '../i18n'
import { fmtNum, formatMs, randomKey } from '../format'
import { Dialog } from '../components/Dialog'
import { DriverBadge } from '../components/DriverBadge'

// 대화 상자는 작업 공간(WsProvider) 바깥에 그려지므로 접속 정보·연결 함수는 props로 받는다
export function RunFileDialog({ conn, ensureConnected, db, schema, onClose }: {
  conn: ConnectionInfo
  ensureConnected: () => Promise<boolean>
  db: string
  schema: string
  onClose: () => void
}) {
  const ui = useUi()
  const refresh = useRefreshConn()
  const connId = conn.id
  const [file, setFile] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const place = [db, schema].filter(Boolean).join(' · ')

  const pick = async () => {
    try {
      const f = await api.pickSqlFile()
      if (f) {
        setFile(f)
        setError(null)
      }
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  const run = async () => {
    if (!file) return
    if (!(await ensureConnected())) return
    const key = 'file-' + randomKey()
    setRunning(key)
    setError(null)
    try {
      const r = await api.runSqlFile(connId, key, db, schema, file)
      ui.notify(t('SQL 파일을 실행했어요: 문장 {n}개 · {time}', { n: fmtNum(r.statements), time: formatMs(r.ms) }), 'success')
      refresh(connId)
      onClose()
    } catch (e) {
      setError(errorText(e))
      refresh(connId)
    } finally {
      setRunning(null)
    }
  }

  return (
    <Dialog
      title={t('SQL 파일 실행')}
      icon={FileCode2}
      width={540}
      submitLabel={t('실행')}
      disabled={!file}
      onClose={onClose}
      onSubmit={run}
      footer={running && <button type="button" className="btn" onClick={() => void api.cancelSql(running)}><Square />{t('중지')}</button>}
    >
      <p className="dump-target">
        <DriverBadge driver={conn.driver} size={16} />
        <b>{conn.name}</b>
        {place && <span className="muted">· {place}</span>}
      </p>
      <div className="row-input">
        <input readOnly value={file ?? ''} placeholder={t('덤프 등 .sql 파일')} className="mono" title={file ?? ''} />
        <button type="button" className="btn" onClick={() => void pick()} disabled={!!running}><FolderOpen />{t('파일 고르기…')}</button>
      </div>
      <p className="muted small">{t('파일의 문장을 위 DB에 차례로 실행해요. 오류가 나면 거기서 멈추고, 트랜잭션 안이었다면 되돌려요. 다른 DB에 넣으려면 탐색기에서 그 DB를 오른쪽 클릭하세요.')}</p>
      {running && <span className="busy"><LoaderCircle className="spin" />{t('실행 중…')}</span>}
      {error && <div className="banner error inline"><TriangleAlert /><pre>{error}</pre></div>}
    </Dialog>
  )
}
