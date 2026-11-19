// 표·뷰 탭: 데이터 / 열 / 인덱스 / DDL
import { useQuery } from '@tanstack/react-query'
import { ClipboardCopy, Columns3, Eye, FileCode2, KeyRound, ListTree, LoaderCircle, SquareTerminal, Table2 } from 'lucide-react'
import { api, errorText, useColumns, useIndexes } from '../api'
import { useWs, type TableSub, type TableTab } from '../ws'
import { t } from '../i18n'
import { Tabs } from '../components/Dialog'
import { SqlEditor } from '../components/SqlEditor'
import { DriverBadge } from '../components/DriverBadge'
import { DataView } from './DataView'

export function TableTabView({ tab, active }: { tab: TableTab; active: boolean }) {
  const ws = useWs()
  const conn = ws.conn(tab.connId)
  const isOn = ws.connected.has(tab.connId)
  const isView = tab.objKind === 'view'
  const cols = useColumns(tab.connId, tab.ref, isOn && active && tab.sub === 'columns')
  const idx = useIndexes(tab.connId, tab.ref, isOn && active && tab.sub === 'indexes' && !isView)
  const ddl = useQuery({
    queryKey: ['ddl', tab.connId, tab.ref.db, tab.ref.schema, tab.ref.table],
    queryFn: () => api.ddl(tab.connId, tab.ref, tab.objKind),
    enabled: isOn && active && tab.sub === 'ddl',
  })
  if (!conn) return null
  const path = [tab.ref.db, tab.ref.schema].filter(Boolean).join(' · ')
  const subs: { value: TableSub; label: string; icon: typeof Table2 }[] = [
    { value: 'data', label: t('데이터'), icon: Table2 },
    { value: 'columns', label: t('열|column'), icon: Columns3 },
    ...(!isView ? [{ value: 'indexes' as const, label: t('인덱스'), icon: ListTree }] : []),
    { value: 'ddl', label: 'DDL', icon: FileCode2 },
  ]
  const needConnect = !isOn && tab.sub !== 'data'

  return (
    <div className="table-tab">
      <div className="table-head">
        <span className={`obj-icon ${isView ? 'view' : ''}`}>{isView ? <Eye /> : <Table2 />}</span>
        <div className="obj-title">
          <b>{tab.ref.table}</b>
          <span className="muted small"><DriverBadge driver={conn.driver} size={13} /> {conn.name}{path && ' · ' + path}{isView && ' · ' + t('뷰')}</span>
        </div>
        <span className="spacer" />
        <Tabs value={tab.sub} onChange={(v) => ws.updateTab(tab.id, { sub: v })} tabs={subs} />
      </div>
      {needConnect && <div className="center-fill"><button className="btn" onClick={() => void ws.ensureConnected(tab.connId)}>{t('연결해서 보기')}</button></div>}
      <div className="table-body" style={{ display: tab.sub === 'data' ? 'flex' : 'none' }}>
        <DataView tabId={tab.id} connId={tab.connId} target={tab.ref} objKind={tab.objKind} active={active && tab.sub === 'data'} />
      </div>
      {!needConnect && tab.sub === 'columns' && (
        <div className="table-body scroll">
          {cols.isPending ? <Loading /> : cols.error ? <div className="banner error">{errorText(cols.error)}</div> : (
            <table className="info-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('이름')}</th>
                  <th>{t('타입')}</th>
                  <th>{t('NULL 허용')}</th>
                  <th>{t('기본값')}</th>
                  <th>{t('자동 증가')}</th>
                  <th>{t('설명')}</th>
                </tr>
              </thead>
              <tbody>
                {cols.data?.map((c, i) => (
                  <tr key={c.name}>
                    <td className="muted">{i + 1}</td>
                    <td><span className="with-icon">{c.pk && <KeyRound className="pk-icon" />}<b>{c.name}</b></span></td>
                    <td className="mono">{c.type}</td>
                    <td>{c.nullable ? t('예') : <span className="muted">{t('아니요')}</span>}</td>
                    <td className="mono muted">{c.default ?? ''}</td>
                    <td>{c.autoIncrement ? t('예') : ''}</td>
                    <td className="muted">{c.comment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {!needConnect && tab.sub === 'indexes' && (
        <div className="table-body scroll">
          {idx.isPending ? <Loading /> : idx.error ? <div className="banner error">{errorText(idx.error)}</div> : idx.data?.length === 0 ? <p className="pad muted">{t('인덱스가 없어요')}</p> : (
            <table className="info-table">
              <thead>
                <tr>
                  <th>{t('이름')}</th>
                  <th>{t('열|column')}</th>
                  <th>{t('종류')}</th>
                </tr>
              </thead>
              <tbody>
                {idx.data?.map((ix) => (
                  <tr key={ix.name}>
                    <td><span className="with-icon">{ix.primary && <KeyRound className="pk-icon" />}<b>{ix.name}</b></span></td>
                    <td className="mono">{ix.columns.join(', ')}</td>
                    <td>{ix.primary ? t('기본 키') : ix.unique ? t('고유') : t('일반')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {!needConnect && tab.sub === 'ddl' && (
        <div className="table-body ddl">
          <div className="ddl-bar">
            <button className="btn small" disabled={!ddl.data} onClick={() => ddl.data && void api.copyText(ddl.data)}><ClipboardCopy />{t('복사')}</button>
            <button className="btn small" disabled={!ddl.data} onClick={() => ddl.data && ws.openEditor(tab.connId, { db: tab.ref.db, schema: tab.ref.schema, text: ddl.data })}><SquareTerminal />{t('편집기에서 열기')}</button>
          </div>
          {ddl.isPending ? <Loading /> : ddl.error ? <div className="banner error">{errorText(ddl.error)}</div> : (
            <div className="ddl-code"><SqlEditor initial={ddl.data ?? ''} driver={conn.driver} fontSize={ws.settings.editorFontSize} readOnly /></div>
          )}
        </div>
      )}
    </div>
  )
}

function Loading() {
  return <div className="center-fill"><LoaderCircle className="spin big" /></div>
}
