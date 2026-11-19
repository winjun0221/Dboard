import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import type { SecretName, SecretsInput } from '../../../shared/types'
import { Dialog, Field } from '../components/Dialog'
import { t, tk } from '../i18n'

const LABEL: Record<SecretName, string> = { password: tk('DB 비밀번호'), sshPassword: tk('SSH 비밀번호'), sshPassphrase: tk('SSH 개인 키 암호') }

/** 저장하지 않은 비밀번호를 연결할 때 묻는다 (이번 연결에만 쓰고 저장하지 않음) */
export function PasswordDialog({ name, need, onClose, onSubmit }: { name: string; need: SecretName[]; onClose: () => void; onSubmit: (v: SecretsInput) => void }) {
  const [v, setV] = useState<SecretsInput>({})
  return (
    <Dialog title={t('{name}에 연결', { name })} icon={KeyRound} width={420} submitLabel={t('연결')} onClose={onClose} onSubmit={() => onSubmit(Object.fromEntries(need.map((k) => [k, v[k] ?? ''])))}>
      <p className="muted small" style={{ margin: '0 0 12px' }}>{t('비밀번호는 이번 연결에만 쓰고 저장하지 않아요.')}</p>
      {need.map((k) => (
        <Field key={k} label={t(LABEL[k])}>
          <input type="password" autoComplete="off" value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
        </Field>
      ))}
    </Dialog>
  )
}
