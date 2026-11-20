// 설치된 DBoard.exe(또는 인자로 준 exe, 예: release/win-unpacked/DBoard.exe)를 띄워 실제로 도는지 확인:
// 시험용 SQLite 접속을 미리 넣어 두고 → 연결 → SQL 실행(설치본 안의 SQLite 작업 스레드) → 제목 줄 메뉴 → SQL 덤프 → 덤프 다시 넣기 → 창 캡처
// 사용: node scripts/smoke-installed.mjs [exe 경로] [결과 폴더]   (Windows 전용)
import { _electron as electron } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeSampleDb } from './sample-db.mjs'

const exe = path.resolve(process.argv[2] || path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DBoard', 'DBoard.exe'))
if (!fs.existsSync(exe)) {
  console.error('DBoard 실행 파일이 없습니다: ' + exe)
  process.exit(1)
}
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'dboard-smoke'))
fs.rmSync(out, { recursive: true, force: true })
const userData = path.join(out, 'userdata')
fs.mkdirSync(userData, { recursive: true })
const db = makeSampleDb(path.join(out, 'smoke.db'))
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ language: 'ko', autoUpdate: false }))
fs.writeFileSync(path.join(userData, 'connections.json'), JSON.stringify({
  version: 1,
  connections: [{
    id: '00000000-0000-4000-8000-000000000001', name: 'smoke', driver: 'sqlite', color: '', host: '', port: 0, database: '', user: '', file: db,
    savePassword: true, ssl: 'off', showSystem: false, ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password', keyFile: '' }, secrets: {},
  }],
}))

let ok = false
const app = await electron.launch({ executablePath: exe, env: { ...process.env, DBOARD_USER_DATA: userData } })
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.wl-item.conn', { timeout: 30000 })
  const menus = await win.locator('.titlebar .menubar-btn').count()
  await win.locator('.wl-item.conn', { hasText: 'smoke' }).click()
  await win.waitForSelector('.tab-pane:visible .cm-content', { timeout: 20000 })
  await win.locator('.tab-pane:visible .cm-content').click()
  await win.keyboard.insertText('SELECT COUNT(*) AS n FROM orders')
  await win.keyboard.press('Control+Enter')
  await win.waitForSelector('.result-view .g-row', { timeout: 20000 })
  const n = await win.locator('.result-view .g-row').first().locator('.g-cell').first().innerText()
  // SQL 덤프(orders) → 같은 DB에 다시 넣기 (설치본 안에서 파일 쓰기·읽기). 파일 창은 정해 둔 경로를 돌려주게
  const dumpFile = path.join(out, 'orders.sql')
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, dumpFile)
  const dumped = await win.evaluate(() => window.api.exportDump('00000000-0000-4000-8000-000000000001', 'smoke-dump', 'main', '', [{ name: 'orders', kind: 'table' }], { structure: true, data: true, drop: true, batch: 100 }, 'orders'))
  const text = fs.existsSync(dumpFile) ? fs.readFileSync(dumpFile, 'utf8') : ''
  const picked = await win.evaluate(() => window.api.pickSqlFile())
  const ran = await win.evaluate((f) => window.api.runSqlFile('00000000-0000-4000-8000-000000000001', 'smoke-file', 'main', '', f), picked)
  await win.locator('.tab-pane:visible .cm-content').click()
  await win.keyboard.press('Control+Enter')
  await win.waitForTimeout(800)
  const again = await win.locator('.result-view .g-row').first().locator('.g-cell').first().innerText()
  ok = n === '1200' && menus === 4 && dumped?.rows === 1200 && text.includes('INSERT INTO "orders"') && ran.statements > 10 && again === '1200'
  console.log('version:', await app.evaluate(({ app }) => app.getVersion()), '· packaged:', await app.evaluate(({ app }) => app.isPackaged), '· rows:', n,
    '· menus:', menus, '· dump rows:', dumped?.rows, '· restore statements:', ran.statements, '· rows after restore:', again)
  await win.screenshot({ path: path.join(out, 'installed.png') })
} catch (e) {
  console.error(e)
} finally {
  await app.close().catch(() => {})
}
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED', '→', out)
process.exit(ok ? 0 : 1)
