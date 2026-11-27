import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Info, LoaderCircle, RefreshCw, Settings, ShieldCheck, ShieldAlert } from 'lucide-react'
import type { AppSettings } from '../../../shared/types'
import { Check, Dialog, Field, Tabs } from '../components/Dialog'
import { api, errorText, useUpdateStatus } from '../api'
import { useUi } from '../ui'
import { t } from '../i18n'

// 언어 이름은 그 언어로 쓴다
const KOREAN = '한국어' // i18n-ignore

export function SettingsDialog({ initial, initialTab, onClose }: { initial: AppSettings; initialTab?: 'general' | 'editor' | 'about'; onClose: () => void }) {
  const ui = useUi()
  const qc = useQueryClient()
  const [s, setS] = useState(initial)
  const [tab, setTab] = useState<'general' | 'editor' | 'about'>(initialTab ?? 'general')
  const info = useQuery({ queryKey: ['app-info'], queryFn: () => api.appInfo() })
  const upd = useUpdateStatus()
  const [checking, setChecking] = useState(false)
  const set = (patch: Partial<AppSettings>) => setS((x) => ({ ...x, ...patch }))

  const save = async () => {
    try {
      const next = await api.saveSettings(s)
      qc.setQueryData(['settings'], next)
      onClose()
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  const check = async () => {
    setChecking(true)
    try {
      qc.setQueryData(['update'], await api.checkForUpdates())
    } finally {
      setChecking(false)
    }
  }

  const u = upd.data
  return (
    <Dialog title={t('설정')} icon={Settings} width={560} submitLabel={t('저장')} onClose={onClose} onSubmit={save}>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'general', label: t('일반') }, { value: 'editor', label: t('편집기·결과') }, { value: 'about', label: t('정보') }]} />
      {tab === 'general' && (
        <div className="form-grid">
          <Field label={t('언어')}>
            <select value={s.language} onChange={(e) => set({ language: e.target.value as AppSettings['language'] })}>
              <option value="auto">{t('Windows 언어 따라가기')}</option>
              <option value="ko">{KOREAN}</option>
              <option value="en">English</option>
            </select>
          </Field>
          <Field label={t('화면 테마')}>
            <select value={s.theme} onChange={(e) => set({ theme: e.target.value as AppSettings['theme'] })}>
              <option value="system">{t('Windows 설정 따라가기')}</option>
              <option value="light">{t('밝게')}</option>
              <option value="dark">{t('어둡게')}</option>
            </select>
          </Field>
          <Field label={t('화면 배율')} hint={t('Ctrl + +·−로도 바꿀 수 있어요. Ctrl+0은 자동.')}>
            <select value={String(s.zoom)} onChange={(e) => set({ zoom: Number(e.target.value) })}>
              <option value="0">{t('자동 (창 크기에 맞춤)')}</option>
              {[0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
            </select>
          </Field>
          <Check checked={s.autoUpdate} onChange={(v) => set({ autoUpdate: v })}>{t('새 버전을 자동으로 받기 (앱을 끌 때 설치)')}</Check>
        </div>
      )}
      {tab === 'editor' && (
        <div className="form-grid">
          <div className="two">
            <Field label={t('편집기 글자 크기')}>
              <input type="number" min={10} max={24} value={s.editorFontSize} onChange={(e) => set({ editorFontSize: Number(e.target.value) })} style={{ width: 100 }} />
            </Field>
            <Field label={t('결과 최대 행 수')} hint={t('넘으면 끊고 "모두 가져오기"로 더 받아요')}>
              <input type="number" min={10} max={100000} step={100} value={s.maxRows} onChange={(e) => set({ maxRows: Number(e.target.value) })} style={{ width: 120 }} />
            </Field>
          </div>
          <Field label={t('표 데이터 한 번에 가져올 행 수')}>
            <input type="number" min={10} max={10000} step={50} value={s.pageSize} onChange={(e) => set({ pageSize: Number(e.target.value) })} style={{ width: 120 }} />
          </Field>
          <Check checked={s.confirmDangerous} onChange={(v) => set({ confirmDangerous: v })}>{t('WHERE 없는 UPDATE·DELETE는 실행 전에 묻기')}</Check>
          <Check checked={s.queryParams} onChange={(v) => set({ queryParams: v })}>{t('쿼리 변수(:이름)가 있으면 실행 전에 값 묻기')}</Check>
        </div>
      )}
      {tab === 'about' && (
        <div className="about">
          <div className="about-head">
            <img src="./icon.png" alt="" width={48} height={48} />
            <div>
              <b>DBoard</b> <span className="muted">{info.data?.version}</span>
              <p className="muted small">{t('Windows용 DB 관리 도구 · MIT 라이선스')}</p>
            </div>
          </div>
          <p className="with-icon">
            {info.data?.secureStorage ? <ShieldCheck className="ok-icon" /> : <ShieldAlert className="warn-icon" />}
            {info.data?.secureStorage ? t('비밀번호는 Windows 계정 암호화(DPAPI)로 저장돼요. 다른 사용자·PC에서는 풀 수 없어요.') : t('이 PC에서는 비밀번호를 암호화해 저장할 수 없어서, 연결할 때마다 물어봐요.')}
          </p>
          <div className="update-box">
            <Info className="small-icon" />
            <span>
              {u?.state === 'latest' && t('최신 버전이에요')}
              {u?.state === 'downloading' && t('새 버전 {v} 받는 중 {n}%', { v: u.newVersion ?? '', n: u.progress ?? 0 })}
              {u?.state === 'ready' && t('새 버전 {v}을 받아 뒀어요. 앱을 끄면 설치돼요.', { v: u.newVersion ?? '' })}
              {(u?.state === 'error' || u?.state === 'disabled') && u.message}
              {(u?.state === 'idle' || u?.state === 'checking') && t('업데이트 확인 전')}
            </span>
            <span className="spacer" />
            <button type="button" className="btn small" onClick={() => void check()} disabled={checking || u?.state === 'disabled'}>
              {checking ? <LoaderCircle className="spin" /> : <RefreshCw />}{t('지금 확인')}
            </button>
          </div>
          <button type="button" className="link" onClick={() => void api.openUrl('https://github.com/winjun0221/dboard')}><ExternalLink />github.com/winjun0221/dboard</button>
        </div>
      )}
    </Dialog>
  )
}
