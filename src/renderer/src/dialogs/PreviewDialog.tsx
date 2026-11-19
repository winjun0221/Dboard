import { Save, TriangleAlert } from 'lucide-react'
import type { DriverKind } from '../../../shared/types'
import { Dialog } from '../components/Dialog'
import { SqlEditor } from '../components/SqlEditor'
import { api } from '../api'
import { t } from '../i18n'

/** 저장 전에 실행할 SQL 보기 (값은 읽기 좋게 글자로 넣어 보여 주고, 실제로는 자리 표시 + 값으로 보낸다) */
export function PreviewDialog({ driver, sql, summary, warn, onClose, onSubmit }: {
  driver: DriverKind
  sql: string
  summary: string
  warn?: string
  onClose: () => void
  onSubmit: () => Promise<void>
}) {
  return (
    <Dialog title={t('저장 전 미리 보기')} icon={Save} width={760} submitLabel={t('저장 (한 트랜잭션)')} onClose={onClose} onSubmit={onSubmit}
      footer={<button type="button" className="btn" onClick={() => void api.copyText(sql)}>{t('SQL 복사')}</button>}>
      <p className="preview-summary"><b>{summary}</b><span className="muted small">{t('하나라도 실패하면 전부 되돌려요.')}</span></p>
      {warn && <div className="banner warn inline"><TriangleAlert />{warn}</div>}
      <div className="preview-sql">
        <SqlEditor initial={sql} driver={driver} fontSize={12.5} readOnly />
      </div>
    </Dialog>
  )
}
