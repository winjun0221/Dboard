// 이름 하나 받기 (표·뷰 이름 바꾸기 등)
import { useState } from 'react'
import { PenLine } from 'lucide-react'
import { Dialog } from '../components/Dialog'
import { t } from '../i18n'

export function RenameDialog({ title, current, label, allowEmpty, suggestions, onClose, onSubmit }: {
  title: string
  current: string
  label?: string
  /** 비워도 됨 (폴더에서 빼기 등) */
  allowEmpty?: boolean
  suggestions?: string[]
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState(current)
  const ok = (allowEmpty || name.trim() !== '') && name.trim() !== current
  return (
    <Dialog title={title} icon={PenLine} width={420} submitLabel={t('다음')} disabled={!ok} onClose={onClose} onSubmit={() => onSubmit(name.trim())}>
      <label className="field">
        <span className="field-label">{label ?? t('새 이름')}</span>
        <input value={name} spellCheck={false} list={suggestions?.length ? 'rename-suggest' : undefined} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        {suggestions && suggestions.length > 0 && <datalist id="rename-suggest">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>}
      </label>
    </Dialog>
  )
}
