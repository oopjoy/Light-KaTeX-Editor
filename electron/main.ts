import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  WebContentsView,
  type IpcMainInvokeEvent
} from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import markdownExtensionConfig from '../config/markdown-extensions.json'
import { atomicWriteUtf8 } from './atomic-file'
import { documentLinkTarget } from './link-target'
import type {
  AppConfig,
  OpenFileResult,
  PreviewAppearance,
  PreviewBounds,
  PreviewHtmlExportResult,
  PreviewRenderComplete,
  PreviewRenderRequest,
  SaveFileResult
} from '../src/shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.env.LIGHT_EDITOR_DEV === '1'
const CONFIG_FILE = 'config.json'
const CUSTOM_PREVIEW_CSS_FILE = 'custom-preview.css'
const DEFAULT_CUSTOM_PREVIEW_CSS = `/* Light KaTeX Editor — user preview overrides\n * Save this file and the right preview refreshes automatically.\n * Examples:\n *\n * .preview-root h2 { margin-top: 2.4em; color: #0f766e; }\n * .preview-root .katex-display { font-size: 1.08em; }\n */\n`
const MARKDOWN_EXTENSION_NAMES = [...markdownExtensionConfig.extensions]
const MARKDOWN_EXTS = new Set(MARKDOWN_EXTENSION_NAMES.map((extension) => `.${extension.toLowerCase()}`))
const MARKDOWN_FILTER = { name: 'Markdown', extensions: MARKDOWN_EXTENSION_NAMES }
const OLD_PREVIEW_FONT =
  '"Segoe UI", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
const DEFAULT_PREVIEW_FONT =
  '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif'

const defaultConfig: AppConfig = {
  recentFiles: [],
  windowBounds: {
    width: 1160,
    height: 760,
    x: undefined,
    y: undefined
  },
  splitRatio: 0.5,
  theme: 'light',
  fontSize: 15,
  editorFontSize: 15,
  previewFontSize: 16,
  editorFontFamily:
    'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
  previewFontFamily: DEFAULT_PREVIEW_FONT,
  editorLineHeight: 1.55,
  sourceColoring: true,
  previewLineHeight: 1.7,
  previewMaxWidth: 0,
  linkFontSizes: true,
  liveMathCheck: false,
  autoSave: false
}

interface RecoverySnapshot {
  path: string
  content: string
  lineEnding: 'lf' | 'crlf'
  sourceMtimeMs: number
  updatedAt: number
}

interface WindowState {
  documentOperations: Promise<void>
  recoveryEpoch: number
  win: BrowserWindow
  filePath: string | null
  pendingOpenPath: string | null
  watcher: FSWatcher | null
  ignoreExternalUntil: number
  /** When true, the next close proceeds without unsaved-change prompt. */
  allowClose: boolean
  /** Renderer-reported dirty flag (source of truth for close gate). */
  dirty: boolean
  /** Prevent re-entrant close prompts. */
  closePromptOpen: boolean
  /** Right pane: independent renderer for Markdown/KaTeX/DOM diff work. */
  previewView: WebContentsView
  previewReady: boolean
  previewBounds: PreviewBounds | null
  latestPreviewRender: PreviewRenderRequest | null
  latestPreviewAppearance: PreviewAppearance | null
  /** A main-renderer modal is above Preview; native View must stay hidden. */
  previewOverlayOpen: boolean
  /** Waiting static HTML export requests keyed by preview-local request ID. */
  pendingHtmlExports: Map<number, {
    resolve: (html: string) => void
    timer: NodeJS.Timeout
  }>
  nextHtmlExportRequestId: number
  /** Debounces move/resize persistence without waiting for window close. */
  boundsSaveTimer: NodeJS.Timeout | null
}

/** Serialize config read-modify-write operations so independent settings and
 * bounds writes cannot overwrite one another with stale snapshots. */
let configWriteQueue: Promise<void> = Promise.resolve()
let customPreviewCssWatcher: FSWatcher | null = null
let selectedViewMode: 'editor' | 'split' | 'preview' = 'split'

const windows = new Map<number, WindowState>()

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE)
}

function customPreviewCssPath(): string {
  return path.join(app.getPath('userData'), CUSTOM_PREVIEW_CSS_FILE)
}

function recoveryDirectory(): string {
  return path.join(app.getPath('userData'), 'recovery')
}

function recoveryPath(filePath: string): string {
  const normalized = path.normalize(filePath).toLowerCase()
  const key = createHash('sha256').update(normalized, 'utf8').digest('hex')
  return path.join(recoveryDirectory(), `${key}.json`)
}

async function readRecoverySnapshot(filePath: string): Promise<RecoverySnapshot | null> {
  try {
    const raw = await fs.readFile(recoveryPath(filePath), 'utf8')
    const snapshot = JSON.parse(raw) as RecoverySnapshot
    if (
      snapshot.path !== filePath || typeof snapshot.content !== 'string' ||
      (snapshot.lineEnding !== 'lf' && snapshot.lineEnding !== 'crlf')
    ) return null
    return snapshot
  } catch {
    return null
  }
}

async function writeRecoverySnapshot(
  filePath: string,
  content: string,
  lineEnding: 'lf' | 'crlf',
  sourceMtimeMs: number
): Promise<void> {
  const snapshot: RecoverySnapshot = {
    path: filePath,
    content,
    lineEnding,
    sourceMtimeMs,
    updatedAt: Date.now()
  }
  await atomicWriteUtf8(recoveryPath(filePath), JSON.stringify(snapshot))
}

async function clearRecoverySnapshot(filePath: string): Promise<void> {
  await fs.rm(recoveryPath(filePath), { force: true })
}

/** Keep snapshot commits, saves and cleanup in document order, even on slow disks. */
function queueDocumentOperation<T>(state: WindowState, operation: () => Promise<T>): Promise<T> {
  const task = state.documentOperations.then(operation)
  state.documentOperations = task.then(() => undefined, () => undefined)
  return task
}

function clearWindowRecovery(state: WindowState): Promise<void> {
  const filePath = state.filePath
  state.recoveryEpoch += 1
  return queueDocumentOperation(state, async () => {
    if (filePath) await clearRecoverySnapshot(filePath)
  })
}

async function offerRecovery(
  state: WindowState,
  disk: OpenFileResult
): Promise<OpenFileResult> {
  const snapshot = await readRecoverySnapshot(disk.path)
  if (!snapshot || snapshot.content === disk.content) {
    if (snapshot) await clearRecoverySnapshot(disk.path)
    return disk
  }

  const result = await dialog.showMessageBox(state.win, {
    type: 'warning',
    title: '发现恢复快照',
    message: `发现「${path.basename(disk.path)}」上次未正常关闭时的恢复内容。`,
    detail: '恢复快照不会自动覆盖磁盘文件；恢复后请确认内容并手动保存。',
    buttons: ['恢复编辑内容', '使用磁盘版本'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (result.response !== 0) {
    await clearRecoverySnapshot(disk.path)
    return disk
  }
  return {
    ...disk,
    content: snapshot.content,
    lineEnding: snapshot.lineEnding,
    recovered: true,
    savedContent: disk.content
  }
}

async function readCustomPreviewCss(): Promise<string> {
  try {
    return await fs.readFile(customPreviewCssPath(), 'utf8')
  } catch {
    return ''
  }
}

function broadcastCustomPreviewCss(css: string): void {
  for (const state of windows.values()) {
    if (state.previewReady && !state.previewView.webContents.isDestroyed()) {
      state.previewView.webContents.send('preview:custom-css', css)
    }
  }
}

function ensureCustomPreviewCssWatcher(): void {
  if (customPreviewCssWatcher) return
  const filePath = customPreviewCssPath()
  customPreviewCssWatcher = chokidar.watch(filePath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 }
  })
  const refresh = () => {
    void readCustomPreviewCss().then(broadcastCustomPreviewCss)
  }
  customPreviewCssWatcher.on('add', refresh)
  customPreviewCssWatcher.on('change', refresh)
  customPreviewCssWatcher.on('unlink', () => broadcastCustomPreviewCss(''))
}

function normalizeAppConfig(raw: Partial<AppConfig> & Record<string, unknown>): AppConfig {
  const merged = { ...defaultConfig, ...raw } as AppConfig
  const editorSize =
    typeof raw.editorFontSize === 'number'
      ? raw.editorFontSize
      : typeof raw.fontSize === 'number'
        ? raw.fontSize
        : defaultConfig.editorFontSize
  return {
    ...merged,
    fontSize: editorSize,
    editorFontSize: editorSize,
    previewFontSize:
      typeof raw.previewFontSize === 'number' ? raw.previewFontSize : merged.previewFontSize,
    editorLineHeight: Number(merged.editorLineHeight) || defaultConfig.editorLineHeight,
    sourceColoring: merged.sourceColoring !== false,
    previewLineHeight: Number(merged.previewLineHeight) || defaultConfig.previewLineHeight,
    // Retire saved reading-width caps, including configs from older releases.
    previewMaxWidth: 0,
    linkFontSizes: merged.linkFontSizes !== false,
    // Opt-in: continuous full-document KaTeX validation is expensive for notes
    // containing thousands of formulas.
    liveMathCheck: merged.liveMathCheck === true,
    editorFontFamily: (() => {
      const fam = String(merged.editorFontFamily || defaultConfig.editorFontFamily)
      // Migrate away from Maple Mono NF (Nerd Font / icon face).
      if (/maple\s*mono/i.test(fam)) return defaultConfig.editorFontFamily
      return fam
    })(),
    previewFontFamily: (() => {
      const family = String(merged.previewFontFamily || defaultConfig.previewFontFamily)
      // Migrate only the former default; never overwrite a custom selection.
      return family === OLD_PREVIEW_FONT ? DEFAULT_PREVIEW_FONT : family
    })(),
    theme: merged.theme === 'dark' ? 'dark' : 'light',
    recentFiles: Array.isArray(merged.recentFiles) ? merged.recentFiles : [],
    windowBounds: {
      ...defaultConfig.windowBounds,
      ...(merged.windowBounds ?? {})
    }
  }
}

async function readConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8')
    return normalizeAppConfig(JSON.parse(raw) as Partial<AppConfig>)
  } catch {
    return { ...defaultConfig }
  }
}

function writeConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  const task = configWriteQueue.then(async () => {
    const current = await readConfig()
    const next = normalizeAppConfig({
      ...current,
      ...partial,
      windowBounds: {
        ...current.windowBounds,
        ...(partial.windowBounds ?? {})
      },
      recentFiles: partial.recentFiles ?? current.recentFiles
    })
    await fs.mkdir(path.dirname(configPath()), { recursive: true })
    await atomicWriteUtf8(configPath(), JSON.stringify(next, null, 2))
    if (partial.theme) syncThemeMenu(next.theme)
    return next
  })
  // Keep later writes usable even if one disk write fails; the caller still
  // receives the original rejection and can handle/report it where relevant.
  configWriteQueue = task.then(() => undefined, () => undefined)
  return task
}

function syncViewMenu(mode: 'editor' | 'split' | 'preview'): void {
  selectedViewMode = mode
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  for (const [id, value] of [['view-editor', 'editor'], ['view-split', 'split'], ['view-preview', 'preview']] as const) {
    const item = menu.getMenuItemById(id)
    if (item) item.label = `${value === 'editor' ? '源码' : value === 'split' ? '分栏' : '预览'}    ${'\u3000'.repeat(7)}${value === mode ? '✓' : ''}`
  }
}

function syncThemeMenu(theme: 'light' | 'dark'): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const light = menu.getMenuItemById('theme-light')
  const dark = menu.getMenuItemById('theme-dark')
  if (light) light.checked = theme === 'light'
  if (dark) dark.checked = theme === 'dark'
}

function detectLineEnding(content: string): 'lf' | 'crlf' {
  return content.includes('\r\n') ? 'crlf' : 'lf'
}

function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTS.has(path.extname(filePath).toLowerCase())
}

function collectMarkdownArgs(argv: string[]): string[] {
  const out: string[] = []
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue
    if (arg === '.' || arg === process.cwd()) continue
    // Skip the project/app entry itself when launched as `electron .`
    if (path.resolve(arg) === path.resolve(process.cwd()) && !isMarkdownPath(arg)) continue
    try {
      const resolved = path.resolve(arg)
      if (isMarkdownPath(resolved)) out.push(resolved)
    } catch {
      // ignore invalid args
    }
  }
  // de-dupe while preserving order
  return [...new Set(out)]
}

async function pushRecent(filePath: string): Promise<void> {
  const config = await readConfig()
  const recentFiles = [filePath, ...config.recentFiles.filter((item) => item !== filePath)].slice(
    0,
    10
  )
  await writeConfig({ recentFiles })
  // Refresh File → 最近打开 without blocking open path.
  void rebuildMenu()
}

function getStateFromEvent(event: IpcMainInvokeEvent): WindowState | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return null
  return windows.get(win.id) ?? null
}

function getState(win: BrowserWindow): WindowState | null {
  return windows.get(win.id) ?? null
}

async function openDocumentLink(win: BrowserWindow, href: unknown): Promise<void> {
  try {
    const target = documentLinkTarget(href)
    if (target.kind === 'external') {
      await shell.openExternal(target.url)
      return
    }
    if (target.needsConfirmation) {
      const answer = await dialog.showMessageBox(win, {
        type: 'warning', title: '打开本地文件',
        message: '此链接可能启动程序或脚本，是否继续？', detail: target.path,
        buttons: ['取消', '使用默认程序打开'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (answer.response !== 1) return
    }
    const error = await shell.openPath(target.path)
    if (error) throw new Error(error)
  } catch (error) {
    if (win.isDestroyed()) return
    await dialog.showMessageBox(win, {
      type: 'error', title: '无法打开链接', message: '无法使用默认程序打开此链接。',
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}

function getStateFromPreviewSender(sender: Electron.WebContents): WindowState | null {
  for (const state of windows.values()) {
    if (state.previewView.webContents === sender) return state
  }
  return null
}

function persistWindowBounds(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return Promise.resolve()
  const bounds = win.getBounds()
  return writeConfig({
    windowBounds: {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y
    }
  }).then(() => undefined)
}

function scheduleWindowBoundsPersist(state: WindowState): void {
  if (state.boundsSaveTimer !== null) clearTimeout(state.boundsSaveTimer)
  state.boundsSaveTimer = setTimeout(() => {
    state.boundsSaveTimer = null
    void persistWindowBounds(state.win).catch((error) => {
      console.error('Failed to persist window bounds', error)
    })
  }, 350)
}

async function flushWindowBoundsPersist(state: WindowState): Promise<void> {
  if (state.boundsSaveTimer !== null) {
    clearTimeout(state.boundsSaveTimer)
    state.boundsSaveTimer = null
  }
  try {
    await persistWindowBounds(state.win)
  } catch (error) {
    // Bounds persistence must never prevent a requested close.
    console.error('Failed to persist final window bounds', error)
  }
}

/** View zoom as percentage (50%–300%, step 10%). */
function zoomPercentOf(win: BrowserWindow): number {
  if (win.isDestroyed()) return 100
  return Math.round(win.webContents.getZoomFactor() * 100)
}

function applyZoom(win: BrowserWindow, action: 'in' | 'out' | 'reset' | 'get'): number {
  if (win.isDestroyed()) return 100
  let factor = win.webContents.getZoomFactor()
  if (action === 'in') {
    factor = Math.min(3, Math.round((factor + 0.1) * 10) / 10)
  } else if (action === 'out') {
    factor = Math.max(0.5, Math.round((factor - 0.1) * 10) / 10)
  } else if (action === 'reset') {
    factor = 1
  }
  win.webContents.setZoomFactor(factor)
  const state = getState(win)
  if (state && !state.previewView.webContents.isDestroyed()) {
    state.previewView.webContents.setZoomFactor(factor)
  }
  const percent = Math.round(factor * 100)
  if (!win.webContents.isDestroyed()) {
    win.webContents.send('window:zoom-changed', percent)
  }
  return percent
}

function stopWatcher(state: WindowState): void {
  if (state.watcher) {
    void state.watcher.close()
    state.watcher = null
  }
}

function watchFile(state: WindowState, filePath: string): void {
  stopWatcher(state)
  state.watcher = chokidar.watch(filePath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50
    }
  })
  state.watcher.on('change', () => {
    if (Date.now() < state.ignoreExternalUntil) return
    state.win.webContents.send('file:external-change', filePath)
  })
  state.watcher.on('unlink', () => {
    if (Date.now() < state.ignoreExternalUntil) return
    state.win.webContents.send('file:external-change', filePath)
  })
}

function markOwnWrite(state: WindowState): void {
  state.ignoreExternalUntil = Date.now() + 800
}

function cascadeOffset(base: { x?: number; y?: number }): { x?: number; y?: number } {
  const count = windows.size
  if (base.x === undefined || base.y === undefined) return { x: base.x, y: base.y }
  return {
    x: base.x + (count % 8) * 28,
    y: base.y + (count % 8) * 28
  }
}

async function readOpenResult(filePath: string): Promise<OpenFileResult> {
  const content = await fs.readFile(filePath, 'utf8')
  const stat = await fs.stat(filePath)
  await pushRecent(filePath)
  return {
    path: filePath,
    content,
    encoding: 'utf-8',
    lineEnding: detectLineEnding(content),
    mtimeMs: stat.mtimeMs
  }
}

async function bindPathToWindow(
  state: WindowState,
  filePath: string,
  checkRecovery = true
): Promise<OpenFileResult> {
  const disk = await readOpenResult(filePath)
  const result = checkRecovery ? await offerRecovery(state, disk) : disk
  state.filePath = filePath
  state.pendingOpenPath = null
  watchFile(state, filePath)
  return result
}

function findWindowByPath(filePath: string): BrowserWindow | null {
  const normalized = path.normalize(filePath).toLowerCase()
  for (const state of windows.values()) {
    if (state.filePath && path.normalize(state.filePath).toLowerCase() === normalized) {
      return state.win
    }
    if (state.pendingOpenPath && path.normalize(state.pendingOpenPath).toLowerCase() === normalized) {
      return state.win
    }
  }
  return null
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function sendPreviewState(state: WindowState): void {
  if (!state.previewReady || state.previewView.webContents.isDestroyed()) return
  if (state.latestPreviewAppearance) {
    state.previewView.webContents.send('preview:appearance', state.latestPreviewAppearance)
  }
  if (state.latestPreviewRender) {
    state.previewView.webContents.send('preview:render', state.latestPreviewRender)
  }
  void readCustomPreviewCss().then((css) => {
    if (!state.previewView.webContents.isDestroyed()) {
      state.previewView.webContents.send('preview:custom-css', css)
    }
  })
  if (state.previewBounds && !state.previewOverlayOpen) state.previewView.setVisible(true)
}

function previewPageUrl(): string {
  return 'http://127.0.0.1:5173/preview.html'
}

// Chromium's printToPDF custom margins are interpreted as inches at runtime
// (despite Electron's legacy TypeScript comment saying pixels).
const PDF_MARGIN_TOP_BOTTOM_IN = 20 / 25.4
const PDF_MARGIN_LEFT_RIGHT_IN = 14 / 25.4
const PDF_PRINT_CSS = `
@media print {
  html, body { background: #fff !important; color: #000 !important; }
  .preview-root {
    background: #fff !important;
    color: #000 !important;
    font-size: 14px !important;
    line-height: 1.4 !important;
  }
}
`

/**
 * Static export inlines the Preview CSS, whose KaTeX @font-face declarations
 * refer to sibling font files. Copy only those referenced WOFF2 files next to
 * the HTML and rewrite URLs, so the exported document works outside the app.
 */
async function prepareHtmlExport(html: string, targetPath: string): Promise<string> {
  const fontNames = [...html.matchAll(/url\((['"]?)\.\/(KaTeX[^)'"\s]+\.woff2)\1\)/g)]
    .map((match) => match[2])
  if (fontNames.length === 0) return html

  const uniqueNames = [...new Set(fontNames)]
  const assetsDirName = `${path.basename(targetPath, path.extname(targetPath))}_assets`
  const assetsDir = path.join(path.dirname(targetPath), assetsDirName)
  const bundledAssetsDir = path.join(__dirname, '../dist/assets')
  const copied = new Set<string>()
  await fs.mkdir(assetsDir, { recursive: true })

  for (const name of uniqueNames) {
    try {
      await fs.copyFile(path.join(bundledAssetsDir, name), path.join(assetsDir, name))
      copied.add(name)
    } catch {
      // Leave a URL untouched if a future bundle changes an asset name. The
      // browser can still use its normal mathematical font fallback.
    }
  }

  return html.replace(/url\((['"]?)\.\/(KaTeX[^)'"\s]+\.woff2)\1\)/g, (full, quote, name) => {
    if (!copied.has(name)) return full
    return `url(${quote}./${assetsDirName}/${name}${quote})`
  })
}

async function requestPreviewHtml(
  state: WindowState,
  source: string,
  baseDir: string | null,
  suggestedName: string
): Promise<string> {
  if (!state.previewReady || state.previewView.webContents.isDestroyed()) {
    throw new Error('预览尚未准备好，无法导出')
  }
  const requestId = state.nextHtmlExportRequestId++
  const html = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      state.pendingHtmlExports.delete(requestId)
      resolve('')
    }, 20_000)
    state.pendingHtmlExports.set(requestId, { resolve, timer })
    state.previewView.webContents.send('preview:export-html', {
      requestId,
      source,
      baseDir,
      title: path.basename(suggestedName, path.extname(suggestedName)) || 'Light KaTeX Editor Export'
    })
  })
  if (!html) throw new Error('HTML 渲染超时或失败')
  return html
}

async function printHtmlToA4Pdf(html: string, targetPath: string): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'light-katex-editor-pdf-'))
  const tempHtmlPath = path.join(tempDir, 'document.html')
  let printWindow: BrowserWindow | null = null
  try {
    const printableHtml = await prepareHtmlExport(
      html.replace('</head>', `<style>${PDF_PRINT_CSS}</style></head>`),
      tempHtmlPath
    )
    await fs.writeFile(tempHtmlPath, printableHtml, 'utf8')

    printWindow = new BrowserWindow({
      show: false,
      width: 1024,
      height: 900,
      backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    await printWindow.loadFile(tempHtmlPath)
    await printWindow.webContents.executeJavaScript(`
      Promise.all([
        document.fonts ? document.fonts.ready : Promise.resolve(),
        ...Array.from(document.images, (image) => image.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              image.addEventListener('load', resolve, { once: true })
              image.addEventListener('error', resolve, { once: true })
            }))
      ])
    `, true)

    const pdf = await printWindow.webContents.printToPDF({
      landscape: false,
      pageSize: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      margins: {
        marginType: 'custom',
        top: PDF_MARGIN_TOP_BOTTOM_IN,
        bottom: PDF_MARGIN_TOP_BOTTOM_IN,
        left: PDF_MARGIN_LEFT_RIGHT_IN,
        right: PDF_MARGIN_LEFT_RIGHT_IN
      },
      // Chromium otherwise fills an omitted header template with its default
      // date and document title. Keep it explicitly blank while retaining the
      // centered page-number footer.
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="width:100%; text-align:center; font-size:14px; color:#333; transform:translateY(-2mm);"><span class="pageNumber"></span></div>'
    })
    await fs.writeFile(targetPath, pdf)
  } finally {
    if (printWindow && !printWindow.isDestroyed()) printWindow.destroy()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

async function createWindow(options: {
  config?: AppConfig
  openFilePath?: string | null
} = {}): Promise<BrowserWindow> {
  const config = options.config ?? (await readConfig())
  const offset = cascadeOffset(config.windowBounds)

  // Prefer multi-size ICO so Windows title bar / taskbar pick a crisp size.
  const iconCandidates = [
    path.join(process.resourcesPath, 'app.ico'),
    path.join(__dirname, '../build/icon.ico'),
    path.join(__dirname, '../launcher/app.ico')
  ]
  const iconPath = iconCandidates.find((p) => fsSync.existsSync(p))
  const appIcon = iconPath ? nativeImage.createFromPath(iconPath) : undefined
  const isDark = config.theme === 'dark'
  const win = new BrowserWindow({
    width: config.windowBounds.width,
    height: config.windowBounds.height,
    x: offset.x,
    y: offset.y,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: isDark ? '#0d1117' : '#f5f6f8',
    // Custom title bar: icon + path + menus in one row; Windows keeps native caption buttons.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: isDark ? '#161b22' : '#f6f8fa',
      symbolColor: isDark ? '#e6edf3' : '#1f2328',
      height: 36
    },
    autoHideMenuBar: true,
    ...(appIcon && !appIcon.isEmpty() ? { icon: appIcon } : iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  if (appIcon && !appIcon.isEmpty()) win.setIcon(appIcon)
  // Keep accelerators from application menu, but hide the native second menu row.
  win.setMenuBarVisibility(false)

  // Esc exits fullscreen (F11 / 查看→全屏 still enter it).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && win.isFullScreen()) {
      win.setFullScreen(false)
      event.preventDefault()
    }
  })

  const previewView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  previewView.setBackgroundColor(isDark ? '#0d1117' : '#ffffff')
  previewView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  previewView.setVisible(false)
  win.contentView.addChildView(previewView)

  const state: WindowState = {
    documentOperations: Promise.resolve(),
    recoveryEpoch: 0,
    win,
    filePath: null,
    pendingOpenPath: options.openFilePath ?? null,
    watcher: null,
    ignoreExternalUntil: 0,
    allowClose: false,
    dirty: false,
    closePromptOpen: false,
    previewView,
    previewReady: false,
    previewBounds: null,
    latestPreviewRender: null,
    latestPreviewAppearance: null,
    previewOverlayOpen: false,
    pendingHtmlExports: new Map(),
    nextHtmlExportRequestId: 1,
    boundsSaveTimer: null
  }
  windows.set(win.id, state)
  // Persist during normal interaction as well as during shutdown. This avoids
  // losing the last resize when Electron exits before a close-time async write.
  win.on('resize', () => scheduleWindowBoundsPersist(state))
  win.on('move', () => scheduleWindowBoundsPersist(state))

  previewView.webContents.setWindowOpenHandler(({ url }) => {
    void openDocumentLink(win, url)
    return { action: 'deny' }
  })
  previewView.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    void openDocumentLink(win, url)
  })
  previewView.webContents.on('did-finish-load', () => {
    state.previewReady = true
    previewView.webContents.setZoomFactor(win.webContents.getZoomFactor())
    sendPreviewState(state)
    // The host renderer owns the newest editor text. Ask it for a fresh
    // canonical request after every Preview WebContents restart.
    if (!win.webContents.isDestroyed()) win.webContents.send('preview:reloaded')
  })
  if (isDev) {
    void previewView.webContents.loadURL(previewPageUrl())
  } else {
    void previewView.webContents.loadFile(path.join(__dirname, '../dist/preview.html'))
  }

  win.once('ready-to-show', () => {
    win.show()
  })

  // Unsaved-change gate (main-process owned so it always runs, even if renderer is busy).
  win.on('close', (event) => {
    const current = windows.get(win.id)
    if (!current || current.allowClose || win.isDestroyed()) {
      return
    }

    // Always stop the default close first.
    event.preventDefault()

    if (current.closePromptOpen) return

    // Clean document → flush the final geometry, then close. The previous
    // fire-and-forget write here was the main source of lost window memory.
    if (!current.dirty) {
      current.closePromptOpen = true
      void (async () => {
        await clearWindowRecovery(current)
        await flushWindowBoundsPersist(current)
        // The user can type while an asynchronous disk operation is pending.
        if (current.dirty) {
          current.closePromptOpen = false
          if (!win.isDestroyed()) win.close()
          return
        }
        current.allowClose = true
        if (!win.isDestroyed()) win.close()
      })().catch(error => {
        dialog.showErrorBox('关闭失败', String(error))
      }).finally(() => {
        current.closePromptOpen = false
      })
      return
    }

    current.closePromptOpen = true
    void (async () => {
      try {
        const name = current.filePath ? path.basename(current.filePath) : '未命名.md'
        const result = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['保存', '不保存', '取消'],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
          title: '未保存的更改',
          message: `是否保存对「${name}」的更改？`,
          detail: '如果不保存，最近的修改将丢失。'
        })

        if (result.response === 2) {
          // 取消 — keep window open
          return
        }

        if (result.response === 0) {
          // 保存 — ask renderer to save, then close only on success
          if (!win.webContents.isDestroyed()) {
            const saved = await win.webContents.executeJavaScript(
              'window.__lightEditorSaveForClose ? window.__lightEditorSaveForClose() : false',
              true
            )
            if (!saved) return
          }
        }

        // 不保存, or 保存 succeeded
        current.dirty = false
        await clearWindowRecovery(current)
        await flushWindowBoundsPersist(current)
        current.allowClose = true
        if (!win.isDestroyed()) win.close()
      } catch (error) {
        dialog.showErrorBox('关闭失败', String(error))
      } finally {
        current.closePromptOpen = false
      }
    })()
  })

  win.on('closed', () => {
    const current = windows.get(win.id)
    if (current) {
      if (current.boundsSaveTimer !== null) clearTimeout(current.boundsSaveTimer)
      for (const pending of current.pendingHtmlExports.values()) {
        clearTimeout(pending.timer)
        pending.resolve('')
      }
      current.pendingHtmlExports.clear()
      stopWatcher(current)
    }
    windows.delete(win.id)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void openDocumentLink(win, url)
    return { action: 'deny' }
  })

  if (isDev) {
    void win.loadURL('http://127.0.0.1:5173')
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  return win
}

async function openPathInNewWindow(filePath: string): Promise<BrowserWindow> {
  const existing = findWindowByPath(filePath)
  if (existing) {
    focusWindow(existing)
    return existing
  }
  return createWindow({ openFilePath: filePath })
}

async function openPaths(filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    await openPathInNewWindow(filePath)
  }
}

function recentMenuItems(recentFiles: string[]): Electron.MenuItemConstructorOptions[] {
  if (!recentFiles.length) {
    return [{ label: '(无最近文件)', enabled: false }]
  }
  return recentFiles.slice(0, 10).map((filePath, index) => ({
    label: `${index + 1}. ${filePath}`,
    click: () => {
      void openPathInNewWindow(filePath)
    }
  }))
}

async function rebuildMenu(): Promise<void> {
  const config = await readConfig()
  buildMenu(config.theme, config.recentFiles)
}

function buildMenu(
  theme: 'light' | 'dark' = 'light',
  recentFiles: string[] = []
): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开...',
          accelerator: 'CmdOrCtrl+O',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.send('menu:open')
          }
        },
        {
          label: '新窗口',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            void createWindow()
          }
        },
        {
          label: '最近打开',
          id: 'recent-files',
          submenu: [
            ...recentMenuItems(recentFiles),
            { type: 'separator' },
            {
              label: '清空最近打开',
              click: () => {
                void writeConfig({ recentFiles: [] }).then(() => rebuildMenu())
              }
            }
          ]
        },
        { type: 'separator' },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.send('menu:save')
          }
        },
        {
          label: '另存为...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.send('menu:save-as')
          }
        },
        {
          label: '导出 HTML...',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.send('menu:export-html')
          }
        },
        {
          label: '导出 A4 PDF...',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.send('menu:export-pdf')
          }
        },
        { type: 'separator' },
        {
          label: '退出',
          role: 'quit'
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        {
          id: 'edit-undo',
          label: '撤销',
          accelerator: 'CmdOrCtrl+Z',
          // Display the shortcut without stealing CodeMirror/native-input keys.
          registerAccelerator: false,
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.focus()
            win?.webContents.send('menu:undo')
          }
        },
        {
          id: 'edit-redo',
          label: '重做',
          accelerator: process.platform === 'darwin' ? 'Cmd+Shift+Z' : 'Ctrl+Y',
          registerAccelerator: false,
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.focus()
            win?.webContents.send('menu:redo')
          }
        },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        {
          label: '查找...',
          accelerator: 'CmdOrCtrl+F',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.send('menu:find')
          }
        },
        {
          label: '替换...',
          accelerator: 'CmdOrCtrl+H',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.send('menu:replace')
          }
        },
        { type: 'separator' },
        {
          label: '检查公式',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.send('menu:check-math')
          }
        }
      ]
    },
    {
      label: '工具',
      submenu: [
        { label: '粗体', click: (_item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:format', 'bold') },
        { label: '斜体', click: (_item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:format', 'italic') },
        { label: '行内代码', click: (_item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:format', 'code') },
        { label: '链接', click: (_item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:format', 'link') },
        { label: '图片', click: (_item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:format', 'image') },
        { type: 'separator' },
        { label: '引用', click: (_item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:format', 'quote') },
        { label: '无序列表', click: (_item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:format', 'bullet-list') },
        { label: '有序列表', click: (_item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:format', 'ordered-list') },
        { label: '一级标题', click: (_item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:format', 'heading') },
        { type: 'separator' },
        { label: '行内公式', click: (_item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:format', 'inline-math') },
        { label: '块级公式', click: (_item, focusedWindow) => (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:format', 'display-math') }
      ]
    },
    {
      label: '查看',
      submenu: [
        {
          label: '放大',
          accelerator: 'CmdOrCtrl+=',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            if (win) applyZoom(win, 'in')
          }
        },
        {
          label: '缩小',
          accelerator: 'CmdOrCtrl+-',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            if (win) applyZoom(win, 'out')
          }
        },
        {
          label: '重置缩放',
          accelerator: 'CmdOrCtrl+0',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            if (win) applyZoom(win, 'reset')
          }
        },
        { type: 'separator' },
        {
          label: `源码    ${'\u3000'.repeat(7)}${selectedViewMode === 'editor' ? '✓' : ''}`,
          id: 'view-editor',
          click: (_item, focusedWindow) => {
            syncViewMenu('editor')
            ;(focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:view-mode', 'editor')
          }
        },
        {
          label: `分栏    ${'\u3000'.repeat(7)}${selectedViewMode === 'split' ? '✓' : ''}`,
          id: 'view-split',
          click: (_item, focusedWindow) => {
            syncViewMenu('split')
            ;(focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:view-mode', 'split')
          }
        },
        {
          label: `预览    ${'\u3000'.repeat(7)}${selectedViewMode === 'preview' ? '✓' : ''}`,
          id: 'view-preview',
          click: (_item, focusedWindow) => {
            syncViewMenu('preview')
            ;(focusedWindow as BrowserWindow | undefined)?.webContents.send('menu:view-mode', 'preview')
          }
        },
        { type: 'separator' },
        {
          label: '重新加载预览（KaTeX）',
          accelerator: 'CmdOrCtrl+R',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            const state = win ? getState(win) : null
            if (!state || state.previewView.webContents.isDestroyed()) return
            state.previewReady = false
            state.previewView.setVisible(false)
            state.previewView.webContents.reload()
          }
        },
        {
          label: '从磁盘重新加载文档',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.send('menu:reload-document')
          }
        },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        {
          label: '全屏',
          accelerator: 'F11',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            if (!win) return
            win.setFullScreen(!win.isFullScreen())
          }
        },
        {
          label: '退出全屏',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            if (win?.isFullScreen()) win.setFullScreen(false)
          }
        }
      ]
    },
    {
      label: '设置',
      submenu: [
        {
          label: '外观与字体...',
          accelerator: 'CmdOrCtrl+,',
          click: (_item, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined
            win?.webContents.send('menu:settings')
          }
        },
        {
          // Nested: 设置 → 主题 → 浅色 / 深色
          label: '主题',
          submenu: [
            {
              label: '浅色',
              type: 'radio',
              id: 'theme-light',
              checked: theme === 'light',
              click: (_item, focusedWindow) => {
                const win = focusedWindow as BrowserWindow | undefined
                win?.webContents.send('menu:set-theme', 'light')
              }
            },
            {
              label: '深色',
              type: 'radio',
              id: 'theme-dark',
              checked: theme === 'dark',
              click: (_item, focusedWindow) => {
                const win = focusedWindow as BrowserWindow | undefined
                win?.webContents.send('menu:set-theme', 'dark')
              }
            }
          ]
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function applyTitleBarOverlay(win: BrowserWindow, theme: 'light' | 'dark'): void {
  if (process.platform !== 'win32') return
  try {
    win.setTitleBarOverlay({
      color: theme === 'dark' ? '#161b22' : '#f6f8fa',
      symbolColor: theme === 'dark' ? '#e6edf3' : '#1f2328',
      height: 36
    })
  } catch {
    // Older Electron / non-overlay platforms
  }
}

function registerIpc(): void {
  ipcMain.handle('config:get', async () => readConfig())
  ipcMain.handle('config:set', async (event, partial: Partial<AppConfig>) => {
    const next = await writeConfig(partial)
    if (partial.theme === 'light' || partial.theme === 'dark') {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) applyTitleBarOverlay(win, partial.theme)
    }
    return next
  })

  ipcMain.handle('preview:open-custom-css', async () => {
    const filePath = customPreviewCssPath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    try {
      await fs.access(filePath)
    } catch {
      await fs.writeFile(filePath, DEFAULT_CUSTOM_PREVIEW_CSS, 'utf8')
    }
    ensureCustomPreviewCssWatcher()
    broadcastCustomPreviewCss(await readCustomPreviewCss())
    shell.showItemInFolder(filePath)
    return filePath
  })

  ipcMain.handle(
    'menu:popup',
    (event, menuLabel: string, x: number, y: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return false
      const appMenu = Menu.getApplicationMenu()
      const item = appMenu?.items.find((entry) => entry.label === menuLabel)
      if (!item?.submenu) return false
      item.submenu.popup({
        window: win,
        x: Math.round(x),
        y: Math.round(y)
      })
      return true
    }
  )

  ipcMain.handle('window:set-titlebar-theme', (event, theme: 'light' | 'dark') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) applyTitleBarOverlay(win, theme)
    return true
  })

  // Always open in a brand-new window (one document per window).
  ipcMain.handle('dialog:open-file-new-window', async (event) => {
    const state = getStateFromEvent(event)
    const dialogOptions: Electron.OpenDialogOptions = {
      title: '打开 Markdown 文件（新窗口）',
      properties: ['openFile'],
      filters: [
        MARKDOWN_FILTER,
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const result = state?.win
      ? await dialog.showOpenDialog(state.win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    await openPathInNewWindow(filePath)
    return filePath
  })

  ipcMain.handle('window:new', async () => {
    await createWindow()
    return true
  })

  ipcMain.handle('dialog:save-file', async (event, suggestedName?: string) => {
    const state = getStateFromEvent(event)
    if (!state) return null
    const result = await dialog.showSaveDialog(state.win, {
      title: '另存为',
      defaultPath: suggestedName || state.filePath || 'untitled.md',
      filters: [
        MARKDOWN_FILTER,
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle(
    'export:html',
    async (event, source: string, baseDir: string | null, suggestedName: string): Promise<string | null> => {
      const state = getStateFromEvent(event)
      if (!state) throw new Error('导出窗口已关闭')
      const html = await requestPreviewHtml(state, source, baseDir, suggestedName)

      const result = await dialog.showSaveDialog(state.win, {
        title: '导出 HTML',
        defaultPath: suggestedName || 'untitled.html',
        filters: [
          { name: 'HTML', extensions: ['html', 'htm'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePath) return null
      const targetPath = /\.html?$/iu.test(result.filePath)
        ? result.filePath
        : `${result.filePath}.html`
      const portableHtml = await prepareHtmlExport(html, targetPath)
      await atomicWriteUtf8(targetPath, portableHtml)
      return targetPath
    }
  )

  ipcMain.handle(
    'export:pdf',
    async (event, source: string, baseDir: string | null, suggestedName: string): Promise<string | null> => {
      const state = getStateFromEvent(event)
      if (!state) throw new Error('导出窗口已关闭')
      const html = await requestPreviewHtml(state, source, baseDir, suggestedName)
      const result = await dialog.showSaveDialog(state.win, {
        title: '导出 A4 PDF',
        defaultPath: suggestedName || 'untitled.pdf',
        filters: [
          { name: 'PDF', extensions: ['pdf'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePath) return null
      const targetPath = /\.pdf$/iu.test(result.filePath)
        ? result.filePath
        : `${result.filePath}.pdf`
      await printHtmlToA4Pdf(html, targetPath)
      return targetPath
    }
  )

  ipcMain.handle('file:bind-path', async (event, filePath: string) => {
    const state = getStateFromEvent(event)
    if (!state) throw new Error('No window state')
    const result = await bindPathToWindow(state, filePath, true)
    state.dirty = result.recovered === true
    return result
  })

  ipcMain.handle('file:save', async (event, filePath: string, content: string): Promise<SaveFileResult> => {
    const state = getStateFromEvent(event)
    if (!state) throw new Error('No window state')
    state.recoveryEpoch += 1
    return queueDocumentOperation(state, async () => {
      const originalPath = state.filePath
      markOwnWrite(state)
      await atomicWriteUtf8(filePath, content)
      await clearRecoverySnapshot(filePath)
      if (originalPath && originalPath !== filePath) await clearRecoverySnapshot(originalPath)
      const stat = await fs.stat(filePath)
      state.filePath = filePath
      state.dirty = false
      watchFile(state, filePath)
      await pushRecent(filePath)
      return { path: filePath, mtimeMs: stat.mtimeMs }
    })
  })

  ipcMain.handle('recovery:write', async (event, filePath: string, content: string, lineEnding: 'lf' | 'crlf', sourceMtimeMs: number) => {
    const state = getStateFromEvent(event)
    if (!state || state.filePath !== filePath || typeof content !== 'string') return
    const epoch = state.recoveryEpoch
    await queueDocumentOperation(state, async () => {
      if (epoch !== state.recoveryEpoch || !state.dirty || state.allowClose || state.filePath !== filePath) return
      await writeRecoverySnapshot(filePath, content, lineEnding, Number(sourceMtimeMs) || 0)
    })
  })

  ipcMain.handle('recovery:clear', async (event, filePath: string) => {
    const state = getStateFromEvent(event)
    if (!state || state.filePath !== filePath) return
    await clearWindowRecovery(state)
  })

  ipcMain.handle('file:read', async (event, filePath: string) => {
    const state = getStateFromEvent(event)
    if (!state) throw new Error('No window state')
    state.recoveryEpoch += 1
    return queueDocumentOperation(state, async () => {
      await clearRecoverySnapshot(filePath)
      return bindPathToWindow(state, filePath, false)
    })
  })

  ipcMain.handle('dialog:confirm-reload', async (event, filePath: string) => {
    const state = getStateFromEvent(event)
    if (!state) return false
    const result = await dialog.showMessageBox(state.win, {
      type: 'warning',
      buttons: ['重新加载', '忽略'],
      defaultId: 0,
      cancelId: 1,
      title: '外部文件已更改',
      message: `文件已被其他程序修改：\n${filePath}`,
      detail: '重新加载将丢弃当前未保存的本地修改（如果存在）。'
    })
    return result.response === 0
  })

  ipcMain.handle('dialog:confirm-document-reload', async (event, filePath: string) => {
    const state = getStateFromEvent(event)
    if (!state) return false
    const result = await dialog.showMessageBox(state.win, {
      type: 'warning',
      buttons: ['取消', '放弃修改并重新加载'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '从磁盘重新加载文档',
      message: `是否确定放弃当前修改，从磁盘重新加载「${path.basename(filePath)}」？`,
      detail: '当前编辑器中的内容将被磁盘版本替换，未保存修改无法恢复。'
    })
    return result.response === 1
  })

  ipcMain.handle('dialog:confirm-discard', async (event) => {
    const state = getStateFromEvent(event)
    if (!state) return 'cancel'
    const name = state.filePath
      ? path.basename(state.filePath)
      : '未命名.md'
    const result = await dialog.showMessageBox(state.win, {
      type: 'question',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: '未保存的更改',
      message: `是否保存对「${name}」的更改？`,
      detail: '如果不保存，最近的修改将丢失。'
    })
    if (result.response === 0) return 'save'
    if (result.response === 1) return 'discard'
    return 'cancel'
  })

  ipcMain.handle('file:take-pending-open', async (event) => {
    const state = getStateFromEvent(event)
    if (!state) return null
    const value = state.pendingOpenPath
    // Keep pending until bind succeeds so refresh/reload still knows the target.
    // Renderer will call file:bind-path which clears it.
    return value
  })

  /** Renderer reports dirty flag whenever content changes / is saved. */
  ipcMain.handle('window:set-dirty', (event, dirty: boolean) => {
    const state = getStateFromEvent(event)
    if (!state) return false
    state.dirty = Boolean(dirty)
    return true
  })

  ipcMain.handle('window:zoom', (event, action: 'in' | 'out' | 'reset' | 'get') => {
    const state = getStateFromEvent(event)
    if (!state) return 100
    if (action === 'get') return zoomPercentOf(state.win)
    return applyZoom(state.win, action)
  })

  /** Renderer finished save/discard (or was clean) — allow the window to close. */
  ipcMain.handle('window:force-close', async (event) => {
    const state = getStateFromEvent(event)
    if (!state || state.win.isDestroyed()) return false
    state.dirty = false
    await clearWindowRecovery(state)
    await flushWindowBoundsPersist(state)
    state.allowClose = true
    state.win.close()
    return true
  })

  // Main editor renderer → isolated right-hand preview WebContentsView.
  ipcMain.on('preview:set-bounds', (event, bounds: PreviewBounds) => {
    const state = getStateFromEvent(event)
    if (!state || state.win.isDestroyed()) return
    const clean: PreviewBounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    state.previewBounds = clean
    state.previewView.setBounds(clean)
    state.previewView.setVisible(
      !state.previewOverlayOpen && clean.width > 0 && clean.height > 0
    )
  })

  ipcMain.on('preview:set-overlay-open', (event, open: boolean) => {
    const state = getStateFromEvent(event)
    if (!state || state.win.isDestroyed()) return
    state.previewOverlayOpen = Boolean(open)
    const bounds = state.previewBounds
    state.previewView.setVisible(
      !state.previewOverlayOpen && Boolean(bounds && bounds.width > 0 && bounds.height > 0)
    )
  })

  ipcMain.on('preview:render', (event, request: PreviewRenderRequest) => {
    const state = getStateFromEvent(event)
    if (!state) return
    state.latestPreviewRender = request
    sendPreviewState(state)
  })

  ipcMain.on('preview:appearance', (event, appearance: PreviewAppearance) => {
    const state = getStateFromEvent(event)
    if (!state) return
    state.latestPreviewAppearance = appearance
    sendPreviewState(state)
  })

  ipcMain.on('preview:reveal-line', (event, line: number) => {
    const state = getStateFromEvent(event)
    if (!state || !state.previewReady || !Number.isFinite(line)) return
    state.previewView.webContents.send('preview:reveal-line', Math.max(1, Math.round(line)))
  })

  // Isolated preview → editor renderer for preview double-click navigation.
  ipcMain.on('preview:jump-to-editor', (event, line: number) => {
    const state = getStateFromPreviewSender(event.sender)
    if (!state || !Number.isFinite(line) || state.win.webContents.isDestroyed()) return
    state.win.webContents.send('preview:jump-to-editor', Math.max(1, Math.round(line)))
  })

  // Only our isolated Preview may request OS-default opening. Keep the entire
  // URL intact until fileURLToPath performs the one authoritative decode.
  ipcMain.handle('preview:open-link', async (event, href: unknown) => {
    const state = getStateFromPreviewSender(event.sender)
    if (!state) return
    await openDocumentLink(state.win, href)
  })

  ipcMain.on('preview:render-complete', (event, result: PreviewRenderComplete) => {
    const state = getStateFromPreviewSender(event.sender)
    if (
      !state || state.win.webContents.isDestroyed() ||
      !Number.isFinite(result?.requestId) ||
      !Number.isFinite(result?.version) ||
      (result?.mode !== 'canonical' && result?.mode !== 'local') ||
      typeof result?.ok !== 'boolean'
    ) return
    state.win.webContents.send('preview:render-complete', result)
  })

  ipcMain.on('preview:export-html-result', (event, result: PreviewHtmlExportResult) => {
    const state = getStateFromPreviewSender(event.sender)
    if (!state || !Number.isFinite(result?.requestId) || typeof result?.html !== 'string') return
    const pending = state.pendingHtmlExports.get(result.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    state.pendingHtmlExports.delete(result.requestId)
    pending.resolve(result.html)
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const files = collectMarkdownArgs(argv)
    if (files.length > 0) {
      void openPaths(files)
      return
    }
    // No file: focus an existing window or create one.
    const existing = BrowserWindow.getAllWindows()[0]
    if (existing) focusWindow(existing)
    else void createWindow()
  })

  app.whenReady().then(async () => {
    registerIpc()
    ensureCustomPreviewCssWatcher()
    const cfg = await readConfig()
    buildMenu(cfg.theme, cfg.recentFiles)

    const files = collectMarkdownArgs(process.argv)
    if (files.length > 0) {
      await openPaths(files)
    } else {
      await createWindow()
    }

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    if (customPreviewCssWatcher) {
      void customPreviewCssWatcher.close()
      customPreviewCssWatcher = null
    }
  })
}
