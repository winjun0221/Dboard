// 구조를 바꾸는 문장 미리 보기 → 실행 (표 설계 저장·이름 바꾸기·비우기·지우기). 대화 상자라 useWs 금지: 필요한 것은 props로
import { ScrollText, TriangleAlert } from 'lucide-react'
import type { DriverKind } from '../../../shared/types'
import { Dialog } from '../components/Dialog'
import { SqlEditor } from '../components/SqlEditor'
import { api } from '../api'
import { t } from '../i18n'

export function DdlDialog({ title, driver, statements, warnings = [], production, danger, submitLabel, onClose, onSubmit }: {
  title: string
  driver: DriverKind
  statements: string[]
  warnings?: string[]
  /** 운영 DB면 빨간 알림 */
  production?: boolean
  danger?: boolean
  submitLabel?: string
  onClose: () => void
  onSubmit: () => Promise<void>
}) {
  // SQL Server는 GO로 나눠 보여 줘야 편집기에 붙여 넣어도 그대로 돈다 (DECLARE가 문장마다 따로)
  const sql = statements.join(driver === 'mssql' ? '\nGO\n' : ';\n') + (driver === 'mssql' ? '' : ';')
  return (
    <Dialog title={title} icon={ScrollText} width={760} danger={danger} submitLabel={submitLabel ?? t('실행')} onClose={onClose} onSubmit={onSubmit}
      footer={<button type="button" className="btn" onClick={() => void api.copyText(sql)}>{t('SQL 복사')}</button>}>
      <p className="preview-summary"><b>{t('실행할 문장 {n}개', { n: statements.length })}</b><span className="muted small">{t('오류가 나면 거기서 멈추고 되돌리기를 시도해요.')}</span></p>
      {production && <div className="banner error inline"><TriangleAlert />{t('운영 DB예요. 실행하기 전에 한 번 더 확인해 주세요.')}</div>}
      {warnings.map((w) => <div key={w} className="banner warn inline"><TriangleAlert />{w}</div>)}
      <div className="preview-sql">
        <SqlEditor initial={sql} driver={driver} fontSize={12.5} readOnly />
      </div>
    </Dialog>
  )
}
