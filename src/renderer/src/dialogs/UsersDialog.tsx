// 사용자·권한: 목록(왼쪽), 고른 사용자의 속성·권한(오른쪽), 새 사용자·비밀번호 바꾸기·권한 주기/빼기·지우기. 실행할 SQL을 먼저 보여 준다(비밀번호는 ********). 대화 상자라 useWs 금지
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { KeyRound, LoaderCircle, Plus, ShieldCheck, ShieldMinus, ShieldPlus, Trash2, UserRound, Users } from 'lucide-react'
import { PRIVILEGES, userSql } from '../../../shared/users'
import { dialectOf, type ConnectionInfo, type DbUser, type UserAction } from '../../../shared/types'
import { api, errorText } from '../api'
import { useUi } from '../ui'
import { t } from '../i18n'
import { Check, Dialog, Field } from '../components/Dialog'
import { DdlDialog } from './DdlDialog'

type Form = { kind: 'create' | 'password' | 'grant' | 'revoke' }

export function UsersDialog({ conn, db, schema, onClose }: { conn: ConnectionInfo; db: string; schema: string; onClose: () => void }) {
  const ui = useUi()
  const d = dialectOf(conn.driver)
  const list = useQuery({ queryKey: ['users', conn.id], queryFn: () => api.users(conn.id) })
  const [sel, setSel] = useState<DbUser | null>(null)
  const grants = useQuery({ queryKey: ['user-grants', conn.id, sel?.name, sel?.host, db], queryFn: () => api.userGrants(conn.id, sel!.name, sel!.host, db), enabled: !!sel })
  const [form, setForm] = useState<Form | null>(null)
  const [name, setName] = useState('')
  const [host, setHost] = useState('%')
  const [password, setPassword] = useState('')
  const [login, setLogin] = useState(true)
  const [privs, setPrivs] = useState<string[]>(['SELECT'])
  const [table, setTable] = useState('')
  const readOnly = conn.readOnly === true

  const run = (a: UserAction, title: string, danger = false) => {
    let shown: string[]
    try {
      shown = userSql(d, a, true)
    } catch (e) {
      ui.notify(errorText(e), 'error')
      return
    }
    ui.open((close) => (
      <DdlDialog title={title} driver={conn.driver} statements={shown} production={conn.production === true} danger={danger} onClose={close}
        warnings={'password' in a && a.password ? [t('비밀번호는 여기와 실행 기록에 ********로 보여요.')] : []}
        onSubmit={async () => {
          try {
            await api.runUserAction(conn.id, db, schema, a)
          } catch (e) {
            ui.notify(errorText(e), 'error')
            return
          }
          close()
          setForm(null)
          setPassword('')
          ui.notify(t('바꿨어요'), 'success')
          if (a.kind === 'drop') setSel(null)
          void list.refetch()
          void grants.refetch()
        }} />
    ))
  }

  const submitForm = () => {
    if (!form) return
    const who = form.kind === 'create' ? name.trim() : sel?.name ?? ''
    const h = form.kind === 'create' ? host.trim() : sel?.host ?? ''
    if (form.kind === 'create') run({ kind: 'create', name: who, host: h, password, login }, t('새 사용자'))
    else if (form.kind === 'password') run({ kind: 'password', name: who, host: h, password }, t('비밀번호 바꾸기'))
    else run({ kind: form.kind, name: who, host: h, privileges: privs, db, schema, table: table.trim() }, form.kind === 'grant' ? t('권한 주기') : t('권한 빼기'))
  }

  const target = d === 'mysql' ? db : schema || db
  return (
    <Dialog title={t('사용자·권한 — {name}', { name: conn.name })} icon={Users} width={980} onClose={onClose}>
      <div className="users-body">
        <div className="users-list">
          <div className="transfer-tools">
            <b>{t('사용자')}</b>
            <span className="spacer" />
            <button type="button" className="link-btn" disabled={readOnly} onClick={() => { setForm({ kind: 'create' }); setName(''); setPassword('') }}><Plus />{t('새 사용자')}</button>
          </div>
          <div className="transfer-list">
            {list.isPending && <LoaderCircle className="spin" />}
            {list.error && <div className="banner error inline">{errorText(list.error)}</div>}
            {list.data?.map((u) => (
              <div key={u.name + '@' + u.host} className={`compare-row ${sel?.name === u.name && sel.host === u.host ? 'sel' : ''}`} onClick={() => { setSel(u); setForm(null) }}>
                {u.superuser ? <ShieldCheck className="st-icon warn" /> : <UserRound className="st-icon" />}
                <span className="ellipsis name">{u.name}{u.host && <span className="muted">@{u.host}</span>}</span>
                {!u.login && <span className="muted small">{t('로그인 안 됨')}</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="compare-detail">
          {form?.kind === 'create' ? (
            <div className="users-form">
              <h3>{t('새 사용자')}</h3>
              <Field label={t('이름')}><input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} data-autofocus /></Field>
              {d === 'mysql' && <Field label={t('접속할 수 있는 곳 (% = 어디서나)')}><input value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} /></Field>}
              <Field label={t('비밀번호')}><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
              {d === 'postgres' && <Check checked={login} onChange={setLogin}>{t('로그인할 수 있음 (끄면 권한 묶음용 역할)')}</Check>}
              <div className="row-btns"><button type="button" className="btn" onClick={() => setForm(null)}>{t('취소')}</button><button type="button" className="btn primary" onClick={submitForm}>{t('다음')}</button></div>
            </div>
          ) : !sel ? <p className="pad muted">{t('왼쪽에서 사용자를 골라 주세요')}</p> : (
            <>
              <h3>{sel.name}{sel.host && <span className="muted">@{sel.host}</span>}</h3>
              {sel.attrs.length > 0 && <div className="user-attrs">{sel.attrs.map((a) => <span key={a} className="tag">{a}</span>)}</div>}
              <div className="row-btns left">
                <button type="button" className="btn" disabled={readOnly} onClick={() => { setForm({ kind: 'password' }); setPassword('') }}><KeyRound />{t('비밀번호 바꾸기')}</button>
                <button type="button" className="btn" disabled={readOnly} onClick={() => setForm({ kind: 'grant' })}><ShieldPlus />{t('권한 주기')}</button>
                <button type="button" className="btn" disabled={readOnly} onClick={() => setForm({ kind: 'revoke' })}><ShieldMinus />{t('권한 빼기')}</button>
                <button type="button" className="btn danger" disabled={readOnly} onClick={() => run({ kind: 'drop', name: sel.name, host: sel.host }, t('사용자 지우기'), true)}><Trash2 />{t('지우기')}</button>
              </div>
              {form?.kind === 'password' && (
                <div className="users-form">
                  <Field label={t('새 비밀번호')}><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" data-autofocus /></Field>
                  <div className="row-btns"><button type="button" className="btn" onClick={() => setForm(null)}>{t('취소')}</button><button type="button" className="btn primary" onClick={submitForm}>{t('다음')}</button></div>
                </div>
              )}
              {(form?.kind === 'grant' || form?.kind === 'revoke') && (
                <div className="users-form">
                  <div className="priv-checks">{PRIVILEGES.map((p) => <Check key={p} checked={privs.includes(p)} onChange={(v) => setPrivs((cur) => (v ? [...cur, p] : cur.filter((x) => x !== p)))}>{p}</Check>)}</div>
                  <Field label={t('표 (비우면 {where}의 모든 표)', { where: target })}><input value={table} onChange={(e) => setTable(e.target.value)} spellCheck={false} placeholder={t('모든 표')} /></Field>
                  <div className="row-btns"><button type="button" className="btn" onClick={() => setForm(null)}>{t('취소')}</button><button type="button" className="btn primary" onClick={submitForm}>{t('다음')}</button></div>
                </div>
              )}
              <h4 className="muted small">{t('권한 ({where})', { where: d === 'mysql' ? t('서버 전체') : target })}</h4>
              {grants.isFetching && <LoaderCircle className="spin" />}
              {grants.error && <div className="banner error inline">{errorText(grants.error)}</div>}
              {grants.data && (grants.data.length === 0 ? <p className="muted small">{t('따로 받은 권한이 없어요')}</p> : <ul className="compare-changes mono">{grants.data.map((g, i) => <li key={i}>{g}</li>)}</ul>)}
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}
