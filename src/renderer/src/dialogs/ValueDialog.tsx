// 값 보기·고치기: 글(여러 줄·NULL) / JSON 보기 좋게 / 바이너리는 16진수·이미지 미리 보기, 파일로 저장
import { useEffect, useMemo, useState } from 'react'
import { ClipboardCopy, Download, LoaderCircle, Pencil } from 'lucide-react'
import { isBin, type Cell } from '../../../shared/types'
import { Check, Dialog, Tabs } from '../components/Dialog'
import { api, errorText } from '../api'
import { cellText } from '../format'
import { t } from '../i18n'

type Mode = 'text' | 'json' | 'hex' | 'image'

/** 16진수 → 바이트 (보기용으로 limit까지) */
function bytesOf(hex: string, limit = Infinity): Uint8Array {
  const n = Math.min(hex.length / 2, limit)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

/** 이미지 형식 알아보기 (앞 바이트) */
function imageType(b: Uint8Array): string | null {
  const at = (...xs: number[]) => xs.every((x, i) => b[i] === x)
  if (at(0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (at(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0x42, 0x4d)) return 'image/bmp'
  if (at(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

/** 주소 | 16바이트 | 글자 */
function hexDump(b: Uint8Array, limit = 64 * 1024): string {
  const lines: string[] = []
  const n = Math.min(b.length, limit)
  for (let i = 0; i < n; i += 16) {
    const row = b.subarray(i, Math.min(i + 16, n))
    const hex = [...row].map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ')
    const asc = [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${asc}`)
  }
  return lines.join('\n')
}

function prettyJson(s: string): string | null {
  const v = s.trim()
  if (!v || (v[0] !== '{' && v[0] !== '[')) return null
  try {
    return JSON.stringify(JSON.parse(v), null, 2)
  } catch {
    return null
  }
}

export function ValueDialog({ column, type, value, readOnly, load, save, onClose, onSubmit }: {
  column: string
  type: string
  value: Cell
  readOnly?: boolean
  /** 값 전체 불러오기 (화면 표의 바이너리는 앞부분만) */
  load?: () => Promise<Cell>
  /** 파일로 저장 */
  save?: () => Promise<void>
  onClose: () => void
  onSubmit?: (v: Cell) => void
}) {
  const [full, setFull] = useState<Cell>(value)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const bin = full !== null && isBin(full)
  const [text, setText] = useState(value === null || bin ? '' : cellText(value))
  const [isNull, setIsNull] = useState(value === null)
  const json = useMemo(() => (bin || isNull ? null : prettyJson(text)), [bin, isNull, text])
  const bytes = useMemo(() => (full !== null && isBin(full) ? bytesOf(full.bin) : null), [full])
  const image = bytes ? imageType(bytes) : null
  const [mode, setMode] = useState<Mode>(bin ? 'hex' : 'text')

  // 바이너리는 열자마자 전체를 불러온다 (이미지·16진수)
  useEffect(() => {
    if (!load || value === null || !isBin(value) || value.size <= value.bin.length / 2) return
    setLoading(true)
    load().then(setFull, (e) => setLoadError(errorText(e))).finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (image && mode === 'hex') setMode('image')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image])

  const modes: { value: Mode; label: string }[] = bin
    ? [{ value: 'hex', label: t('16진수') }, ...(image ? [{ value: 'image' as const, label: t('이미지') }] : [])]
    : [{ value: 'text', label: t('글') }, ...(json ? [{ value: 'json' as const, label: 'JSON' }] : [])]
  const editable = !readOnly && !bin && !!onSubmit && mode === 'text'
  const truncated = full !== null && isBin(full) && full.size > full.bin.length / 2
  const dataUrl = useMemo(() => {
    if (!bytes || !image) return null
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return `data:${image};base64,${btoa(s)}`
  }, [bytes, image])

  const copy = () => void api.copyText(mode === 'json' && json ? json : bin && full && isBin(full) ? '0x' + full.bin.toUpperCase() : text)

  return (
    <Dialog
      title={<>{column} <span className="muted small mono">{type}</span></>}
      icon={Pencil}
      width={680}
      submitLabel={t('바꾸기')}
      onClose={onClose}
      onSubmit={editable ? () => onSubmit!(isNull ? null : text) : undefined}
      footer={(
        <>
          <button type="button" className="btn" onClick={copy} disabled={isNull || loading}><ClipboardCopy />{t('복사')}</button>
          {save && <button type="button" className="btn" onClick={() => void save()} disabled={isNull || loading}><Download />{t('파일로 저장')}</button>}
        </>
      )}
    >
      {modes.length > 1 && <Tabs value={mode} onChange={setMode} tabs={modes} />}
      {loading && <div className="center-fill small"><LoaderCircle className="spin small-icon" /></div>}
      {loadError && <div className="banner error inline">{loadError}</div>}
      {mode === 'text' && (
        <>
          <textarea className="value-text mono" value={text} disabled={isNull || !editable} onChange={(e) => setText(e.target.value)} rows={14} spellCheck={false} />
          {editable && <Check checked={isNull} onChange={setIsNull}>NULL</Check>}
        </>
      )}
      {mode === 'json' && json && <pre className="value-pre mono">{json}</pre>}
      {mode === 'hex' && bytes && (
        <>
          <p className="muted small">{t('{n}바이트', { n: (full && isBin(full) ? full.size : bytes.length).toLocaleString('en-US') })}{truncated ? ' · ' + t('앞부분만 보여요') : ''}{bytes.length > 64 * 1024 ? ' · ' + t('16진수는 앞 64KB만 보여요') : ''}</p>
          <pre className="value-pre mono hex">{hexDump(bytes)}</pre>
        </>
      )}
      {mode === 'image' && dataUrl && <div className="value-image"><img src={dataUrl} alt={column} /></div>}
    </Dialog>
  )
}
