// SQL 편집기 결과 표 하나: 정렬(가져온 행 안에서), 복사, CSV 내보내기, 잘렸으면 모두 가져오기
import { useMemo, useRef, useState } from 'react'
import { ClipboardCopy, Download, ListPlus, TriangleAlert } from 'lucide-react'
import type { SortKey, StatementResult } from '../../../shared/types'
import { Grid, type GridHandle } from './Grid'
import { ExportDialog } from '../dialogs/ExportDialog'
import { api, errorText } from '../api'
import { useUi } from '../ui'
import { t } from '../i18n'
import { cellCopy, compareCells, fmtNum, formatMs, isNumericType } from '../format'

export function ResultView({ result, name, fetchAll, exportAll }: {
  result: StatementResult
  name: string
  /** 최대 행 수 없이 다시 가져오기 (읽기만 하는 문장일 때) */
  fetchAll: (() => void) | null
  /** 다시 실행해서 파일로 전부 (읽기만 하는 문장일 때) */
  exportAll: ((o: Parameters<typeof api.saveCsv>[3]) => Promise<void>) | null
}) {
  const ui = useUi()
  const grid = useRef<GridHandle>(null)
  const [sort, setSort] = useState<SortKey[]>([])
  const columns = useMemo(() => result.columns ?? [], [result])
  const order = useMemo(() => {
    const idx = result.rows.map((_, i) => i)
    if (!sort.length) return idx
    const keys = sort.map((s) => ({ c: columns.findIndex((x) => x.name === s.column), desc: s.desc })).filter((k) => k.c >= 0)
    const num = columns.map((c) => isNumericType(c.type))
    return idx.sort((a, b) => {
      for (const k of keys) {
        const d = compareCells(result.rows[a][k.c], result.rows[b][k.c], num[k.c])
        if (d) return k.desc ? -d : d
      }
      return a - b
    })
  }, [result, sort, columns])

  const onSort = (column: string, add: boolean) => {
    setSort((cur) => {
      const ex = cur.find((s) => s.column === column)
      // 오름 → 내림 → 없음
      const next = !ex ? { column, desc: false } : !ex.desc ? { column, desc: true } : null
      const rest = add ? cur.filter((s) => s.column !== column) : []
      return next ? [...rest, next] : rest
    })
  }

  const copyAll = () => {
    const lines = [columns.map((c) => c.name).join('\t'), ...order.map((r) => result.rows[r].map(cellCopy).join('\t'))]
    void api.copyText(lines.join('\r\n'))
    ui.notify(t('{n}행을 복사했어요', { n: fmtNum(result.rows.length) }), 'success')
  }

  const doExport = () => ui.open((close) => (
    <ExportDialog
      title={t('CSV로 내보내기')}
      rows={result.rows.length}
      rerun={result.truncated ? { allowed: !!exportAll } : undefined}
      onClose={close}
      onSubmit={async (o, all) => {
        try {
          if (all && exportAll) await exportAll(o)
          else {
            const r = await api.saveCsv(name, columns.map((c) => c.name), order.map((i) => result.rows[i]), o)
            if (r) ui.notify(t('{n}행을 저장했어요: {path}', { n: fmtNum(r.rows), path: r.path }), 'success')
          }
          close()
        } catch (e) {
          ui.notify(errorText(e), 'error')
        }
      }}
    />
  ))

  return (
    <div className="result-view">
      <div className="result-bar toolbar">
        <span className="result-count"><b>{fmtNum(result.rows.length)}</b>{t('행')}</span>
        <span className="muted small">{formatMs(result.ms)}</span>
        {result.truncated && (
          <span className="chip warn" title={t('설정의 최대 행 수에서 끊었어요')}>
            <TriangleAlert />{t('처음 {n}행만 가져왔어요', { n: fmtNum(result.rows.length) })}
            {fetchAll && <button className="link" onClick={fetchAll}><ListPlus />{t('모두 가져오기')}</button>}
          </span>
        )}
        <span className="spacer" />
        <button className="tbtn" onClick={copyAll} title={t('열 이름과 함께 전부 복사 (엑셀에 붙여 넣기 좋게 탭으로 구분)')}><ClipboardCopy />{t('복사')}</button>
        <button className="tbtn" onClick={doExport}><Download />{t('CSV')}</button>
      </div>
      <Grid
        handle={grid}
        columns={columns}
        rowCount={result.rows.length}
        cell={(r, c) => result.rows[order[r]][c]}
        sort={sort}
        onSort={onSort}
        widthKey={result.sql + '\u0000' + columns.map((c) => c.name).join('\u0000')}
        onMenu={(e) => ui.menu(e, [
          { label: t('복사'), icon: ClipboardCopy, hint: 'Ctrl+C', onClick: () => grid.current?.copy(false) },
          { label: t('열 이름과 함께 복사'), hint: 'Ctrl+Shift+C', onClick: () => grid.current?.copy(true) },
          'sep',
          { label: t('CSV로 내보내기…'), icon: Download, onClick: doExport },
        ])}
      />
    </div>
  )
}
