// 가져오기 (CSV·엑셀·JSON): 파일 고르기 → 읽는 방법(CSV는 구분자·인코딩, 엑셀은 시트, 머리글) → 파일 열마다 넣을 표의 열 → 한 트랜잭션으로 넣기
import { useEffect, useState } from 'react'
import { FileUp, FolderOpen, LoaderCircle } from 'lucide-react'
import type { CsvDelimiter, CsvEncoding, CsvPreview, CsvReadOptions, TableRef } from '../../../shared/types'
import { Check, Dialog, Field } from '../components/Dialog'
import { api, errorText, useColumns } from '../api'
import { useUi } from '../ui'
import { t } from '../i18n'
import { fmtNum } from '../format'
import { displayName } from '../../../shared/dialect'

export function ImportDialog({ connId, target, onClose, onDone }: { connId: string; target: TableRef; onClose: () => void; onDone: () => void }) {
  const ui = useUi()
  const cols = useColumns(connId, target, true)
  const [file, setFile] = useState<string | null>(null)
  const [o, setO] = useState<CsvReadOptions>({ delimiter: 'auto', header: true, encoding: 'auto', sheet: 0 })
  const [pv, setPv] = useState<CsvPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [mapping, setMapping] = useState<(string | null)[]>([])
  const [emptyAsNull, setEmptyAsNull] = useState(true)

  const pick = async () => {
    const f = await api.pickCsv()
    if (f) setFile(f)
  }

  useEffect(() => {
    void pick()
    // 열자마자 파일 고르기
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!file) return
    let stop = false
    setBusy(true)
    api.previewCsv(file, o).then((p) => {
      if (stop) return
      setPv(p)
      // 이름이 같은 열끼리 자동으로 (대소문자·공백 무시)
      const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, '')
      const names = cols.data?.map((c) => c.name) ?? []
      setMapping(p.headers.map((h) => names.find((n) => norm(n) === norm(h)) ?? null))
    }).catch((e) => ui.notify(errorText(e), 'error')).finally(() => !stop && setBusy(false))
    return () => {
      stop = true
    }
  }, [file, o, cols.data, ui])

  const used = mapping.filter(Boolean).length
  const submit = async () => {
    if (!file || !pv) return
    try {
      const n = await api.importCsv(connId, target, file, { ...o, delimiter: pv.format === 'csv' ? pv.delimiter : ',', encoding: pv.encoding, mapping, emptyAsNull })
      ui.notify(t('{n}행을 넣었어요', { n: fmtNum(n) }), 'success')
      onDone()
      onClose()
    } catch (e) {
      ui.notify(errorText(e), 'error')
    }
  }

  return (
    <Dialog title={t('{name}에 가져오기 (CSV·엑셀·JSON)', { name: displayName(target) })} icon={FileUp} width={780} submitLabel={pv ? t('{n}행 넣기', { n: fmtNum(pv.total) }) : t('넣기')} disabled={!pv || used === 0 || busy} onClose={onClose} onSubmit={submit}>
      <div className="row-input">
        <input readOnly value={file ?? ''} placeholder={t('CSV·엑셀(xlsx)·JSON 파일을 고르세요')} className="mono" />
        <button type="button" className="btn" onClick={() => void pick()}><FolderOpen />{t('파일 고르기')}</button>
      </div>
      <div className="three">
        {pv?.format === 'xlsx' && (
          <Field label={t('시트')}>
            <select value={o.sheet ?? 0} onChange={(e) => setO({ ...o, sheet: Number(e.target.value) })}>
              {(pv.sheets ?? []).map((s, i) => <option key={i} value={i}>{s}</option>)}
            </select>
          </Field>
        )}
        {pv?.format !== 'xlsx' && pv?.format !== 'json' && (
        <Field label={t('구분자')}>
          <select value={o.delimiter} onChange={(e) => setO({ ...o, delimiter: e.target.value as CsvDelimiter | 'auto' })}>
            <option value="auto">{t('자동{found}', { found: pv && o.delimiter === 'auto' ? ` (${pv.delimiter === '\t' ? t('탭') : pv.delimiter})` : '' })}</option>
            <option value=",">,</option>
            <option value={'\t'}>{t('탭')}</option>
            <option value=";">;</option>
            <option value="|">|</option>
          </select>
        </Field>
        )}
        {pv?.format !== 'xlsx' && pv?.format !== 'json' && (
        <Field label={t('인코딩')}>
          <select value={o.encoding} onChange={(e) => setO({ ...o, encoding: e.target.value as CsvEncoding | 'auto' })}>
            <option value="auto">{t('자동{found}', { found: pv && o.encoding === 'auto' ? ` (${pv.encoding === 'utf8' ? 'UTF-8' : 'EUC-KR'})` : '' })}</option>
            <option value="utf8">UTF-8</option>
            <option value="euc-kr">{t('EUC-KR (한글 엑셀)')}</option>
          </select>
        </Field>
        )}
        <div className="checks">
          <Check checked={o.header} onChange={(v) => setO({ ...o, header: v })}>{t('첫 줄은 열 이름')}</Check>
          <Check checked={emptyAsNull} onChange={setEmptyAsNull}>{t('빈칸은 NULL로')}</Check>
        </div>
      </div>
      {busy && <div className="center-fill small"><LoaderCircle className="spin" /></div>}
      {pv && !busy && (
        <div className="import-map">
          <table>
            <thead>
              <tr>
                <th>{t('파일 열')}</th>
                <th>{t('넣을 열')}</th>
                <th>{t('처음 값들')}</th>
              </tr>
            </thead>
            <tbody>
              {pv.headers.map((h, i) => (
                <tr key={i} className={mapping[i] ? '' : 'skip'}>
                  <td className="mono">{h || t('열 {n}', { n: i + 1 })}</td>
                  <td>
                    <select value={mapping[i] ?? ''} onChange={(e) => setMapping(mapping.map((m, k) => (k === i ? e.target.value || null : m)))}>
                      <option value="">{t('(넣지 않음)')}</option>
                      {(cols.data ?? []).map((c) => <option key={c.name} value={c.name}>{c.name} · {c.type}</option>)}
                    </select>
                  </td>
                  <td className="mono muted ellipsis">{pv.rows.slice(0, 3).map((r) => r[i] ?? '').join(' | ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">{t('모두 {n}행 · 하나라도 실패하면 전부 되돌려요.', { n: fmtNum(pv.total) })}</p>
        </div>
      )}
    </Dialog>
  )
}
