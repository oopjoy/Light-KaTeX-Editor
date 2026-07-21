import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'
import './styles.css'

import type { EditorView } from '@codemirror/view'
import {
  createEditor,
  openEditorFind,
  openEditorReplace,
  setEditorAppearance,
  setEditorContent
} from './editor'
import { applyAppearanceToDom, DEFAULT_APPEARANCE, normalizeConfig } from './appearance'
import { createSettingsPanel, type SettingsController } from './settings'
import { collectMathErrors } from './markdown/math-errors'
import { createMathErrorsPanel, type MathErrorsPanel } from './math-errors-panel'
import { renderMarkdown } from './markdown/render'
import { findSourceLineFromTarget, jumpEditorToLine, jumpPreviewToLine } from './sync/jump'
import type { AppConfig, DocumentState } from './shared/types'
import { WELCOME } from './welcome'

const appRootEl = document.getElementById('app')
if (!appRootEl) throw new Error('#app not found')
const appRoot: HTMLElement = appRootEl

let config: AppConfig = normalizeConfig({
  recentFiles: [],
  windowBounds: { width: 1280, height: 840 },
  splitRatio: 0.5,
  autoSave: false,
  ...DEFAULT_APPEARANCE
})

let doc: DocumentState = {
  path: null,
  content: WELCOME,
  savedContent: WELCOME,
  encoding: 'utf-8',
  lineEnding: 'lf',
  externalModifiedAt: 0
}

let editorView: EditorView | null = null
let previewTimer: number | null = null
let autoSaveTimer: number | null = null
let splitRatio = 0.5
let settings: SettingsController | null = null
let mathErrorsPanel: MathErrorsPanel | null = null
let persistTimer: number | null = null
let mathErrorTimer: number | null = null
/** View zoom percent (Electron webContents zoomFactor × 100). */
let zoomPercent = 100

function basename(filePath: string | null): string {
  if (!filePath) return '未命名.md'
  const parts = filePath.replaceAll('\\', '/').split('/')
  return parts[parts.length - 1] || filePath
}

function dirname(filePath: string | null): string | null {
  if (!filePath) return null
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (slash <= 0) return null
  return filePath.slice(0, slash)
}

function isDirty(): boolean {
  return doc.content !== doc.savedContent
}

function syncDirtyToMain(): void {
  void window.lightEditor.setDirty(isDirty())
}

function titlePathText(): string {
  const mark = isDirty() ? '● ' : ''
  return `${mark}${doc.path ?? '未命名.md'}`
}

function updateTitle(): void {
  const text = titlePathText()
  document.title = text
  const pathEl = document.getElementById('titlebar-path')
  if (pathEl) {
    pathEl.textContent = text
    pathEl.title = doc.path ?? '未命名.md'
  }
}

function editorAppearanceFromConfig(c: AppConfig) {
  return {
    fontSize: c.editorFontSize,
    fontFamily: c.editorFontFamily,
    lineHeight: c.editorLineHeight,
    theme: c.theme
  }
}

function applyConfigToUi(): void {
  applyAppearanceToDom(config)
  if (editorView) {
    setEditorAppearance(editorView, editorAppearanceFromConfig(config))
  }
  updateChrome()
}

function schedulePersist(partial: Partial<AppConfig>): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    void window.lightEditor.setConfig(partial)
  }, 180)
}

async function updateConfig(partial: Partial<AppConfig>, persist = true): Promise<void> {
  config = normalizeConfig({ ...config, ...partial })
  applyConfigToUi()
  if (persist) schedulePersist(partial)
}

function renderShell(): void {
  appRoot.innerHTML = `
    <header class="titlebar" id="titlebar">
      <div class="titlebar-drag">
        <div class="titlebar-brand" aria-hidden="true">
          <svg class="titlebar-icon" viewBox="0 0 32 32" width="18" height="18" shape-rendering="geometricPrecision">
            <rect x="1.5" y="1.5" width="29" height="29" rx="6" fill="#2563eb"/>
            <path d="M9.5 8v16M9.5 16l11-7.5M9.5 16l11 7.5" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          </svg>
        </div>
        <nav class="titlebar-menus" aria-label="主菜单">
          <button type="button" class="titlebar-menu-btn" data-menu="文件">文件</button>
          <button type="button" class="titlebar-menu-btn" data-menu="编辑">编辑</button>
          <button type="button" class="titlebar-menu-btn" data-menu="查看">查看</button>
          <button type="button" class="titlebar-menu-btn" data-menu="设置">设置</button>
        </nav>
        <div class="titlebar-path" id="titlebar-path" title="">${titlePathText()}</div>
      </div>
      <div class="titlebar-controls-spacer" aria-hidden="true"></div>
    </header>
    <div class="workspace" id="workspace" style="--split-ratio: ${splitRatio * 100}%">
      <section class="pane">
        <div class="editor-host" id="editor-host"></div>
      </section>
      <div class="splitter" id="splitter" title="拖动调整分栏"></div>
      <section class="pane">
        <div class="preview-host" id="preview-host"></div>
      </section>
    </div>
    <div id="math-errors-slot"></div>
    <div class="status-bar">
      <span id="status-left">UTF-8 · ${doc.lineEnding.toUpperCase()}${isDirty() ? ' · 未保存' : ''}</span>
      <span id="status-right">${zoomPercent}%</span>
    </div>
  `

  setupTitlebarMenus()

  const editorHost = document.getElementById('editor-host')
  if (!editorHost) throw new Error('editor host missing')

  editorView = createEditor({
    parent: editorHost,
    doc: doc.content,
    appearance: editorAppearanceFromConfig(config),
    onChange: (value) => {
      doc.content = value
      updateChrome()
      schedulePreview()
      scheduleMathErrors()
      scheduleAutoSave()
    },
    onJumpToPreview: (line) => {
      jumpToPreviewFromLine(line)
    }
  })

  setupSplitter()
  setupPreviewJump()
  setupMathErrorsPanel()
  updatePreviewNow()
  scheduleMathErrors()
  updateTitle()
  applyConfigToUi()
  void window.lightEditor.setTitleBarTheme(config.theme)
}

function setupTitlebarMenus(): void {
  const bar = document.getElementById('titlebar')
  if (!bar) return
  bar.querySelectorAll<HTMLButtonElement>('.titlebar-menu-btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const label = btn.dataset.menu
      if (!label) return
      const rect = btn.getBoundingClientRect()
      void window.lightEditor.popupMenu(label, rect.left, rect.bottom)
    })
  })
}

function setupMathErrorsPanel(): void {
  const slot = document.getElementById('math-errors-slot')
  if (!slot) return
  mathErrorsPanel?.destroy()
  mathErrorsPanel = createMathErrorsPanel({
    onJump: (line) => {
      if (!editorView) return
      jumpEditorToLine(editorView, line)
      setStatusRight(`已跳转到公式错误 · 第 ${line} 行`)
    }
  })
  slot.appendChild(mathErrorsPanel.el)
}

function scheduleMathErrors(): void {
  if (mathErrorTimer !== null) window.clearTimeout(mathErrorTimer)
  mathErrorTimer = window.setTimeout(() => {
    const errors = collectMathErrors(doc.content)
    mathErrorsPanel?.update(errors)
    const statusLeft = document.getElementById('status-left')
    if (statusLeft) {
      const base = `UTF-8 · ${doc.lineEnding.toUpperCase()}${isDirty() ? ' · 未保存' : ''}`
      statusLeft.textContent =
        errors.length > 0 ? `${base} · 公式错误 ${errors.length}` : base
    }
  }, 280)
}

function updateChrome(): void {
  // status-left is owned by scheduleMathErrors (includes formula error count).
  scheduleMathErrors()
  const statusRight = document.getElementById('status-right')
  if (statusRight) {
    statusRight.textContent = `${zoomPercent}%`
  }
  updateTitle()
  syncDirtyToMain()
}

function setZoomPercent(percent: number): void {
  zoomPercent = Math.max(50, Math.min(300, Math.round(percent)))
  const statusRight = document.getElementById('status-right')
  if (statusRight) statusRight.textContent = `${zoomPercent}%`
}

async function zoomView(action: 'in' | 'out' | 'reset'): Promise<void> {
  const percent = await window.lightEditor.zoom(action)
  setZoomPercent(percent)
}

/** Temporary right-status tip; always restores zoom percent afterward. */
function setStatusRight(text: string, stickyMs = 2200): void {
  const statusRight = document.getElementById('status-right')
  if (!statusRight) return
  statusRight.dataset.sticky = '1'
  statusRight.textContent = text
  window.setTimeout(() => {
    delete statusRight.dataset.sticky
    statusRight.textContent = `${zoomPercent}%`
  }, stickyMs)
}

function schedulePreview(): void {
  if (previewTimer !== null) window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => {
    updatePreviewNow()
  }, 120)
}

function updatePreviewNow(): void {
  const host = document.getElementById('preview-host')
  if (!host) return
  host.innerHTML = renderMarkdown(doc.content, dirname(doc.path))
}

function jumpToPreviewFromLine(line: number): void {
  const host = document.getElementById('preview-host')
  if (!host) return
  const ok = jumpPreviewToLine(host, line)
  setStatusRight(
    ok ? `已跳转到预览 · 源码第 ${line} 行` : `未找到第 ${line} 行对应的预览块`
  )
}

function setupPreviewJump(): void {
  const host = document.getElementById('preview-host')
  if (!host) return

  host.addEventListener('dblclick', (event) => {
    const t = event.target
    if (t instanceof HTMLElement) {
      if (t.closest('a, button, input, textarea, select, label')) return
    }
    const line = findSourceLineFromTarget(event.target, host)
    if (line === null || !editorView) return
    event.preventDefault()
    jumpEditorToLine(editorView, line)
    setStatusRight(`已跳转到源码 · 第 ${line} 行`)
  })
}

function scheduleAutoSave(): void {
  if (!config.autoSave || !doc.path) return
  if (autoSaveTimer !== null) window.clearTimeout(autoSaveTimer)
  autoSaveTimer = window.setTimeout(() => {
    void saveFile(true)
  }, 1200)
}

function setupSplitter(): void {
  const splitter = document.getElementById('splitter')
  const workspace = document.getElementById('workspace')
  if (!splitter || !workspace) return

  let dragging = false

  const onMove = (event: MouseEvent) => {
    if (!dragging) return
    const rect = workspace.getBoundingClientRect()
    const ratio = Math.min(0.8, Math.max(0.2, (event.clientX - rect.left) / rect.width))
    splitRatio = ratio
    workspace.style.setProperty('--split-ratio', `${ratio * 100}%`)
  }

  const onUp = () => {
    if (!dragging) return
    dragging = false
    splitter.classList.remove('active')
    document.body.style.cursor = ''
    void window.lightEditor.setConfig({ splitRatio })
  }

  splitter.addEventListener('mousedown', (event) => {
    event.preventDefault()
    dragging = true
    splitter.classList.add('active')
    document.body.style.cursor = 'col-resize'
  })
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function applyOpenedFile(
  filePath: string,
  content: string,
  lineEnding: 'lf' | 'crlf',
  mtimeMs: number
): void {
  doc = {
    path: filePath,
    content,
    savedContent: content,
    encoding: 'utf-8',
    lineEnding,
    externalModifiedAt: mtimeMs
  }
  if (editorView) setEditorContent(editorView, content)
  updateChrome()
  updatePreviewNow()
  scheduleMathErrors()
}

async function openFile(): Promise<void> {
  await window.lightEditor.openFileInNewWindow()
}

async function newWindow(): Promise<void> {
  await window.lightEditor.newWindow()
}

async function loadPathIntoThisWindow(filePath: string): Promise<void> {
  const result = await window.lightEditor.bindPath(filePath)
  applyOpenedFile(result.path, result.content, result.lineEnding, result.mtimeMs)
}

async function saveFile(silent = false): Promise<boolean> {
  if (!doc.path) return saveFileAs()
  try {
    const result = await window.lightEditor.saveFile(doc.path, doc.content)
    doc.path = result.path
    doc.savedContent = doc.content
    doc.externalModifiedAt = result.mtimeMs
    updateChrome()
    return true
  } catch (error) {
    if (!silent) {
      console.error(error)
      window.alert(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return false
  }
}

async function saveFileAs(): Promise<boolean> {
  const target = await window.lightEditor.saveFileDialog(basename(doc.path))
  if (!target) return false
  try {
    const result = await window.lightEditor.saveFile(target, doc.content)
    doc.path = result.path
    doc.savedContent = doc.content
    doc.externalModifiedAt = result.mtimeMs
    updateChrome()
    updatePreviewNow()
    return true
  } catch (error) {
    console.error(error)
    window.alert(`另存为失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Called from main process during close when user chooses「保存」.
 * Exposed on window so main can executeJavaScript without a dedicated IPC round-trip race.
 */
async function saveForClose(): Promise<boolean> {
  const ok = await saveFile()
  if (ok) syncDirtyToMain()
  return ok
}

// Bridge for main-process close dialog (window:close handler).
;(window as unknown as { __lightEditorSaveForClose: () => Promise<boolean> }).__lightEditorSaveForClose =
  saveForClose

/** Fallback close path if main still sends window:close-request. */
let closePromptBusy = false
async function handleCloseRequest(): Promise<void> {
  if (closePromptBusy) return
  closePromptBusy = true
  try {
    if (!isDirty()) {
      await window.lightEditor.forceClose()
      return
    }
    const choice = await window.lightEditor.confirmDiscard()
    if (choice === 'cancel') return
    if (choice === 'save') {
      const ok = await saveFile()
      if (!ok) return
    }
    await window.lightEditor.forceClose()
  } finally {
    closePromptBusy = false
  }
}

async function toggleTheme(): Promise<void> {
  await updateConfig({ theme: config.theme === 'light' ? 'dark' : 'light' })
}

function openFind(): void {
  if (!editorView) return
  openEditorFind(editorView)
}

function openReplace(): void {
  if (!editorView) return
  openEditorReplace(editorView)
}

function openSettings(): void {
  settings?.open()
}

async function handleExternalChange(filePath: string): Promise<void> {
  if (!doc.path || filePath !== doc.path) return
  const reload = await window.lightEditor.confirmReload(filePath)
  if (!reload) return
  const result = await window.lightEditor.readFile(filePath)
  applyOpenedFile(result.path, result.content, result.lineEnding, result.mtimeMs)
}

async function bootstrap(): Promise<void> {
  config = normalizeConfig(await window.lightEditor.getConfig())
  splitRatio = config.splitRatio || 0.5
  applyAppearanceToDom(config)
  renderShell()

  settings = createSettingsPanel({
    getConfig: () => config,
    onChange: async (partial) => {
      await updateConfig(partial)
    }
  })

  window.lightEditor.onMenuOpen(() => void openFile())
  window.lightEditor.onMenuSave(() => void saveFile())
  window.lightEditor.onMenuSaveAs(() => void saveFileAs())
  window.lightEditor.onMenuToggleTheme(() => void toggleTheme())
  window.lightEditor.onMenuSetTheme((theme) => {
    void updateConfig({ theme })
  })
  window.lightEditor.onMenuFind(() => openFind())
  window.lightEditor.onMenuReplace(() => openReplace())
  window.lightEditor.onMenuSettings(() => openSettings())
  window.lightEditor.onExternalChange((filePath) => void handleExternalChange(filePath))
  window.lightEditor.onCloseRequest(() => {
    void handleCloseRequest()
  })
  window.lightEditor.onZoomChanged((percent) => {
    setZoomPercent(percent)
  })

  // Sync initial zoom percent into status bar
  void window.lightEditor.zoom('get').then((p) => setZoomPercent(p))

  const pending = await window.lightEditor.takePendingOpen()
  if (pending) {
    await loadPathIntoThisWindow(pending)
  }

  window.addEventListener('keydown', (event) => {
    if (settings?.isOpen()) return
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.shiftKey && event.key.toLowerCase() === 'n') {
      event.preventDefault()
      void newWindow()
    } else if (mod && event.key.toLowerCase() === 'o') {
      event.preventDefault()
      void openFile()
    } else if (mod && event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveFileAs()
    } else if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveFile()
    } else if (mod && event.key.toLowerCase() === 't') {
      event.preventDefault()
      void toggleTheme()
    } else if (mod && event.key === ',') {
      event.preventDefault()
      openSettings()
    } else if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      openFind()
    } else if (mod && event.key.toLowerCase() === 'h') {
      event.preventDefault()
      openReplace()
    } else if (mod && (event.key === '=' || event.key === '+')) {
      event.preventDefault()
      void zoomView('in')
    } else if (mod && event.key === '-') {
      event.preventDefault()
      void zoomView('out')
    } else if (mod && event.key === '0') {
      event.preventDefault()
      void zoomView('reset')
    }
  })
}

void bootstrap()
