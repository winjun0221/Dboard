import { useState } from 'react'
import { Download } from 'lucide-react'
import type { CsvDelimiter, CsvWriteOptions } from '../../../shared/types'
import { Check, Choice, Dialog, Field } from '../components/Dialog'
import { t } from '../i18n'
import { fmtNum } from '../format'

const KEY = 'dboard.csv.write'

function load(): CsvWriteOptions {
  try {
    return { delimiter: ',', header: true, bom: true, nullText: '', ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<CsvWriteOptions>) }
  } catch {
    return { delimiter: ',', header: true, bom: true, nullText: '' }
  }
}

/** CSV 내보내기 설정. rerun이 있으면(잘린 결과) '가져온 행만 / 다시 실행해서 전부' 고르기 */
export function ExportDialog({ title, rows, rerun, onClose, onSubmit }: {
  title: string
  rows: number | null
  rerun?: { allowed: boolean }
  onClose: () => void
  onSubmit: (o: CsvWriteOptions, all: boolean) => Promise<void> | void
}) {
  const [o, setO] = useState<CsvWriteOptions>(load)
  const [all, setAll] = useState<'fetched' | 'all'>(rerun?.allowed ? 'all' : 'fetched')
  return (
    <Dialog title={title} icon={Download} width={480} submitLabel={t('저장할 곳 고르기…')} onClose={onClose} onSubmit={async () => {
      try {
        localStorage.setItem(KEY, JSON.stringify(o))
      } catch {
        // 무시
      }
      await onSubmit(o, all === 'all')
    }}>
      {rerun && (
        <Choice
          value={all}
          onChange={setAll}
          options={([
            { value: 'all', label: t('쿼리를 다시 실행해서 전부'), desc: rerun.allowed ? t('결과가 많아도 파일에 조금씩 써요') : t('SELECT처럼 읽기만 하는 문장만 다시 실행할 수 있어요') },
            { value: 'fetched', label: t('가져온 {n}행만', { n: fmtNum(rows ?? 0) }), desc: t('지금 화면에 있는 행') },
          ] as { value: 'all' | 'fetched'; label: string; desc: string }[]).filter((x) => x.value !== 'all' || rerun.allowed)}
        />
      )}
      <div className="two">
        <Field label={t('구분자')}>
          <select value={o.delimiter} onChange={(e) => setO({ ...o, delimiter: e.target.value as CsvDelimiter })}>
            <option value=",">{t('쉼표 (,)')}</option>
            <option value={'\t'}>{t('탭')}</option>
            <option value=";">{t('세미콜론 (;)')}</option>
            <option value="|">{t('세로 막대 (|)')}</option>
          </select>
        </Field>
        <Field label={t('NULL은')}>
          <input value={o.nullText} onChange={(e) => setO({ ...o, nullText: e.target.value })} placeholder={t('빈칸')} style={{ width: 120 }} />
        </Field>
      </div>
      <Check checked={o.header} onChange={(v) => setO({ ...o, header: v })}>{t('첫 줄에 열 이름')}</Check>
      <Check checked={o.bom} onChange={(v) => setO({ ...o, bom: v })}>{t('엑셀에서 한글이 안 깨지게 (UTF-8 BOM)')}</Check>
    </Dialog>
  )
}
