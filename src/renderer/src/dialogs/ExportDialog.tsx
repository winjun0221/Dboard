import { useState } from 'react'
import { Download } from 'lucide-react'
import { EXPORT_FORMATS, type CsvDelimiter, type CsvWriteOptions, type Dialect, type ExportFormat } from '../../../shared/types'
import { Check, Choice, Dialog, Field, Tabs } from '../components/Dialog'
import { t, tk } from '../i18n'
import { fmtNum } from '../format'

const KEY = 'dboard.csv.write'
const FORMAT_LABEL: Record<ExportFormat, string> = { csv: 'CSV', xlsx: tk('엑셀'), json: 'JSON', md: 'Markdown', sql: tk('SQL (INSERT)') }

function load(dialect: Dialect, table: string): CsvWriteOptions {
  const def: CsvWriteOptions = { format: 'csv', table, dialect, delimiter: ',', header: true, bom: true, nullText: '' }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<CsvWriteOptions>
    // 표 이름·방언은 이번 대상 것으로
    return { ...def, ...saved, table, dialect, format: EXPORT_FORMATS.includes(saved.format as ExportFormat) ? (saved.format as ExportFormat) : 'csv' }
  } catch {
    return def
  }
}

/** 내보내기 설정: 형식(CSV·엑셀·JSON·Markdown·INSERT)과 형식별 옵션. rerun이 있으면(잘린 결과) '가져온 행만 / 다시 실행해서 전부' 고르기 */
export function ExportDialog({ title, rows, rerun, table = '', dialect = 'sqlite', onClose, onSubmit }: {
  title: string
  rows: number | null
  rerun?: { allowed: boolean }
  /** SQL(INSERT) 형식의 기본 표 이름 */
  table?: string
  dialect?: Dialect
  onClose: () => void
  onSubmit: (o: CsvWriteOptions, all: boolean) => Promise<void> | void
}) {
  const [o, setO] = useState<CsvWriteOptions>(() => load(dialect, table))
  const [all, setAll] = useState<'fetched' | 'all'>(rerun?.allowed ? 'all' : 'fetched')
  const set = (p: Partial<CsvWriteOptions>) => setO((x) => ({ ...x, ...p }))
  return (
    <Dialog title={title} icon={Download} width={500} submitLabel={t('저장할 곳 고르기…')} disabled={o.format === 'sql' && !o.table.trim()} onClose={onClose} onSubmit={async () => {
      try {
        localStorage.setItem(KEY, JSON.stringify({ ...o, table: undefined, dialect: undefined }))
      } catch {
        // 무시
      }
      await onSubmit(o, all === 'all')
    }}>
      <Field label={t('형식')}>
        <Tabs value={o.format} onChange={(v) => set({ format: v })} tabs={EXPORT_FORMATS.map((f) => ({ value: f, label: t(FORMAT_LABEL[f]) }))} />
      </Field>
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
      {o.format === 'csv' && (
        <div className="two">
          <Field label={t('구분자')}>
            <select value={o.delimiter} onChange={(e) => set({ delimiter: e.target.value as CsvDelimiter })}>
              <option value=",">{t('쉼표 (,)')}</option>
              <option value={'\t'}>{t('탭')}</option>
              <option value=";">{t('세미콜론 (;)')}</option>
              <option value="|">{t('세로 막대 (|)')}</option>
            </select>
          </Field>
          <Field label={t('NULL은')}>
            <input value={o.nullText} onChange={(e) => set({ nullText: e.target.value })} placeholder={t('빈칸')} style={{ width: 120 }} />
          </Field>
        </div>
      )}
      {o.format === 'md' && (
        <Field label={t('NULL은')}>
          <input value={o.nullText} onChange={(e) => set({ nullText: e.target.value })} placeholder={t('빈칸')} style={{ width: 120 }} />
        </Field>
      )}
      {o.format === 'sql' && (
        <Field label={t('넣을 표 이름')} hint={t('INSERT INTO 뒤에 들어가요. 스키마.표 처럼 써도 돼요')}>
          <input value={o.table} onChange={(e) => set({ table: e.target.value })} className="mono" spellCheck={false} />
        </Field>
      )}
      {(o.format === 'csv' || o.format === 'xlsx') && <Check checked={o.header} onChange={(v) => set({ header: v })}>{t('첫 줄에 열 이름')}</Check>}
      {o.format === 'csv' && <Check checked={o.bom} onChange={(v) => set({ bom: v })}>{t('엑셀에서 한글이 안 깨지게 (UTF-8 BOM)')}</Check>}
      {o.format === 'xlsx' && <p className="muted small">{t('숫자는 숫자로, 나머지는 글자로 들어가요. 한 시트에 104만 행까지예요.')}</p>}
      {o.format === 'json' && <p className="muted small">{t('행마다 {열: 값} 객체가 든 배열이에요. 바이너리는 0x… 글자로 들어가요.')}</p>}
    </Dialog>
  )
}
