// 쿼리 변수(:이름, ${이름}) 값 넣기. 값은 SQL에 그대로 들어간다 (글자는 따옴표까지)
import { useState } from 'react'
import { Variable } from 'lucide-react'
import { Dialog } from '../components/Dialog'
import { t } from '../i18n'

export function ParamsDialog({ names, initial, onClose, onSubmit }: { names: string[]; initial: Record<string, string>; onClose: () => void; onSubmit: (values: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(names.map((n) => [n, initial[n] ?? ''])))
  return (
    <Dialog title={t('쿼리 변수')} icon={Variable} width={520} submitLabel={t('실행')} onClose={onClose} onSubmit={() => onSubmit(values)}>
      <p className="muted small">{t("값은 SQL에 그대로 들어가요. 글자는 따옴표까지 적어 주세요 (예: 'abc'). 숫자는 그대로 (예: 42).")}</p>
      <div className="params-grid">
        {names.map((n) => (
          <label key={n} className="field params-row">
            <span className="field-label mono">{n}</span>
            <input className="mono" value={values[n]} spellCheck={false} onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))} />
          </label>
        ))}
      </div>
    </Dialog>
  )
}
