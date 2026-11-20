// 도움말 › 단축키
import { Keyboard } from 'lucide-react'
import { Dialog } from '../components/Dialog'
import { tk, t } from '../i18n'

const GROUPS = [
  {
    title: tk('SQL 편집기'),
    keys: [
      ['Ctrl+Enter', tk('고른 부분, 없으면 커서가 있는 문장 실행')],
      ['Alt+X', tk('스크립트 전체 실행')],
      ['Ctrl+Space', tk('자동 완성')],
      ['Ctrl+/', tk('주석 켜고 끄기')],
      ['Ctrl+F', tk('찾기')],
    ],
  },
  {
    title: tk('결과·표 데이터'),
    keys: [
      ['Ctrl+C', tk('고른 칸 복사')],
      ['Ctrl+Shift+C', tk('열 이름과 함께 복사')],
      ['Enter · F2', tk('칸 고치기')],
      ['Delete', tk('행 삭제 표시')],
      ['Ctrl+Z', tk('되돌리기')],
      ['Ctrl+S', tk('표 데이터 저장')],
    ],
  },
  {
    title: tk('창'),
    keys: [
      ['Ctrl+]', tk('새 SQL 편집기')],
      ['Ctrl+W', tk('탭 닫기')],
      ['Ctrl+Tab', tk('다음 탭')],
      ['Ctrl+B', tk('옆 칸 숨기기·보이기')],
      ['Ctrl+,', tk('설정')],
      ['Ctrl + = · - · 0', tk('화면 크게 · 작게 · 원래대로')],
    ],
  },
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title={t('단축키')} icon={Keyboard} width={560} onClose={onClose}>
      <div className="shortcut-groups">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{t(g.title)}</h3>
            {g.keys.map(([k, label]) => (
              <div key={k} className="shortcut-row">
                <span>{t(label)}</span>
                <kbd>{k}</kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  )
}
