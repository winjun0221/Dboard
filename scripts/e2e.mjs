// 실제 앱을 띄워 확인: 접속 만들기(비밀번호 암호화) → 탐색기 → 표 데이터 보기·정렬·조건·고치기·추가·삭제·되돌리기·저장 미리 보기
// → SQL 편집기(커서 문장·고른 부분·스크립트·잘림·모두 가져오기·오류·위험 문장 확인·복사) → CSV 내보내기·가져오기(EUC-KR)
// → 열·인덱스·DDL → 실행 기록 → 영어 전환 → 한 번에 하나만 실행
// DBOARD_E2E_SERVERS=1이면 Docker 시험 서버(npm run test:db로 올린 것)로 MySQL·PostgreSQL·SQL Server·SSH 터널도
// 사용: npm run e2e  (스크린샷: E2E_OUT 폴더, 기본은 임시 폴더)
import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import iconv from 'iconv-lite'
import { makeSampleDb } from './sample-db.mjs'

const out = path.resolve(process.env.E2E_OUT || path.join(os.tmpdir(), 'dboard-e2e'))
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
const dbFile = makeSampleDb(path.join(out, 'shop.db'))
const userData = path.join(out, 'userdata')
fs.mkdirSync(userData, { recursive: true })
// 한국어로 시작 (선택자가 한국어 문구를 씀). 끝에서 영어로 바꿔 확인한다. 결과 최대 행 수 500
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ language: 'ko', maxRows: 500, pageSize: 200, autoUpdate: false }))

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) {
  const end = Date.now() + ms
  for (;;) {
    try {
      if (await fn()) return true
    } catch {}
    if (Date.now() > end) return false
    await sleep(120)
  }
}
const sql = (q, ...p) => {
  const db = new DatabaseSync(dbFile)
  try {
    return db.prepare(q).all(...p)
  } finally {
    db.close()
  }
}

const electronPath = (await import('electron')).default
const env = { ...process.env, DBOARD_USER_DATA: userData }
const app = await electron.launch({ executablePath: electronPath, args: ['.'], env })
/** 스크린샷 (문서에 쓸 수 있게 알림은 닫고 찍는다) */
const shot = async (win, name) => {
  await win.evaluate(() => document.querySelectorAll('.toast .icon-btn').forEach((b) => b.click())).catch(() => {})
  await win.waitForTimeout(150)
  await win.screenshot({ path: path.join(out, name) })
}

/** 파일 고르기·저장 창 대신 정해 둔 경로를 돌려준다 */
async function nextDialog(kind, file) {
  await app.evaluate(({ dialog }, { kind, file }) => {
    if (kind === 'open') dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    else dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, { kind, file })
}

const pageErrors = []
try {
  const win = await app.firstWindow()
  win.on('pageerror', (e) => pageErrors.push(String(e)))
  win.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
  const submit = () => win.locator('.dialog button[type=submit]').last().click()
  const menu = async (target, item) => {
    await target.click({ button: 'right' })
    await win.locator('.ctx-menu .menu-item', { hasText: item }).first().click()
  }

  // ── 시작 화면 ──
  await win.waitForSelector('.welcome', { timeout: 20000 })
  check('welcome screen', await win.locator('.welcome h1').innerText() === 'DBoard')
  await shot(win, '01-welcome.png')

  // ── 접속 만들기: SQLite ──
  await win.locator('.conn-card.add').click()
  await win.locator('.driver-card', { hasText: 'SQLite' }).click()
  await win.locator('.dialog input.mono').fill(dbFile)
  await win.locator('.dialog .field', { hasText: '이름' }).locator('input').fill('shop')
  await win.locator('.dialog button', { hasText: '연결 시험' }).click()
  check('connection test ok', await until(async () => (await win.locator('.test-ok').count()) > 0), await win.locator('.test-ok, .test-fail').first().innerText().catch(() => ''))
  await shot(win, '02-connection-dialog.png')
  await submit()
  await win.waitForSelector('.tree-row.conn-row')
  check('connection saved', (await win.locator('.tree-row.conn-row').innerText()).includes('shop'))

  // ── 탐색기 ──
  await win.locator('.tree-row.conn-row').click()
  await win.waitForSelector('.tree-row[data-key^="d:"]')
  await win.locator('.tree-row[data-key^="d:"]', { hasText: 'main' }).click()
  await win.locator('.tree-row[data-key^="f:"][data-key$=":table"]').click()
  await win.waitForSelector('.tree-row[data-key^="t:"]')
  const tables = await win.locator('.tree-row[data-key^="t:"]').allInnerTexts()
  check('tree lists tables', ['customers', 'notes', 'orders'].every((n) => tables.some((x) => x.includes(n))), tables.join(','))
  await win.locator('.tree-row[data-key^="f:"][data-key$=":view"]').click()
  check('tree lists view', await until(async () => (await win.locator('.tree-row[data-key^="t:"][data-key$=":v_big_orders"]').count()) === 1))
  // 표 펼치기 → 열·인덱스
  await win.locator('.tree-row[data-key^="t:"][data-key$=":orders"]').click()
  check('tree shows columns', await until(async () => (await win.locator('.tree-row.leaf', { hasText: 'customer_id' }).count()) > 0))
  await win.locator('.tree-row[data-key^="ti:"]').first().click()
  check('tree shows indexes', await until(async () => (await win.locator('.tree-row.leaf', { hasText: 'ix_orders_status' }).count()) > 0))
  await shot(win, '03-tree.png')

  // ── 표 데이터 ──
  await win.locator('.tree-row[data-key^="t:"][data-key$=":orders"]').dblclick()
  await win.waitForSelector('.data-view .g-row')
  check('table data loads first page', (await win.locator('.data-foot').innerText()).includes('200행+'))
  // 정렬: total 두 번 = 내림차순
  const totalHead = win.locator('.data-view .g-hcell', { hasText: 'total' })
  await totalHead.click()
  await win.waitForTimeout(300)
  await totalHead.click()
  await until(async () => (await totalHead.locator('.sort-icon').count()) === 1)
  await win.waitForTimeout(400)
  const firstTotal = await win.locator('.data-view .g-row').first().locator('.g-cell').nth(2).innerText()
  const maxTotal = sql('SELECT MAX(total) AS m FROM orders')[0].m
  check('server-side sort desc', Number(firstTotal) === maxTotal, `${firstTotal} vs ${maxTotal}`)
  // 조건
  await win.locator('.filter-box input').fill("status = 'paid' AND total > 900")
  await win.locator('.filter-box input').press('Enter')
  const paidCount = sql("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND total > 900")[0].n
  check('filter applied', await until(async () => (await win.locator('.data-foot').innerText()).startsWith(`${paidCount}행`)), await win.locator('.data-foot').innerText())
  await win.locator('.data-foot .link', { hasText: '전체 행 수 세기' }).click()
  check('count rows', await until(async () => (await win.locator('.data-foot').innerText()).includes(`전체 ${paidCount}행`)))
  await shot(win, '04-table-data.png')

  // 고치기: customers
  await win.locator('.tree-row[data-key^="t:"][data-key$=":customers"]').dblclick()
  await win.waitForSelector('.tab.on:has-text("customers")')
  const cust = win.locator('.tab-pane:visible .data-view')
  await cust.locator('.g-row').first().waitFor()
  const nameCell = cust.locator('.g-row').nth(0).locator('.g-cell').nth(1)
  await nameCell.dblclick()
  await win.locator('.g-editor').fill("김민준'수정")
  await win.locator('.g-editor').press('Enter')
  check('edited cell marked', (await cust.locator('.g-cell.edited').count()) === 1)
  // 행 추가
  await cust.locator('button', { hasText: '행 추가' }).click()
  await win.locator('.g-editor').waitFor()
  await win.locator('.g-editor').fill('새 고객')
  await win.locator('.g-editor').press('Tab')
  await win.locator('.g-editor').waitFor({ state: 'detached' }).catch(() => {})
  check('added row shown', (await cust.locator('.g-row.added').count()) === 1)
  // 행 삭제 (3번째 행 고르고 Delete)
  await cust.locator('.g-row').nth(2).locator('.g-num').click()
  await win.keyboard.press('Delete')
  check('deleted row marked', (await cust.locator('.g-row.deleted').count()) === 1)
  check('pending count', (await cust.locator('.pending-chip').innerText()).includes('3건'))
  // 되돌리기 한 번 → 삭제 취소
  await win.keyboard.press('Control+z')
  check('undo last change', (await cust.locator('.g-row.deleted').count()) === 0 && (await cust.locator('.pending-chip').innerText()).includes('2건'))
  await cust.locator('.g-row').nth(2).locator('.g-num').click()
  await win.keyboard.press('Delete')
  await shot(win, '05-editing.png')
  // 저장 → 미리 보기
  await cust.locator('button', { hasText: '저장 (3)' }).click()
  await win.waitForSelector('.preview-sql .cm-content')
  const preview = await win.locator('.preview-sql .cm-content').innerText()
  check('preview shows statements', /BEGIN[\s\S]*UPDATE "main"\."customers" SET "name" = '김민준''수정' WHERE "id" = 1[\s\S]*DELETE FROM "main"\."customers" WHERE "id" = 3[\s\S]*INSERT INTO "main"\."customers" \("name"\) VALUES \('새 고객'\)[\s\S]*COMMIT/.test(preview), preview.replace(/\s+/g, ' ').slice(0, 300))
  await shot(win, '06-preview.png')
  await submit()
  // 고객 3은 주문이 있어서(외래 키) 삭제가 거부되고, 같이 보낸 수정·추가도 전부 되돌려진다
  check('foreign key error shown', await until(async () => (await win.locator('.toast.error', { hasText: 'FOREIGN KEY' }).count()) === 1))
  check('failed save rolled back everything', sql('SELECT name FROM customers WHERE id = 1')[0].name === '김민준' && sql("SELECT COUNT(*) AS n FROM customers WHERE name = '새 고객'")[0].n === 0)
  await win.locator('.dialog button', { hasText: '취소' }).click()
  // 삭제만 되돌리고 다시 저장
  await cust.locator('.g-row').nth(2).locator('.g-num').click()
  await menu(cust.locator('.g-row').nth(2).locator('.g-cell').nth(1), '이 행 되돌리기')
  check('revert one row', (await cust.locator('.g-row.deleted').count()) === 0 && (await cust.locator('.pending-chip').innerText()).includes('2건'))
  await cust.locator('button', { hasText: '저장 (2)' }).click()
  await win.waitForSelector('.preview-sql .cm-content')
  await submit()
  check('saved to db', await until(() => sql('SELECT name FROM customers WHERE id = 1')[0]?.name === "김민준'수정"))
  check('insert saved', sql("SELECT COUNT(*) AS n FROM customers WHERE name = '새 고객'")[0].n === 1 && sql('SELECT COUNT(*) AS n FROM customers WHERE id = 3')[0].n === 1)
  check('pending cleared after save', await until(async () => (await cust.locator('.pending-chip').count()) === 0))
  // 모두 되돌리기
  await cust.locator('.g-row').nth(0).locator('.g-cell').nth(3).dblclick()
  await win.locator('.g-editor').fill('되돌릴 값')
  await win.locator('.g-editor').press('Enter')
  await cust.locator('button', { hasText: '모두 되돌리기' }).click()
  check('revert all', (await cust.locator('.g-cell.edited').count()) === 0)

  // 기본 키 없는 표 (rowid로 찾기)
  await win.locator('.tree-row[data-key^="t:"][data-key$=":notes"]').dblclick()
  await win.waitForSelector('.tab.on:has-text("notes")')
  const notes = win.locator('.tab-pane:visible .data-view')
  await notes.locator('.g-row').first().waitFor()
  check('rowid key used', (await notes.locator('.data-foot').innerText()).includes('rowid'))
  await notes.locator('.g-row').nth(1).locator('.g-cell').nth(1).dblclick()
  await win.locator('.g-editor').fill('두 번째 메모')
  await win.locator('.g-editor').press('Enter')
  await win.keyboard.press('Control+s')
  await win.waitForSelector('.preview-sql')
  await submit()
  check('rowid update hits exactly one duplicate row', await until(() => sql("SELECT COUNT(*) AS n FROM notes WHERE body = '첫 메모'")[0].n === 1 && sql("SELECT COUNT(*) AS n FROM notes WHERE body = '두 번째 메모'")[0].n === 1))

  // 열·인덱스·DDL 탭
  await win.locator('.tab', { hasText: 'orders' }).click()
  const ordersPane = win.locator('.tab-pane:visible')
  await ordersPane.locator('.seg button', { hasText: '열' }).click()
  check('columns tab', await until(async () => (await ordersPane.locator('.info-table tr', { hasText: 'customer_id' }).count()) === 1))
  await ordersPane.locator('.seg button', { hasText: '인덱스' }).click()
  check('indexes tab', await until(async () => (await ordersPane.locator('.info-table tr', { hasText: 'ix_orders_status' }).count()) === 1))
  await ordersPane.locator('.seg button', { hasText: 'DDL' }).click()
  check('ddl tab', await until(async () => (await ordersPane.locator('.ddl-code .cm-content').innerText()).includes('CREATE TABLE orders')))
  await shot(win, '07-ddl.png')
  await ordersPane.locator('.seg button', { hasText: '데이터' }).click()

  // ── SQL 편집기 ──
  await win.locator('.tab-new').click()
  await win.waitForSelector('.tab-pane:visible .cm-content')
  const ed = win.locator('.tab-pane:visible')
  await ed.locator('.cm-content').click()
  await win.keyboard.insertText('SELECT * FROM orders ORDER BY id;\n\nSELECT COUNT(*) AS n FROM customers;\nSELECT * FROM no_such_table;')
  // 커서를 첫 문장으로
  await win.keyboard.press('Control+Home')
  await win.keyboard.press('Control+Enter')
  await ed.locator('.result-view .g-row').first().waitFor()
  check('run current statement', (await ed.locator('.rtab').count()) === 2)
  check('result truncated at max rows', (await ed.locator('.chip.warn').innerText()).includes('500'))
  await shot(win, '08-editor.png')
  await ed.locator('.chip.warn .link', { hasText: '모두 가져오기' }).click()
  check('fetch all rows', await until(async () => (await ed.locator('.result-count').innerText()).replace(/,/g, '').includes('1200')))
  // 정렬(가져온 행 안에서)
  await ed.locator('.result-view .g-hcell', { hasText: 'id' }).first().click()
  await ed.locator('.result-view .g-hcell', { hasText: 'id' }).first().click()
  check('client-side sort', (await ed.locator('.result-view .g-row').first().locator('.g-cell').first().innerText()) === '1200')
  // 칸 복사 (시스템 클립보드를 못 쓰는 환경도 있어서, 앱이 클립보드에 쓰는 글을 가로채 확인)
  await app.evaluate(({ clipboard }) => {
    globalThis.__clip = ''
    clipboard.writeText = (text) => {
      globalThis.__clip = text
    }
  })
  const clipText = () => app.evaluate(() => globalThis.__clip)
  await ed.locator('.result-view .g-row').first().locator('.g-cell').nth(3).click()
  await win.keyboard.press('Control+c')
  check('copy cell', await until(async () => ['new', 'paid', 'shipped', 'cancelled'].includes(await clipText()), 3000), JSON.stringify(await clipText()))
  // 범위 복사 + 열 이름 (Ctrl+Shift+C → 탭 구분)
  await ed.locator('.result-view .g-row').nth(1).locator('.g-cell').nth(1).click({ modifiers: ['Shift'] })
  await win.keyboard.press('Control+Shift+c')
  const block = await clipText()
  check('copy range with header', /^customer_id\ttotal\tstatus\r\n/.test(block) && block.split('\r\n').length === 3, JSON.stringify(block.slice(0, 80)))
  // CSV 내보내기 (전부 다시 실행)
  const csvOut = path.join(out, 'orders-export.csv')
  await nextDialog('save', csvOut)
  await ed.locator('.result-bar button', { hasText: 'CSV' }).click()
  await submit()
  check('export query csv', await until(() => fs.existsSync(csvOut) && fs.readFileSync(csvOut, 'utf8').trim().split(/\r?\n/).length === 1201))
  // 스크립트 실행: 오류에서 멈춤
  await ed.locator('.cm-content').click()
  await win.keyboard.press('Alt+x')
  check('script stops at error', await until(async () => (await ed.locator('.log-item.fail').count()) === 1))
  check('script results', (await ed.locator('.rtab').count()) === 3)
  check('error message shown', (await ed.locator('.log-error').innerText()).includes('no_such_table'))
  await shot(win, '09-script-error.png')
  // 고른 부분만
  await ed.locator('.cm-content').click()
  await win.keyboard.press('Control+End')
  await win.keyboard.press('Shift+Home')
  await win.keyboard.press('Shift+ArrowUp')
  await win.keyboard.press('Shift+Home')
  // 두 줄(SELECT COUNT…; SELECT * FROM no_such…)
  await win.keyboard.press('Control+Enter')
  check('run selection splits statements', await until(async () => (await ed.locator('.log-item').count()) === 2))
  // 위험 문장 확인
  await ed.locator('.cm-content').click()
  await win.keyboard.press('Control+a')
  await win.keyboard.insertText('DELETE FROM notes')
  await win.keyboard.press('Control+Enter')
  check('dangerous statement confirm', await until(async () => (await win.locator('.dialog', { hasText: 'WHERE 없는' }).count()) === 1))
  await win.locator('.dialog button', { hasText: '취소' }).click()
  check('dangerous cancelled', sql('SELECT COUNT(*) AS n FROM notes')[0].n === 3)
  // 자동 완성
  await ed.locator('.cm-content').click()
  await win.keyboard.press('Control+a')
  await win.keyboard.insertText('SELECT * FROM cust')
  await win.keyboard.press('Control+Space')
  const ac = await until(async () => (await win.locator('.cm-tooltip-autocomplete li', { hasText: 'customers' }).count()) > 0, 4000)
  check('autocomplete tables', ac, `tooltips=${await win.locator('.cm-tooltip-autocomplete').count()}`)
  if (!ac) await shot(win, 'zz-autocomplete.png')
  await win.keyboard.press('Escape')

  // ── 표 CSV 내보내기·가져오기 ──
  await win.locator('.tab', { hasText: 'customers' }).click()
  const custPane = win.locator('.tab-pane:visible')
  const tableCsv = path.join(out, 'customers.csv')
  await nextDialog('save', tableCsv)
  await custPane.locator('.data-bar button', { hasText: 'CSV' }).click()
  await submit()
  check('export table csv (BOM + header)', await until(() => fs.existsSync(tableCsv) && fs.readFileSync(tableCsv, 'utf8').startsWith('﻿id,name,email,city,joined')))
  // EUC-KR CSV (한국 엑셀이 흔히 저장하는 인코딩)
  const csvIn = path.join(out, 'import-euckr.csv')
  const text = '이름,이메일,도시\r\n홍길동,hong@example.com,서울\r\n"성춘향, 남원",chun@example.com,\r\n'
  fs.writeFileSync(csvIn, iconv.encode(text, 'euc-kr'))
  await nextDialog('open', csvIn)
  await custPane.locator('.data-bar button', { hasText: '가져오기' }).click()
  await win.waitForSelector('.import-map')
  // 이름이 다르니 직접 고른다
  const selects = win.locator('.import-map select')
  await selects.nth(0).selectOption('name')
  await selects.nth(1).selectOption('email')
  await selects.nth(2).selectOption('city')
  check('csv encoding detected', (await win.locator('.dialog').innerText()).includes('EUC-KR'))
  await shot(win, '10-import.png')
  await submit()
  check('csv imported (EUC-KR, quoted comma, empty→NULL)', await until(() => sql("SELECT city FROM customers WHERE name = '성춘향, 남원'")[0]?.city === null && sql("SELECT COUNT(*) AS n FROM customers WHERE name = '홍길동'")[0].n === 1))

  // ── 실행 기록 ──
  await win.locator('.rail-btn[title="실행 기록"]').click()
  check('history panel', await until(async () => (await win.locator('.hist-item', { hasText: 'SELECT COUNT(*) AS n FROM customers' }).count()) > 0))
  check('history keeps errors', (await win.locator('.hist-item.fail').count()) > 0)
  await shot(win, '11-history.png')
  await win.locator('.rail-btn[title="탐색기"]').click()

  // ── 접속 정보 파일에 비밀번호가 글자 그대로 없는지 (MySQL 접속을 비밀번호와 함께 저장) ──
  await win.locator('.side-head button[title="새 연결"]').click()
  await win.locator('.driver-card', { hasText: 'MySQL' }).click()
  await win.locator('.dialog .field', { hasText: '이름' }).locator('input').fill('mysql-test')
  await win.locator('.dialog .field', { hasText: '호스트' }).locator('input').fill('127.0.0.1')
  await win.locator('.dialog .field', { hasText: '포트' }).locator('input').fill('33061')
  await win.locator('.dialog input[type=password]').fill('dboard_test')
  await submit()
  await win.waitForSelector('.tree-row.conn-row:has-text("mysql-test")')
  const stored = fs.readFileSync(path.join(userData, 'connections.json'), 'utf8')
  check('password encrypted at rest', !stored.includes('dboard_test') && /"password": "[A-Za-z0-9+/=]{20,}"/.test(stored))

  if (process.env.DBOARD_E2E_SERVERS === '1') await servers(win, submit)

  // ── 영어 전환 ──
  await win.locator('.rail-btn[title="설정"]').click()
  await win.locator('.dialog select').first().selectOption('en')
  await submit()
  check('switch to English', await until(async () => (await win.locator('.rail-btn[title="Explorer"]').count()) === 1))
  await win.locator('.tab', { hasText: 'orders' }).click()
  check('English data view', await until(async () => (await win.locator('.tab-pane:visible .data-bar').innerText()).includes('Add row')))
  await shot(win, '12-english.png')

  // ── 한 번에 하나만 실행 ──
  const second = spawn(electronPath, ['.'], { env, stdio: 'ignore' })
  const exited = await new Promise((r) => {
    const t = setTimeout(() => r(false), 15000)
    second.on('exit', () => {
      clearTimeout(t)
      r(true)
    })
  })
  check('single instance (second launch exits)', exited)
  if (!exited) second.kill()

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (e) {
  check('e2e run', false, e instanceof Error ? e.stack ?? e.message : String(e))
  try {
    const w = await app.firstWindow()
    await shot(w, 'zz-failure.png')
  } catch {}
} finally {
  await app.close().catch(() => {})
}

/** Docker 시험 서버: 접속 만들기 → 탐색기 → 편집기 실행 → 표 데이터 고치기 */
async function servers(win, submit) {
  const conns = [
    { kind: 'MySQL', name: 'my8', host: '127.0.0.1', port: '33061', user: 'root', pw: 'dboard_test', db: 'dboard_test' },
    { kind: 'MariaDB', name: 'maria', host: '127.0.0.1', port: '33062', user: 'root', pw: 'dboard_test', db: 'dboard_test' },
    { kind: 'PostgreSQL', name: 'pg17', host: '127.0.0.1', port: '54321', user: 'postgres', pw: 'dboard_test', db: 'dboard_test' },
    { kind: 'SQL Server', name: 'mssql', host: '127.0.0.1', port: '14331', user: 'sa', pw: 'Dboard_test1!', db: 'master' },
  ]
  for (const c of conns) {
    await win.locator('.side-head button[title="새 연결"]').click()
    await win.locator('.driver-card', { hasText: c.kind }).click()
    const dlg = win.locator('.dialog')
    await dlg.locator('.field', { hasText: '이름' }).locator('input').fill(c.name)
    await dlg.locator('.field', { hasText: '호스트' }).locator('input').fill(c.host)
    await dlg.locator('.field', { hasText: '포트' }).locator('input').fill(c.port)
    await dlg.locator('.field', { hasText: /^DB/ }).locator('input').fill(c.db)
    await dlg.locator('.field', { hasText: '사용자' }).locator('input').fill(c.user)
    await dlg.locator('input[type=password]').fill(c.pw)
    await dlg.locator('button', { hasText: '연결 시험' }).click()
    const ok = await until(async () => (await win.locator('.test-ok').count()) > 0, 20000)
    check(`[${c.kind}] connection test`, ok, await win.locator('.test-ok, .test-fail').first().innerText().catch(() => ''))
    await submit()
    const row = win.locator('.tree-row.conn-row', { hasText: c.name })
    await row.click()
    check(`[${c.kind}] tree databases`, await until(async () => (await win.locator(`.tree-row[data-key^="d:"]`, { hasText: c.db }).count()) > 0, 20000))
    // 편집기에서 표 만들고 데이터 넣기
    await menu2(win, row, '새 SQL 편집기')
    await win.waitForSelector('.tab-pane:visible .cm-content')
    const ed = win.locator('.tab-pane:visible')
    if (c.db && c.kind !== 'SQL Server' && c.kind !== 'PostgreSQL') await ed.locator('.ctx-pick select').nth(1).selectOption(c.db).catch(() => {})
    const tbl = 'e2e_' + c.name.replace(/\W/g, '')
    const ddl = c.kind === 'SQL Server'
      ? `IF OBJECT_ID('${tbl}') IS NOT NULL DROP TABLE ${tbl};\nGO\nCREATE TABLE ${tbl} (id INT IDENTITY PRIMARY KEY, name NVARCHAR(50));\nGO\nINSERT INTO ${tbl} (name) VALUES (N'가'), (N'나');`
      : c.kind === 'PostgreSQL'
        ? `DROP TABLE IF EXISTS ${tbl};\nCREATE TABLE ${tbl} (id SERIAL PRIMARY KEY, name VARCHAR(50));\nINSERT INTO ${tbl} (name) VALUES ('가'), ('나');`
        : `DROP TABLE IF EXISTS ${tbl};\nCREATE TABLE ${tbl} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50));\nINSERT INTO ${tbl} (name) VALUES ('가'), ('나');`
    await ed.locator('.cm-content').click()
    await win.keyboard.insertText(ddl + `\nSELECT * FROM ${tbl} ORDER BY id;`)
    await win.keyboard.press('Alt+x')
    check(`[${c.kind}] script runs`, await until(async () => (await ed.locator('.result-view .g-row').count()) === 2, 20000), await ed.locator('.log-error').first().innerText().catch(() => ''))
    await shot(win, `20-${c.name}-editor.png`)
    await win.keyboard.press('Control+w')
  }

  // SSH 터널: 시험 SSH 서버(127.0.0.1:22221)를 거쳐, 그 서버에서 본 주소 postgres:5432로
  await win.locator('.side-head button[title="새 연결"]').click()
  await win.locator('.driver-card', { hasText: 'PostgreSQL' }).click()
  const dlg = win.locator('.dialog')
  await dlg.locator('.field', { hasText: '이름' }).locator('input').fill('pg-ssh')
  await dlg.locator('.field', { hasText: '호스트' }).locator('input').fill('postgres')
  await dlg.locator('.field', { hasText: '포트' }).locator('input').fill('5432')
  await dlg.locator('.field', { hasText: /^DB/ }).locator('input').fill('dboard_test')
  await dlg.locator('input[type=password]').fill('dboard_test')
  await dlg.locator('.seg button', { hasText: 'SSH 터널' }).click()
  await dlg.locator('.check', { hasText: 'SSH 터널로 연결' }).click()
  await dlg.locator('.field', { hasText: 'SSH 호스트' }).locator('input').fill('127.0.0.1')
  await dlg.locator('.field', { hasText: '포트' }).locator('input').fill('22221')
  await dlg.locator('.field', { hasText: 'SSH 사용자' }).locator('input').fill('dboard')
  await dlg.locator('.field', { hasText: 'SSH 비밀번호' }).locator('input').fill('dboard_test')
  await shot(win, '21-ssh.png')
  await dlg.locator('button', { hasText: '연결 시험' }).click()
  check('[SSH] tunnel connection test', await until(async () => (await win.locator('.test-ok').count()) > 0, 20000), await win.locator('.test-ok, .test-fail').first().innerText().catch(() => ''))
  await submit()
  const row = win.locator('.tree-row.conn-row', { hasText: 'pg-ssh' })
  await row.click()
  check('[SSH] tree through tunnel', await until(async () => (await win.locator('.tree-row[data-key^="d:"]', { hasText: 'dboard_test' }).count()) > 0, 20000))
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'connections.json'), 'utf8')).connections.find((x) => x.name === 'pg-ssh')
  check('[SSH] ssh password encrypted at rest', !!saved && Object.values(saved.secrets).every((v) => v !== 'dboard_test' && /^[A-Za-z0-9+/=]{20,}$/.test(v)) && !!saved.secrets.sshPassword)
  const hosts = JSON.parse(fs.readFileSync(path.join(userData, 'known_hosts.json'), 'utf8'))
  check('[SSH] host key remembered', /^SHA256:/.test(hosts['127.0.0.1:22221'] ?? ''))
}

async function menu2(win, target, item) {
  await target.click({ button: 'right' })
  await win.locator('.ctx-menu .menu-item', { hasText: item }).first().click()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed → ${out}`)
process.exit(failed.length ? 1 : 0)
