// Electron 메인 프로세스: 창, 화면과 주고받는 기능(IPC), 앱 설정, 파일 고르기·저장 창
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveLang, setLang, t } from '../shared/i18n'
import { isReadOnlyQuery } from '../shared/sql'
import { API_METHODS, dialectOf, type Api, type AppSettings, type ConnectionConfig, type SecretName, type SecretsInput } from '../shared/types'
import { Manager, type Resolved } from './conn'
import { setSqliteWorkerCode } from './drivers/sqlite'
import {
  allowFile, checkCell, checkChanges, checkConfig, checkCsvRead, checkCsvWrite, checkDataQuery, checkId, checkImport, checkInt,
  checkName, checkOneOf, checkPickedFile, checkRef, checkSecrets, checkSort, checkSql, checkTabKey, checkText, validateForConnect,
} from './guard'
import * as ops from './ops'
import { Store } from './store'
import { keyNeedsPassphrase } from './tunnel'
import * as updater from './updater'

const DEV_URL = process.env.VITE_DEV_SERVER_URL
let win: BrowserWindow | null = null

// 테스트(scripts/e2e.mjs)는 설정 폴더를 따로 써서 사용자의 접속 정보·설정을 건드리지 않는다
if (process.env.DBOARD_USER_DATA) app.setPath('userData', process.env.DBOARD_USER_DATA)
const FORCED_THEME = process.env.DBOARD_THEME === 'dark' || process.env.DBOARD_THEME === 'light' ? process.env.DBOARD_THEME : null

// 한 번에 하나만 켠다. 이미 켜져 있으면 그 창을 앞으로 가져오고 이 프로세스는 끝낸다.
// (둘이 같이 켜져 있으면 업데이트 설치가 막히고 접속 정보 파일을 서로 덮어쓴다. 잠금은 설정 폴더 기준)
const firstInstance = app.requestSingleInstanceLock()
if (!firstInstance) app.quit()
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

// Windows: DPAPI(현재 사용자 계정 키)로 암호화. 다른 사용자·PC에서는 풀 수 없다
const store = new Store(app.getPath('userData'), {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
  decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
})
const hostKeys = store.hostKeys()
const manager = new Manager(hostKeys)

// ───────── 앱 설정 ─────────

const DEFAULT_SETTINGS: AppSettings = { theme: 'system', language: 'auto', zoom: 0, autoUpdate: true, maxRows: 500, pageSize: 200, editorFontSize: 13, confirmDangerous: true }

function normalizeSettings(v: unknown): AppSettings {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const num = (x: unknown, min: number, max: number, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : d)
  return {
    theme: o.theme === 'light' || o.theme === 'dark' ? o.theme : 'system',
    language: o.language === 'ko' || o.language === 'en' ? o.language : 'auto',
    zoom: typeof o.zoom === 'number' && o.zoom >= 0.8 && o.zoom <= 1.75 ? Math.round(o.zoom * 100) / 100 : 0,
    autoUpdate: o.autoUpdate !== false,
    maxRows: num(o.maxRows, 10, 100_000, DEFAULT_SETTINGS.maxRows),
    pageSize: num(o.pageSize, 10, 10_000, DEFAULT_SETTINGS.pageSize),
    editorFontSize: num(o.editorFontSize, 10, 24, DEFAULT_SETTINGS.editorFontSize),
    confirmDangerous: o.confirmDangerous !== false,
  }
}

const readSettings = () => normalizeSettings(store.readJson('settings.json', DEFAULT_SETTINGS))

function applyTheme(s: AppSettings) {
  nativeTheme.themeSource = FORCED_THEME ?? s.theme
}

// ───────── 화면 배율 ─────────
// 자동: 화면은 1440px 너비 기준. 창을 키우면 늘어난 너비의 절반만큼만 키운다(1920px ≈ 115%, 최대 125%).

const BASE_WIDTH = 1440
const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75]
let zoomSetting = 0

const autoZoom = (width: number) => Math.min(1.25, Math.max(1, Math.round((1 + (width / BASE_WIDTH - 1) * 0.5) * 20) / 20))

function applyZoom() {
  if (!win || win.isDestroyed()) return
  const z = zoomSetting > 0 ? zoomSetting : autoZoom(win.getContentBounds().width)
  win.webContents.setZoomFactor(z)
  applyTitleBar(z)
}

// ───────── 제목 줄 ─────────
// 창 테두리 없이 화면이 제목 줄(메뉴)을 그리고, 오른쪽 최소화·최대화·닫기 단추만 Windows가 그린다.
// 색은 styles.css의 --chrome·--text-2와 같게, 높이는 .titlebar(36px) × 배율.

const TITLE_H = 36
const CHROME = { light: { color: '#e9ebef', symbolColor: '#3d4451' }, dark: { color: '#1a1b1e', symbolColor: '#c3c7ce' } }

function titleBarOverlay(zoom: number) {
  return { ...CHROME[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'], height: Math.round(TITLE_H * zoom) }
}

function applyTitleBar(zoom = win?.webContents.getZoomFactor() ?? 1) {
  if (!win || win.isDestroyed()) return
  try {
    win.setTitleBarOverlay(titleBarOverlay(zoom))
  } catch {
    // 지원하지 않는 환경
  }
}

function setZoom(z: number) {
  const next = normalizeSettings({ ...readSettings(), zoom: z })
  store.writeJson('settings.json', next)
  zoomSetting = next.zoom
  applyZoom()
}

function zoomStep(dir: 1 | -1) {
  if (!win) return
  const cur = win.webContents.getZoomFactor()
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > cur + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001) ?? ZOOM_STEPS[0]
  setZoom(next)
}

// ───────── 접속 ─────────

/** 저장된 비밀 값 + 이번에 물어본 값. 모자라면 need에 이름 */
function resolve(config: ConnectionConfig, saved: Partial<Record<SecretName, string>>, prompt: SecretsInput, strict: boolean): Resolved | { need: SecretName[] } {
  const need: SecretName[] = []
  const pick = (k: SecretName, required: boolean): string => {
    if (!required) return ''
    if (prompt[k] !== undefined) return prompt[k]!
    if (config.savePassword) return saved[k] ?? ''
    if (strict) need.push(k)
    return ''
  }
  const ssh = config.ssh.enabled && config.driver !== 'sqlite'
  const r: Resolved = {
    config,
    password: pick('password', config.driver !== 'sqlite'),
    sshPassword: pick('sshPassword', ssh && config.ssh.auth === 'password'),
    // 키 파일에 암호가 걸려 있을 때만 묻는다
    sshPassphrase: ssh && config.ssh.auth === 'key' && (prompt.sshPassphrase !== undefined || saved.sshPassphrase !== undefined || keyNeedsPassphrase(config.ssh.keyFile)) ? pick('sshPassphrase', true) : '',
  }
  return need.length ? { need } : r
}

function checkConnId(v: unknown): string {
  const id = checkId(v)
  if (!store.has(id)) throw new Error(t('접속 정보를 찾지 못했어요'))
  return id
}

const metaOpts = (id: string) => ({ showSystem: manager.get(id).config.showSystem })

async function saveAs(title: string, defaultName: string, filters: Electron.FileFilter[]): Promise<string | null> {
  const safe = defaultName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150) || 'export'
  const r = await dialog.showSaveDialog(win!, { title, defaultPath: path.join(app.getPath('downloads'), safe), filters })
  return r.canceled || !r.filePath ? null : r.filePath
}

const CSV_FILTER = [{ name: 'CSV', extensions: ['csv', 'txt', 'tsv'] }]

// ───────── IPC ─────────

type Handlers = { [K in keyof Api]: (...args: unknown[]) => ReturnType<Api[K]> }

const handlers: Handlers = {
  // 접속 정보
  listConnections: async () => store.list(),
  saveConnection: async (c, s) => {
    const config = checkConfig(c)
    if (!config.name) throw new Error(t('이름을 적어 주세요'))
    if (config.id && !store.has(config.id)) throw new Error(t('접속 정보를 찾지 못했어요'))
    const info = store.save(config, checkSecrets(s))
    // 고친 접속 정보는 다음 연결부터 쓰이게 끊는다
    if (manager.isConnected(info.id)) await manager.disconnect(info.id)
    return info
  },
  deleteConnection: async (id) => {
    const cid = checkConnId(id)
    await manager.disconnect(cid)
    store.remove(cid)
  },
  duplicateConnection: async (id) => store.duplicate(checkConnId(id), t(' (복사본)')),
  moveConnection: async (id, to) => store.move(checkConnId(id), checkInt(to, 0, 100_000)),
  testConnection: async (c, s) => {
    const config = checkConfig(c)
    validateForConnect(config)
    const saved = config.id && store.has(config.id) ? store.secrets(config.id) : {}
    // 시험에서는 비밀번호 저장을 꺼도 지금 입력한 값으로 해 본다
    const r = resolve({ ...config, savePassword: true }, config.savePassword ? saved : {}, checkSecrets(s), false) as Resolved
    r.config = config
    const tmp = new Manager(hostKeys)
    const t0 = performance.now()
    try {
      const live = await tmp.connect('test', r)
      return { version: live.version, ms: Math.round(performance.now() - t0) }
    } finally {
      await tmp.disconnectAll()
    }
  },
  connect: async (id, prompt) => {
    const cid = checkConnId(id)
    if (manager.isConnected(cid)) return { ok: true, version: manager.get(cid).version, newHostKey: null }
    const config = store.config(cid)
    validateForConnect(config)
    const r = resolve(config, store.secrets(cid), checkSecrets(prompt), true)
    if ('need' in r) return { ok: false, need: r.need }
    const live = await manager.connect(cid, r)
    const newHostKey = live.newHostKey
    live.newHostKey = null
    return { ok: true, version: live.version, newHostKey }
  },
  disconnect: async (id) => manager.disconnect(checkConnId(id)),
  connectedIds: async () => manager.connectedIds(),
  pickSqliteFile: async (mode) => {
    const m = checkOneOf(mode, ['open', 'create'] as const)
    const filters = [{ name: t('SQLite DB'), extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }, { name: t('모든 파일'), extensions: ['*'] }]
    if (m === 'open') {
      const r = await dialog.showOpenDialog(win!, { title: t('SQLite 파일 열기'), properties: ['openFile'], filters })
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
    }
    const r = await dialog.showSaveDialog(win!, { title: t('새 SQLite 파일 만들기'), defaultPath: path.join(app.getPath('documents'), 'new.db'), filters })
    if (r.canceled || !r.filePath) return null
    if (!fs.existsSync(r.filePath)) new DatabaseSync(r.filePath).close()
    return r.filePath
  },
  pickKeyFile: async () => {
    const dir = path.join(os.homedir(), '.ssh')
    const r = await dialog.showOpenDialog(win!, { title: t('SSH 개인 키 고르기'), defaultPath: fs.existsSync(dir) ? dir : os.homedir(), properties: ['openFile', 'showHiddenFiles'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  },
  forgetHostKey: async (host, port) => hostKeys.forget(`${checkText(host, 255)}:${checkInt(port, 1, 65535)}`),

  // 탐색기
  databases: async (id) => {
    const cid = checkConnId(id)
    const live = manager.get(cid)
    const r = await live.mod.databases(await live.metaSession(), metaOpts(cid))
    // 접속 정보에 적은 DB는 시스템 DB(master 등)라도 보이게
    const own = live.config.database
    if (own && !r.databases.includes(own)) r.databases.unshift(own)
    return r
  },
  schemas: async (id, db) => {
    const cid = checkConnId(id)
    const live = manager.get(cid)
    const d = checkName(db)
    return live.mod.schemas(await live.metaSession(d), d, metaOpts(cid))
  },
  objects: async (id, db, schema) => {
    const cid = checkConnId(id)
    const live = manager.get(cid)
    const d = checkName(db)
    return live.mod.objects(await live.metaSession(d), d, checkName(schema), metaOpts(cid))
  },
  columns: async (id, ref) => {
    const live = manager.get(checkConnId(id))
    const r = checkRef(ref)
    return live.mod.columns(await live.metaSession(r.db), r)
  },
  indexes: async (id, ref) => {
    const live = manager.get(checkConnId(id))
    const r = checkRef(ref)
    return live.mod.indexes(await live.metaSession(r.db), r)
  },
  ddl: async (id, ref, kind) => {
    const live = manager.get(checkConnId(id))
    const r = checkRef(ref)
    return live.mod.ddl(await live.metaSession(r.db), r, checkOneOf(kind, ['table', 'view'] as const))
  },
  completion: async (id, db, schema) => {
    const live = manager.get(checkConnId(id))
    const d = checkName(db)
    return live.mod.completion(await live.metaSession(d), d, checkName(schema))
  },

  // SQL 편집기
  runSql: async (id, tabKey, db, schema, sql, maxRows) => {
    const cid = checkConnId(id)
    const live = manager.get(cid)
    const text = checkSql(sql)
    const d = checkName(db)
    const s = await manager.editorSession(cid, checkTabKey(tabKey), d, checkName(schema))
    const t0 = performance.now()
    const base = { at: Date.now(), connId: cid, connName: live.config.name, db: d || live.defaultDb, sql: text }
    try {
      const res = await s.run(text, checkInt(maxRows, 1, 1_000_000))
      const rows = res.reduce<number | null>((n, r) => (r.columns ? (n ?? 0) + r.rows.length : r.affected !== null ? (n ?? 0) + r.affected : n), null)
      store.addHistory({ ...base, ms: Math.round(performance.now() - t0), rows, error: null })
      return res
    } catch (e) {
      store.addHistory({ ...base, ms: Math.round(performance.now() - t0), rows: null, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  },
  cancelSql: async (tabKey) => manager.cancel(checkTabKey(tabKey)),
  closeSession: async (tabKey) => manager.closeEditor(checkTabKey(tabKey)),
  history: async (search, limit) => store.history(checkText(search ?? '', 1000), checkInt(limit, 1, 1000)),
  clearHistory: async () => store.clearHistory(),

  // 표 데이터
  tableData: async (id, ref, q) => ops.tableData(manager.get(checkConnId(id)), checkRef(ref), checkDataQuery(q)),
  countRows: async (id, ref, filter) => ops.countRows(manager.get(checkConnId(id)), checkRef(ref), checkText(filter ?? '', 100_000)),
  applyChanges: async (id, ref, changes) => ops.applyChanges(manager.get(checkConnId(id)), checkRef(ref), checkChanges(changes)),

  // CSV
  saveCsv: async (name, columns, rows, o) => {
    if (!Array.isArray(columns) || !Array.isArray(rows) || rows.length > 2_000_000) throw new Error(t('잘못된 요청'))
    const cols = columns.map((c) => checkText(c, 1000))
    const opts = checkCsvWrite(o)
    const data = rows.map((r) => {
      if (!Array.isArray(r)) throw new Error(t('잘못된 요청'))
      return r.map(checkCell)
    })
    const file = await saveAs(t('CSV로 저장'), checkText(name, 200) + '.csv', CSV_FILTER)
    if (!file) return null
    return { path: file, rows: await ops.saveRowsCsv(file, cols, data, opts) }
  },
  exportQueryCsv: async (id, tabKey, db, schema, sql, o, name) => {
    const cid = checkConnId(id)
    const text = checkSql(sql)
    const live = manager.get(cid)
    // 다시 실행해서 전부 받으므로 읽기만 하는 문장만
    if (!isReadOnlyQuery(text, dialectOf(live.config.driver))) throw new Error(t('SELECT처럼 읽기만 하는 문장만 다시 실행해서 내보낼 수 있어요'))
    const opts = checkCsvWrite(o)
    const file = await saveAs(t('CSV로 내보내기'), checkText(name, 200) + '.csv', CSV_FILTER)
    if (!file) return null
    const s = await manager.editorSession(cid, checkTabKey(tabKey), checkName(db), checkName(schema))
    return { path: file, rows: await ops.exportSql(s, text, file, opts) }
  },
  exportTableCsv: async (id, ref, filter, order, o) => {
    const live = manager.get(checkConnId(id))
    const r = checkRef(ref)
    const opts = checkCsvWrite(o)
    const file = await saveAs(t('CSV로 내보내기'), r.table + '.csv', CSV_FILTER)
    if (!file) return null
    return { path: file, rows: await ops.exportTable(live, r, checkText(filter ?? '', 100_000), checkSort(order ?? []), file, opts) }
  },
  pickCsv: async () => {
    const r = await dialog.showOpenDialog(win!, { title: t('CSV 파일 고르기'), properties: ['openFile'], filters: [...CSV_FILTER, { name: t('모든 파일'), extensions: ['*'] }] })
    if (r.canceled || r.filePaths.length === 0) return null
    allowFile(r.filePaths[0])
    return r.filePaths[0]
  },
  previewCsv: async (file, o) => {
    const f = checkPickedFile(file)
    return ops.previewCsv(f, checkCsvRead(o), path.basename(f))
  },
  importCsv: async (id, ref, file, o) => ops.importCsv(manager.get(checkConnId(id)), checkRef(ref), checkPickedFile(file), checkImport(o)),

  // 앱
  settings: async () => readSettings(),
  saveSettings: async (s) => {
    const next = normalizeSettings(s)
    store.writeJson('settings.json', next)
    applyTheme(next)
    setLang(resolveLang(next.language, app.getLocale()))
    zoomSetting = next.zoom
    applyZoom()
    updater.settingsChanged()
    return next
  },
  appInfo: async () => ({ version: app.getVersion(), secureStorage: safeStorage.isEncryptionAvailable() }),
  copyText: async (text) => clipboard.writeText(checkText(text, 200_000_000)),
  updateStatus: async () => updater.getStatus(),
  checkForUpdates: async () => updater.check(),
  installUpdate: async () => updater.install(),
  openUrl: async (url) => {
    if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url) || url.length > 4000) throw new Error(t('열 수 없는 주소'))
    await shell.openExternal(url)
  },
}

/** 우리 화면에서 온 요청인지 확인 (다른 페이지가 실수로 열려도 기능을 못 쓰게) */
function fromApp(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  return DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://')
}

/** 채널 이름 = 메서드 이름. 오류는 메시지만 깔끔하게 화면으로 ({ok:false, error}) */
function registerIpc() {
  for (const name of API_METHODS) {
    const fn = handlers[name] as (...args: unknown[]) => Promise<unknown>
    ipcMain.handle(name, async (e, ...args) => {
      if (!fromApp(e)) return { ok: false, error: t('허용되지 않은 요청') }
      try {
        return { ok: true, data: await fn(...args) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  }
}

// ───────── 창 ─────────

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'DBoard',
    ...(!app.isPackaged && fs.existsSync(path.join(app.getAppPath(), 'build', 'icon.png')) ? { icon: path.join(app.getAppPath(), 'build', 'icon.png') } : {}),
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(1),
    backgroundColor: titleBarOverlay(1).color,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
  const themeChanged = () => {
    applyTitleBar()
    win?.setBackgroundColor(titleBarOverlay(1).color)
  }
  nativeTheme.on('updated', themeChanged)
  win.on('closed', () => nativeTheme.off('updated', themeChanged))

  let timer: NodeJS.Timeout | undefined
  win.on('resize', () => {
    clearTimeout(timer)
    timer = setTimeout(applyZoom, 60)
  })
  win.webContents.on('did-finish-load', applyZoom)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
    if (input.key === '=' || input.key === '+') zoomStep(1)
    else if (input.key === '-' || input.key === '_') zoomStep(-1)
    else if (input.key === '0') setZoom(0)
    else return
    e.preventDefault()
  })

  // 앱 화면 밖으로 이동 금지, 외부 링크(http/https)는 기본 브라우저로
  win.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL ? !url.startsWith(DEV_URL) : !url.startsWith('file://')) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  if (!firstInstance) return
  const s = readSettings()
  setLang(resolveLang(s.language, app.getLocale()))
  applyTheme(s)
  zoomSetting = s.zoom
  // SQLite는 작업 스레드에서 (오래 걸리는 쿼리가 창을 멈추지 않게)
  try {
    setSqliteWorkerCode(fs.readFileSync(path.join(__dirname, 'sqlite-worker.cjs'), 'utf8'))
  } catch {
    setSqliteWorkerCode(null)
  }
  // 기본 메뉴를 없앤다: 메뉴의 단축키(Ctrl+C 복사, Ctrl+W 창 닫기 등)가 화면보다 먼저 키를 가로채서
  // 결과 표 복사·탭 닫기가 안 됐다. 글 칸의 복사·붙여 넣기는 Windows에서 메뉴 없이도 된다.
  Menu.setApplicationMenu(null)
  registerIpc()
  createWindow()
  updater.initUpdater(() => readSettings())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  // 열린 연결을 닫고 끝낸다 (오래 걸리면 2초 뒤 그냥 끝냄)
  void Promise.race([manager.disconnectAll(), new Promise((r) => setTimeout(r, 2000))]).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
