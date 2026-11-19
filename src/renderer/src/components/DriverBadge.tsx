import type { DriverKind } from '../../../shared/types'
import { DRIVER_COLOR, DRIVER_LABEL, DRIVER_SHORT } from '../format'

/** 접속 종류 표시: 색 네모 + 두 글자 (제품 로고는 쓰지 않는다) */
export function DriverBadge({ driver, size = 18 }: { driver: DriverKind; size?: number }) {
  return (
    <span className="driver-badge" title={DRIVER_LABEL[driver]} style={{ background: DRIVER_COLOR[driver], width: size, height: size, fontSize: Math.round(size * 0.42), borderRadius: Math.round(size * 0.28) }}>
      {DRIVER_SHORT[driver]}
    </span>
  )
}
