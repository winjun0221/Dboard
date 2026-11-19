import { useState } from 'react'
import { Pencil } from 'lucide-react'
import type { Cell } from '../../../shared/types'
import { Check, Dialog } from '../components/Dialog'
import { cellText } from '../format'
import { t } from '../i18n'

/** 긴 값·여러 줄 값 고치기 (NULL로 두기 포함) */
export function ValueDialog({ column, type, value, readOnly, onClose, onSubmit }: {
  column: string
  type: string
  value: Cell
  readOnly?: boolean
  onClose: () => void
  onSubmit: (v: Cell) => void
}) {
  const [text, setText] = useState(value === null ? '' : cellText(value))
  const [isNull, setIsNull] = useState(value === null)
  return (
    <Dialog title={<>{column} <span className="muted small mono">{type}</span></>} icon={Pencil} width={620} submitLabel={t('바꾸기')} onClose={onClose} onSubmit={readOnly ? undefined : () => onSubmit(isNull ? null : text)}>
      <textarea className="value-text mono" value={text} disabled={isNull || readOnly} onChange={(e) => setText(e.target.value)} rows={12} spellCheck={false} />
      {!readOnly && <Check checked={isNull} onChange={setIsNull}>NULL</Check>}
    </Dialog>
  )
}
