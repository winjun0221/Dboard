// 드라이버가 준 값 → 화면으로 보낼 칸 값(Cell). 정확도를 잃지 않게 큰 정수는 글자로, 바이너리는 16진수로
import { t } from '../shared/i18n'
import type { Cell } from '../shared/types'

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Date → 'YYYY-MM-DD HH:mm:ss.SSS' (UTC 기준: SQL Server 드라이버가 저장된 값을 UTC로 준다) */
export function formatUtc(d: Date, part: 'date' | 'time' | 'datetime' = 'datetime'): string {
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const ms = d.getUTCMilliseconds()
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${ms ? '.' + pad(ms, 3) : ''}`
  return part === 'date' ? date : part === 'time' ? time : `${date} ${time}`
}

export function toHex(b: Uint8Array, limit = Infinity): string {
  const n = Math.min(b.length, limit)
  let s = ''
  for (let i = 0; i < n; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

/** binLimit: 화면에는 앞 64바이트만, CSV 내보내기는 전부 */
export function toCell(v: unknown, binLimit = 64): Cell {
  if (v === null || v === undefined) return null
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v
    case 'number':
      return Number.isFinite(v) ? v : String(v)
    case 'bigint':
      return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
    case 'object':
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : formatUtc(v)
      if (v instanceof Uint8Array) return { bin: toHex(v, binLimit), size: v.length }
      if (ArrayBuffer.isView(v)) return { bin: toHex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), binLimit), size: v.byteLength }
      try {
        return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
      } catch {
        return String(v)
      }
    default:
      return String(v)
  }
}

/** 화면에서 온 값을 드라이버에 넘길 값으로 (바이너리 칸은 앞부분만 있어서 넘길 수 없다) */
export function toParam(v: Cell): string | number | boolean | null {
  if (v === null || typeof v !== 'object') return v
  throw new Error(t('바이너리 값은 여기서 바꿀 수 없어요'))
}
