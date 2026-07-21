import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppConfig, OpenFileResult, SaveFileResult } from '../src/shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.env.LIGHT_EDITOR_DEV === '1'
const CONFIG_FILE = 'config.json'
const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext'])

const defaultConfig: AppConfig = {
  recentFiles: [],
  windowBounds: {
    width: 1280,
    height: 840,
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
  previewFontFamily:
    '"Segoe UI", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  editorLineHeight: 1.55,
  previewLineHeight: 1.7,
  previewMaxWidth: 0,
  linkFontSizes: true,
  autoSave: false
}

interface WindowState {
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
}

const windows = new Map<number, WindowState>()

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE)
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
    previewLineHeight: Number(merged.previewLineHeight) || defaultConfig.previewLineHeight,
    previewMaxWidth: Math.max(0, Number(merged.previewMaxWidth) || 0),
    linkFontSizes: merged.linkFontSizes !== false,
    editorFontFamily: (() => {
      const fam = String(merged.editorFontFamily || defaultConfig.editorFontFamily)
      // Migrate away from Maple Mono NF (Nerd Font / icon face).
      if (/maple\s*mono/i.test(fam)) return defaultConfig.editorFontFamily
      return fam
    })(),
    previewFontFamily: String(merged.previewFontFamily || defaultConfig.previewFontFamily),
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

async function writeConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
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
  await fs.writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8')
  if (partial.theme) syncThemeMenu(next.theme)
  return next
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

function persistWindowBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = win.getBounds()
  void writeConfig({
    windowBounds: {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y
    }
  })
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

async function bindPathToWindow(state: WindowState, filePath: string): Promise<OpenFileResult> {
  const result = await readOpenResult(filePath)
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
      sandbox: false
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

  const state: WindowState = {
    win,
    filePath: null,
    pendingOpenPath: options.openFilePath ?? null,
    watcher: null,
    ignoreExternalUntil: 0,
    allowClose: false,
    dirty: false,
    closePromptOpen: false
  }
  windows.set(win.id, state)

  win.once('ready-to-show', () => {
    win.show()
  })

  // Unsaved-change gate (main-process owned so it always runs, even if renderer is busy).
  win.on('close', (event) => {
    const current = windows.get(win.id)
    if (!current || current.allowClose || win.isDestroyed()) {
      persistWindowBounds(win)
      return
    }

    // Always stop the default close first.
    event.preventDefault()

    if (current.closePromptOpen) return

    // Clean document → close immediately.
    if (!current.dirty) {
      current.allowClose = true
      persistWindowBounds(win)
      // Defer so this close handler finishes before the real close.
      setImmediate(() => {
        if (!win.isDestroyed()) win.close()
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
        current.allowClose = true
        current.dirty = false
        persistWindowBounds(win)
        if (!win.isDestroyed()) win.close()
      } finally {
        current.closePromptOpen = false
      }
    })()
  })

  win.on('closed', () => {
    const current = windows.get(win.id)
    if (current) stopWatcher(current)
    windows.delete(win.id)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
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
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
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
        }
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
        { role: 'reload', label: '重新加载' },
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
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
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
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle('file:bind-path', async (event, filePath: string) => {
    const state = getStateFromEvent(event)
    if (!state) throw new Error('No window state')
    const result = await bindPathToWindow(state, filePath)
    state.dirty = false
    return result
  })

  ipcMain.handle('file:save', async (event, filePath: string, content: string): Promise<SaveFileResult> => {
    const state = getStateFromEvent(event)
    if (!state) throw new Error('No window state')
    markOwnWrite(state)
    await fs.writeFile(filePath, content, 'utf8')
    const stat = await fs.stat(filePath)
    state.filePath = filePath
    state.dirty = false
    watchFile(state, filePath)
    await pushRecent(filePath)
    return {
      path: filePath,
      mtimeMs: stat.mtimeMs
    }
  })

  ipcMain.handle('file:read', async (event, filePath: string) => {
    const state = getStateFromEvent(event)
    if (!state) throw new Error('No window state')
    return bindPathToWindow(state, filePath)
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
  ipcMain.handle('window:force-close', (event) => {
    const state = getStateFromEvent(event)
    if (!state || state.win.isDestroyed()) return false
    state.allowClose = true
    state.dirty = false
    persistWindowBounds(state.win)
    state.win.close()
    return true
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
}
