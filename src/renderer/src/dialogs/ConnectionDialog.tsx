// 접속 정보 만들기·고치기: 종류 고르기 → 일반(호스트·사용자·비밀번호·SSL) / SSH 터널 → 연결 시험 → 저장
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleAlert, FilePlus2, FolderOpen, HardDriveDownload, LoaderCircle, Plug, ShieldCheck } from 'lucide-react'
import { DEFAULT_PORTS, DRIVER_KINDS, isFileDriver, newConnection, type ConnectionConfig, type ConnectionInfo, type DriverKind, type SecretsInput, type SslMode } from '../../../shared/types'
import { EngineDialog, ensureDuckdbEngine } from './EngineDialog'
import { Check, Dialog, Field, Tabs } from '../components/Dialog'
import { DriverBadge } from '../components/DriverBadge'
import { api, errorText } from '../api'
import { DRIVER_LABEL } from '../format'
import { useUi } from '../ui'
import { t } from '../i18n'

const COLORS = ['', '#3d6fd8', '#1f9d55', '#e48e00', '#d9443f', '#8a5cf6', '#0e9fd8', '#64748b']

export function ConnectionDialog({ initial, driver, onClose, onSaved }: { initial?: ConnectionInfo; driver?: DriverKind; onClose: () => void; onSaved: (c: ConnectionInfo) => void }) {
  const ui = useUi()
  const [c, setC] = useState<ConnectionConfig>(() => {
    if (!initial) return newConnection(driver ?? 'postgres')
    const { saved: _saved, ...config } = initial
    void _saved
    return config
  })
  const [secrets, setSecrets] = useState<SecretsInput>({})
  const [tab, setTab] = useState<'general' | 'ssh'>('general')
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; text: string }>({ state: 'idle', text: '' })
  const saved = initial?.saved ?? { password: false, sshPassword: false, sshPassphrase: false }
  const set = (patch: Partial<ConnectionConfig>) => setC((x) => ({ ...x, ...patch }))
  const setSsh = (patch: Partial<ConnectionConfig['ssh']>) => setC((x) => ({ ...x, ssh: { ...x.ssh, ...patch } }))
  const isFile = isFileDriver(c.driver)
  // DuckDB 엔진은 처음 쓸 때 받는다 → 접속 창에 있는지 보여 준다
  const engine = useQuery({ queryKey: ['engine-status'], queryFn: () => api.engineStatus(), enabled: c.driver === 'duckdb' })

  const pickDriver = (d: DriverKind) => {
    if (d === c.driver) return
    const fresh = newConnection(d)
    // 바꾸기 전 기본 포트·사용자였으면 새 종류의 기본값으로
    setC((x) => ({
      ...x,
      driver: d,
      port: x.port === DEFAULT_PORTS[x.driver] || !x.port ? fresh.port : x.port,
      user: x.user === newConnection(x.driver).user ? fresh.user : x.user,
      host: isFileDriver(d) ? x.host : x.host || 'localhost',
      ssl: x.ssl === newConnection(x.driver).ssl ? fresh.ssl : x.ssl,
    }))
    if (isFileDriver(d)) setTab('general')
  }

  const autoName = () => {
    if (c.name.trim()) return c.name.trim()
    if (isFile) return c.file.split(/[\\/]/).pop() || DRIVER_LABEL[c.driver]
    return `${c.host || 'localhost'}${c.database ? '/' + c.database : ''}`
  }

  const runTest = async () => {
    if (c.driver === 'duckdb' && !(await ensureDuckdbEngine(ui))) return
    void engine.refetch()
    setTest({ state: 'busy', text: '' })
    try {
      const r = await api.testConnection({ ...c, name: autoName() }, secrets)
      setTest({ state: 'ok', text: t('{version} · {ms}ms', { version: r.version, ms: r.ms }) })
    } catch (e) {
      setTest({ state: 'fail', text: errorText(e) })
    }
  }

  const save = async () => {
    try {
      const info = await api.saveConnection({ ...c, name: autoName() }, secrets)
      ui.notify(t('접속 정보를 저장했어요: {name}', { name: info.name }), 'success')
      onSaved(info)
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  const pickFile = async (mode: 'open' | 'create') => {
    try {
      const f = await api.pickDbFile(c.driver === 'duckdb' ? 'duckdb' : 'sqlite', mode)
      if (f) set({ file: f })
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  const pickKey = async () => {
    const f = await api.pickKeyFile()
    if (f) setSsh({ keyFile: f })
  }

  const forgetKey = async () => {
    await api.forgetHostKey(c.ssh.host, c.ssh.port)
    ui.notify(t('기억한 SSH 호스트 키를 지웠어요. 다음에 연결할 때 새로 기억해요.'), 'info')
  }

  const pwPlaceholder = (has: boolean) => (has ? t('저장된 비밀번호 그대로') : '')

  return (
    <Dialog
      title={initial ? t('접속 정보 고치기') : t('새 연결')}
      icon={Plug}
      width={640}
      submitLabel={t('저장')}
      onClose={onClose}
      onSubmit={save}
      className="conn-dialog"
      footer={
        <div className="test-area">
          <button type="button" className="btn" onClick={runTest} disabled={test.state === 'busy'}>
            {test.state === 'busy' ? <LoaderCircle className="spin" /> : <Plug />}{t('연결 시험')}
          </button>
          {test.state === 'ok' && <span className="test-ok"><CircleCheck />{test.text}</span>}
          {test.state === 'fail' && <span className="test-fail" title={test.text}><CircleAlert /><span className="ellipsis">{test.text}</span></span>}
        </div>
      }
    >
      <div className="driver-cards" role="radiogroup" aria-label={t('DB 종류')}>
        {DRIVER_KINDS.map((d) => (
          <button key={d} type="button" role="radio" aria-checked={c.driver === d} className={`driver-card ${c.driver === d ? 'on' : ''}`} onClick={() => pickDriver(d)}>
            <DriverBadge driver={d} size={30} />
            <span>{DRIVER_LABEL[d]}</span>
          </button>
        ))}
      </div>
      <p className="muted small compat">{c.driver === 'clickhouse'
        ? t('ClickHouse는 HTTP 포트(기본 8123, HTTPS는 8443)로 연결해요.')
        : c.driver === 'oracle'
          ? t('Oracle 12.1 이상에 바로 연결해요 (Instant Client 필요 없음).')
          : t('TiDB 등 MySQL 호환 DB는 MySQL로, CockroachDB·TimescaleDB 등 PostgreSQL 호환 DB는 PostgreSQL로, Azure SQL은 SQL Server로 연결하세요.')}</p>

      {!isFile && <Tabs value={tab} onChange={setTab} tabs={[{ value: 'general', label: t('일반') }, { value: 'ssh', label: c.ssh.enabled ? t('SSH 터널 (사용)') : t('SSH 터널') }]} />}

      {tab === 'general' && (
        <div className="form-grid">
          <Field label={t('이름')}>
            <input value={c.name} placeholder={autoName()} onChange={(e) => set({ name: e.target.value })} data-autofocus />
          </Field>
          <Field label={t('색')}>
            <div className="swatches">
              {COLORS.map((col) => (
                <button key={col || 'none'} type="button" className={`swatch ${c.color === col ? 'on' : ''}`} style={{ background: col || 'transparent' }} title={col ? col : t('색 없음')} onClick={() => set({ color: col })} />
              ))}
            </div>
          </Field>
          {isFile ? (
            <>
              <Field label={t('{db} 파일', { db: DRIVER_LABEL[c.driver] })} hint={c.driver === 'duckdb' ? t('없는 파일은 처음 연결할 때 만들어져요.') : t('파일이 없으면 "새 파일"로 만드세요.')}>
                <div className="row-input">
                  <input value={c.file} onChange={(e) => set({ file: e.target.value })} placeholder={c.driver === 'duckdb' ? 'C:\\data\\app.duckdb' : 'C:\\data\\app.db'} className="mono" />
                  <button type="button" className="btn" onClick={() => pickFile('open')}><FolderOpen />{t('찾아보기')}</button>
                  <button type="button" className="btn" onClick={() => pickFile('create')}><FilePlus2 />{t('새 파일')}</button>
                </div>
              </Field>
              {c.driver === 'duckdb' && engine.data && (
                <div className="engine-note small">
                  {engine.data.installed
                    ? <span className="with-icon muted"><CircleCheck className="ok-icon" />{t('DuckDB 엔진 {version} 준비됨', { version: engine.data.version })}</span>
                    : <>
                        <span className="muted">{t('DuckDB 엔진(약 {size}MB)을 처음 한 번 받아야 해요.', { size: (engine.data.size / 1_000_000).toFixed(0) })}</span>
                        <button type="button" className="btn" onClick={() => ui.open((close) => <EngineDialog onDone={() => { close(); void engine.refetch() }} />)}><HardDriveDownload />{t('엔진 받기…')}</button>
                      </>}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="two fit">
                <Field label={t('호스트')}>
                  <input value={c.host} onChange={(e) => set({ host: e.target.value })} placeholder="localhost" />
                </Field>
                <Field label={t('포트')}>
                  <input type="number" value={c.port || ''} onChange={(e) => set({ port: Number(e.target.value) || 0 })} style={{ width: 110 }} />
                </Field>
              </div>
              <Field label={c.driver === 'oracle' ? t('서비스 이름') : t('DB')} hint={c.driver === 'postgres' ? t('비우면 postgres') : c.driver === 'mssql' ? t('비우면 master') : c.driver === 'oracle' ? t('예: ORCLPDB1, XEPDB1, FREEPDB1') : c.driver === 'clickhouse' ? t('비우면 default') : t('비워도 돼요 (탐색기에서 고름)')}>
                <input value={c.database} onChange={(e) => set({ database: e.target.value })} />
              </Field>
              <div className="two">
                <Field label={t('사용자')}>
                  <input value={c.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
                </Field>
                <Field label={t('비밀번호')}>
                  <input type="password" value={secrets.password ?? ''} placeholder={pwPlaceholder(saved.password)} onChange={(e) => setSecrets({ ...secrets, password: e.target.value })} autoComplete="new-password" />
                </Field>
              </div>
              <Check checked={c.savePassword} onChange={(v) => set({ savePassword: v })}>
                <span className="with-icon"><ShieldCheck className="small-icon" />{t('비밀번호 저장 (Windows 계정 암호화로 저장, 끄면 연결할 때마다 물어봄)')}</span>
              </Check>
              <Field label={c.driver === 'mssql' ? t('암호화') : c.driver === 'clickhouse' ? t('HTTPS') : t('SSL')}>
                <select value={c.ssl} onChange={(e) => set({ ssl: e.target.value as SslMode })}>
                  <option value="off">{t('끔')}</option>
                  <option value="require">{t('켬 (인증서 확인 안 함)')}</option>
                  <option value="verify">{t('켬 + 인증서 확인')}</option>
                </select>
              </Field>
            </>
          )}
          <Check checked={c.showSystem} onChange={(v) => set({ showSystem: v })}>{t('시스템 DB·스키마도 보기')}</Check>
          <div className="checks safety">
            <Check checked={c.production === true} onChange={(v) => set({ production: v })}>
              <b>{t('운영 DB')}</b> <span className="muted">— {t('편집기가 수동 커밋으로 시작하고, 데이터를 바꾸는 문장은 실행 전에 한 번 더 물어요. 탭에 빨간 줄')}</span>
            </Check>
            <Check checked={c.readOnly === true} onChange={(v) => set({ readOnly: v })}>
              <b>{t('읽기 전용')}</b> <span className="muted">— {t('데이터·구조를 바꾸는 문장, 표 고치기, 가져오기를 막아요')}</span>
            </Check>
          </div>
        </div>
      )}

      {tab === 'ssh' && !isFile && (
        <div className="form-grid">
          <Check checked={c.ssh.enabled} onChange={(v) => setSsh({ enabled: v })}>{t('SSH 터널로 연결 (DB 서버 앞의 SSH 서버를 거쳐 감)')}</Check>
          <fieldset disabled={!c.ssh.enabled} className="plain">
            <div className="two fit">
              <Field label={t('SSH 호스트')}>
                <input value={c.ssh.host} onChange={(e) => setSsh({ host: e.target.value })} />
              </Field>
              <Field label={t('포트')}>
                <input type="number" value={c.ssh.port || ''} onChange={(e) => setSsh({ port: Number(e.target.value) || 22 })} style={{ width: 110 }} />
              </Field>
            </div>
            <Field label={t('SSH 사용자')}>
              <input value={c.ssh.user} onChange={(e) => setSsh({ user: e.target.value })} autoComplete="off" />
            </Field>
            <Field label={t('인증 방식')}>
              <select value={c.ssh.auth} onChange={(e) => setSsh({ auth: e.target.value as 'password' | 'key' })}>
                <option value="password">{t('비밀번호')}</option>
                <option value="key">{t('개인 키 파일')}</option>
              </select>
            </Field>
            {c.ssh.auth === 'password' ? (
              <Field label={t('SSH 비밀번호')}>
                <input type="password" value={secrets.sshPassword ?? ''} placeholder={pwPlaceholder(saved.sshPassword)} onChange={(e) => setSecrets({ ...secrets, sshPassword: e.target.value })} autoComplete="new-password" />
              </Field>
            ) : (
              <>
                <Field label={t('개인 키 파일')}>
                  <div className="row-input">
                    <input value={c.ssh.keyFile} onChange={(e) => setSsh({ keyFile: e.target.value })} className="mono" />
                    <button type="button" className="btn" onClick={pickKey}><FolderOpen />{t('찾아보기')}</button>
                  </div>
                </Field>
                <Field label={t('키 암호 (걸려 있으면)')}>
                  <input type="password" value={secrets.sshPassphrase ?? ''} placeholder={pwPlaceholder(saved.sshPassphrase)} onChange={(e) => setSecrets({ ...secrets, sshPassphrase: e.target.value })} autoComplete="new-password" />
                </Field>
              </>
            )}
            <p className="muted small">{t('DB 호스트·포트는 SSH 서버에서 본 주소로 적으세요 (보통 localhost). 처음 연결할 때 서버의 호스트 키를 기억하고, 바뀌면 연결하지 않아요.')}</p>
            {c.ssh.host && <button type="button" className="link" onClick={forgetKey}>{t('기억한 호스트 키 지우기')}</button>}
          </fieldset>
        </div>
      )}
    </Dialog>
  )
}
