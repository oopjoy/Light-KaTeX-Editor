import './styles.css'

import type { EditorView } from '@codemirror/view'
import {
  createEditor,
  openEditorFind,
  openEditorReplace,
  setEditorAppearance,
  setEditorContent,
  type EditorChangeHint
} from './editor'
import { applyAppearanceToDom, DEFAULT_APPEARANCE, normalizeConfig } from './appearance'
import { createSettingsPanel, type SettingsController } from './settings'
import { collectMathErrors } from './markdown/math-errors'
import { createMathErrorsPanel, type MathErrorsPanel } from './math-errors-panel'
import { flashEditorLine, jumpEditorToLine } from './sync/jump'
import type { AppConfig, DocumentState } from './shared/types'
import { WELCOME } from './welcome'

const appRootEl = document.getElementById('app')
if (!appRootEl) throw new Error('#app not found')
const appRoot: HTMLElement = appRootEl

let config: AppConfig = normalizeConfig({
  recentFiles: [],
  windowBounds: { width: 1160, height: 760 },
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
let characterCount = countVisibleCharacters(WELCOME)
let dirty = false
let lastRenderedTitle = ''

let editorView: EditorView | null = null
/** Quick, safe island refresh: short trailing debounce while typing. */
let localPreviewTimer: number | null = null
/** Prevent continuous typing from postponing all local preview updates forever. */
let localPreviewMaxTimer: number | null = null
/** Canonical semantic repair: whole document only after an editing pause. */
let canonicalPreviewTimer: number | null = null
let pendingLocalPreviewHint: EditorChangeHint | null = null
/** Any structural edit makes the last canonical block map unsafe until repaired. */
let previewChunkMapInvalid = true
/** Exactly one Preview render may be in flight; stale work never queues. */
let previewRenderInFlight = false
/** ACKs are accepted only for this exact IPC request. */
let previewInFlightRequestId: number | null = null
let nextPreviewRequestId = 1
type PendingPreviewRequest = {
  mode: 'canonical' | 'local'
  localEdit?: { fromLine: number; toLine: number }
}
let pendingPreviewRequest: PendingPreviewRequest | null = null
let autoSaveTimer: number | null = null
let splitRatio = 0.5
let settings: SettingsController | null = null
let mathErrorsPanel: MathErrorsPanel | null = null
let persistTimer: number | null = null
let mathErrorTimer: number | null = null
let mathErrorIdleCallback: number | null = null
/** Monotonic editor generation; materialized text is shared by preview/save/errors. */
let documentVersion = 0
let materializedVersion = 0
/** Avoid renderer → main IPC on every keystroke while dirty state stays true. */
let lastDirtySent: boolean | null = null
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
  return dirty
}

/** Count visible characters, excluding spaces/newlines; Unicode characters count once. */
function countVisibleCharacters(content: string): number {
  return content.match(/\S/gu)?.length ?? 0
}

function statusRightText(): string {
  return `${characterCount} 字 · ${zoomPercent}%`
}

/** Materialize CodeMirror's document only when rendering/saving/validating needs it. */
function currentDocumentContent(): string {
  if (editorView && materializedVersion !== documentVersion) {
    doc.content = editorView.state.doc.toString()
    materializedVersion = documentVersion
  }
  return doc.content
}

function inputIsPending(): boolean {
  const scheduling = (navigator as Navigator & {
    scheduling?: { isInputPending?: () => boolean }
  }).scheduling
  return scheduling?.isInputPending?.() === true
}

function syncDirtyToMain(force = false): void {
  const dirty = isDirty()
  if (!force && dirty === lastDirtySent) return
  lastDirtySent = dirty
  void window.lightEditor.setDirty(dirty)
}

function titlePathText(): string {
  const mark = isDirty() ? '● ' : ''
  return `${mark}${doc.path ?? '未命名.md'}`
}

function updateTitle(): void {
  const text = titlePathText()
  if (text === lastRenderedTitle) return
  lastRenderedTitle = text
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
    sourceColoring: c.sourceColoring,
    theme: c.theme
  }
}

function applyConfigToUi(): void {
  applyAppearanceToDom(config)
  if (editorView) {
    setEditorAppearance(editorView, editorAppearanceFromConfig(config))
  }
  sendPreviewAppearance()
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
  if ('liveMathCheck' in partial) {
    if (config.liveMathCheck) scheduleMathErrors()
    else cancelScheduledMathErrors()
  }
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
      <span id="status-right">${statusRightText()}</span>
    </div>
  `

  setupTitlebarMenus()

  const editorHost = document.getElementById('editor-host')
  if (!editorHost) throw new Error('editor host missing')

  editorView = createEditor({
    parent: editorHost,
    doc: doc.content,
    appearance: editorAppearanceFromConfig(config),
    onChange: (visibleCharacterDelta, userEvent, changeHint) => {
      documentVersion += 1
      // Null means a programmatic replacement; applyOpenedFile has already
      // installed exact dirty/count state before dispatching it.
      if (userEvent) {
        characterCount = Math.max(0, characterCount + visibleCharacterDelta)
        dirty = userEvent.startsWith('undo') || userEvent.startsWith('redo')
          ? currentDocumentContent() !== doc.savedContent
          : true
      }
      updateChrome() // owns formula-error scheduling
      schedulePreview(changeHint)
      scheduleAutoSave()
    },
    onJumpToPreview: (line) => {
      jumpToPreviewFromLine(line)
    }
  })

  setupSplitter()
  setupPreviewLayout()
  setupPreviewJump()
  setupMathErrorsPanel()
  sendPreviewAppearance()
  queuePreview('canonical')
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

function cancelScheduledMathErrors(): void {
  if (mathErrorTimer !== null) {
    window.clearTimeout(mathErrorTimer)
    mathErrorTimer = null
  }
  if (mathErrorIdleCallback !== null) {
    window.cancelIdleCallback(mathErrorIdleCallback)
    mathErrorIdleCallback = null
  }
}

function runMathCheck(): void {
  const errors = collectMathErrors(currentDocumentContent())
  mathErrorsPanel?.update(errors)
  const statusLeft = document.getElementById('status-left')
  if (statusLeft) {
    const base = `UTF-8 · ${doc.lineEnding.toUpperCase()}${isDirty() ? ' · 未保存' : ''}`
    statusLeft.textContent = errors.length > 0 ? `${base} · 公式错误 ${errors.length}` : base
  }
  setStatusRight(errors.length > 0 ? `公式错误 ${errors.length}` : '未发现公式错误')
}

function checkMathNow(): void {
  cancelScheduledMathErrors()
  runMathCheck()
}

function scheduleMathErrors(): void {
  if (!config.liveMathCheck) return
  cancelScheduledMathErrors()
  // Error diagnostics are opt-in. When enabled, longer notes get a wider quiet
  // period so validation never races normal edit bursts.
  const lineCount = editorView?.state.doc.lines ?? doc.content.split('\n').length
  const delay = lineCount >= 1500 ? 1800 : 900
  const scheduledVersion = documentVersion
  mathErrorTimer = window.setTimeout(() => {
    mathErrorTimer = null
    mathErrorIdleCallback = window.requestIdleCallback(() => {
      mathErrorIdleCallback = null
      if (scheduledVersion !== documentVersion || inputIsPending()) {
        scheduleMathErrors()
        return
      }
      runMathCheck()
    }, { timeout: 2500 })
  }, delay)
}

function updateChrome(): void {
  // status-left is owned by scheduleMathErrors (includes formula error count).
  scheduleMathErrors()
  const statusRight = document.getElementById('status-right')
  if (statusRight && statusRight.dataset.sticky !== '1') {
    statusRight.textContent = statusRightText()
  }
  updateTitle()
  syncDirtyToMain()
}

function setZoomPercent(percent: number): void {
  zoomPercent = Math.max(50, Math.min(300, Math.round(percent)))
  const statusRight = document.getElementById('status-right')
  if (statusRight && statusRight.dataset.sticky !== '1') {
    statusRight.textContent = statusRightText()
  }
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
    statusRight.textContent = statusRightText()
  }, stickyMs)
}

function previewAppearanceFromConfig(c: AppConfig) {
  return {
    theme: c.theme,
    fontFamily: c.previewFontFamily,
    fontSize: c.previewFontSize,
    lineHeight: c.previewLineHeight,
    maxWidth: c.previewMaxWidth
  }
}

function sendPreviewAppearance(): void {
  window.lightEditor.setPreviewAppearance(previewAppearanceFromConfig(config))
}

function queuePreview(
  mode: 'canonical' | 'local',
  localEdit?: { fromLine: number; toLine: number }
): void {
  const request: PendingPreviewRequest = { mode, ...(localEdit ? { localEdit } : {}) }
  if (previewRenderInFlight) {
    // Canonical work is semantic repair and must not be replaced by a later
    // local cosmetic update. Otherwise retain only the newest request.
    if (pendingPreviewRequest?.mode !== 'canonical' || mode === 'canonical') {
      pendingPreviewRequest = request
    }
    return
  }
  sendPreviewNow(request)
}

function sendPreviewNow(request: PendingPreviewRequest): void {
  if (!editorView) return
  const version = documentVersion
  const source = currentDocumentContent()
  const requestId = nextPreviewRequestId++
  previewRenderInFlight = true
  previewInFlightRequestId = requestId
  window.lightEditor.updatePreview({
    requestId,
    version,
    source,
    baseDir: dirname(doc.path),
    mode: request.mode,
    ...(request.localEdit ? { localEdit: request.localEdit } : {})
  })
}

function flushPendingPreview(): void {
  if (previewRenderInFlight || !pendingPreviewRequest) return
  const request = pendingPreviewRequest
  pendingPreviewRequest = null
  sendPreviewNow(request)
}

/**
 * Two-tier preview scheduling:
 * - only a parser-confirmed paragraph/math island gets the short local debounce;
 * - every edit also arms the slower canonical full-document repair.
 */
function cancelLocalPreviewTimers(): void {
  if (localPreviewTimer !== null) {
    window.clearTimeout(localPreviewTimer)
    localPreviewTimer = null
  }
  if (localPreviewMaxTimer !== null) {
    window.clearTimeout(localPreviewMaxTimer)
    localPreviewMaxTimer = null
  }
}

function flushLocalPreview(): void {
  cancelLocalPreviewTimers()
  const hint = pendingLocalPreviewHint
  pendingLocalPreviewHint = null
  if (!hint || previewChunkMapInvalid) return
  queuePreview('local', { fromLine: hint.fromLine, toLine: hint.toLine })
}

function schedulePreview(changeHint: EditorChangeHint): void {
  if (localPreviewTimer !== null) {
    window.clearTimeout(localPreviewTimer)
    localPreviewTimer = null
  }

  if (changeHint.isConservativeLocalEdit && !previewChunkMapInvalid) {
    // Merge a burst into one source span. Preview owns the parser-backed chunk
    // map and will accept it only when that entire span is in one safe island.
    pendingLocalPreviewHint = pendingLocalPreviewHint
      ? {
          fromLine: Math.min(pendingLocalPreviewHint.fromLine, changeHint.fromLine),
          toLine: Math.max(pendingLocalPreviewHint.toLine, changeHint.toLine),
          isConservativeLocalEdit: true
        }
      : changeHint
    // During a burst we publish after 100ms of quiet, but no later than 300ms
    // after its first keystroke.
    localPreviewTimer = window.setTimeout(flushLocalPreview, 100)
    if (localPreviewMaxTimer === null) {
      localPreviewMaxTimer = window.setTimeout(flushLocalPreview, 300)
    }
  } else {
    cancelLocalPreviewTimers()
    pendingLocalPreviewHint = null
    previewChunkMapInvalid = true
    // A local request stores source-line coordinates. A later structural edit
    // invalidates those coordinates, so never let it flush after this edit.
    if (pendingPreviewRequest?.mode === 'local') pendingPreviewRequest = null
  }

  if (canonicalPreviewTimer !== null) window.clearTimeout(canonicalPreviewTimer)
  canonicalPreviewTimer = window.setTimeout(() => {
    canonicalPreviewTimer = null
    cancelLocalPreviewTimers()
    pendingLocalPreviewHint = null
    // Canonical render intentionally runs even if a same-version local island
    // already updated. It restores whole-document Markdown semantics and map.
    queuePreview('canonical')
  }, 1000)
}

function jumpToPreviewFromLine(line: number): void {
  window.lightEditor.revealPreviewLine(line)
  setStatusRight(`已跳转到预览 · 源码第 ${line} 行`)
}

function setupPreviewJump(): void {
  window.lightEditor.onPreviewJumpToEditor((line) => {
    if (!editorView) return
    jumpEditorToLine(editorView, line)
    flashEditorLine(editorView, line)
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

function setupPreviewLayout(): void {
  const host = document.getElementById('preview-host')
  if (!host) return
  let frame = 0
  const update = () => {
    frame = 0
    const rect = host.getBoundingClientRect()
    window.lightEditor.setPreviewBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
  }
  const schedule = () => {
    if (frame) return
    frame = window.requestAnimationFrame(update)
  }
  new ResizeObserver(schedule).observe(host)
  window.addEventListener('resize', schedule)
  schedule()
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
  dirty = false
  characterCount = countVisibleCharacters(content)
  if (editorView) setEditorContent(editorView, content)
  updateChrome()
  previewChunkMapInvalid = true
  queuePreview('canonical')
  scheduleMathErrors()
}

async function openFile(): Promise<void> {
  await window.lightEditor.openFileInNewWindow()
}

async function newWindow(): Promise<void> {
  await window.lightEditor.newWindow()
}

async function saveFile(silent = false): Promise<boolean> {
  if (!doc.path) return saveFileAs()
  try {
    const content = currentDocumentContent()
    const result = await window.lightEditor.saveFile(doc.path, content)
    doc.path = result.path
    doc.savedContent = content
    doc.externalModifiedAt = result.mtimeMs
    dirty = false
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

function exportName(extension: 'html' | 'pdf'): string {
  const name = basename(doc.path)
  return /\.(?:md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/iu.test(name)
    ? name.replace(/\.[^.]+$/u, `.${extension}`)
    : `${name}.${extension}`
}

async function exportHtml(): Promise<void> {
  try {
    const target = await window.lightEditor.exportHtml(
      currentDocumentContent(),
      dirname(doc.path),
      exportName('html')
    )
    if (target) setStatusRight(`已导出 HTML · ${target}`)
  } catch (error) {
    console.error(error)
    window.alert(`导出 HTML 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function exportPdf(): Promise<void> {
  try {
    const target = await window.lightEditor.exportPdf(
      currentDocumentContent(),
      dirname(doc.path),
      exportName('pdf')
    )
    if (target) setStatusRight(`已导出 A4 PDF · ${target}`)
  } catch (error) {
    console.error(error)
    window.alert(`导出 A4 PDF 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function saveFileAs(): Promise<boolean> {
  const target = await window.lightEditor.saveFileDialog(basename(doc.path))
  if (!target) return false
  try {
    const content = currentDocumentContent()
    const result = await window.lightEditor.saveFile(target, content)
    doc.path = result.path
    doc.savedContent = content
    doc.externalModifiedAt = result.mtimeMs
    dirty = false
    updateChrome()
    previewChunkMapInvalid = true
    queuePreview('canonical')
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

async function reloadDocument(): Promise<void> {
  if (!doc.path) {
    window.alert('当前是未命名文档，无法从磁盘重新加载。')
    return
  }
  // Disk reload intentionally discards the editor's in-memory document.
  // Always require explicit confirmation, not only while the dirty marker shows.
  const confirmed = await window.lightEditor.confirmDocumentReload(doc.path)
  if (!confirmed) return
  try {
    const result = await window.lightEditor.readFile(doc.path)
    applyOpenedFile(result.path, result.content, result.lineEnding, result.mtimeMs)
    setStatusRight('已从磁盘重新加载')
  } catch (error) {
    console.error(error)
    window.alert(`重新加载失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function handleExternalChange(filePath: string): Promise<void> {
  if (!doc.path || filePath !== doc.path) return
  const reload = await window.lightEditor.confirmReload(filePath)
  if (!reload) return
  const result = await window.lightEditor.readFile(filePath)
  applyOpenedFile(result.path, result.content, result.lineEnding, result.mtimeMs)
}

async function bootstrap(): Promise<void> {
  // Resolve the launch target before creating CodeMirror/preview. Previously the
  // WELCOME document was rendered first and then replaced asynchronously, which
  // caused a visible template flash whenever a concrete .md file was opened.
  const [rawConfig, pending] = await Promise.all([
    window.lightEditor.getConfig(),
    window.lightEditor.takePendingOpen()
  ])
  config = normalizeConfig(rawConfig)
  splitRatio = config.splitRatio || 0.5
  applyAppearanceToDom(config)

  let initialOpenError: unknown = null
  if (pending) {
    try {
      const result = await window.lightEditor.bindPath(pending)
      doc = {
        path: result.path,
        content: result.content,
        savedContent: result.content,
        encoding: 'utf-8',
        lineEnding: result.lineEnding,
        externalModifiedAt: result.mtimeMs
      }
      characterCount = countVisibleCharacters(result.content)
    } catch (error) {
      initialOpenError = error
      console.error('Failed to open launch target', error)
    }
  }

  renderShell()
  if (initialOpenError) {
    window.alert(
      `打开文件失败：${initialOpenError instanceof Error ? initialOpenError.message : String(initialOpenError)}`
    )
  }

  settings = createSettingsPanel({
    getConfig: () => config,
    onChange: async (partial) => {
      await updateConfig(partial)
    }
  })

  window.lightEditor.onMenuOpen(() => void openFile())
  window.lightEditor.onMenuSave(() => void saveFile())
  window.lightEditor.onMenuSaveAs(() => void saveFileAs())
  window.lightEditor.onMenuExportHtml(() => void exportHtml())
  window.lightEditor.onMenuExportPdf(() => void exportPdf())
  window.lightEditor.onMenuReloadDocument(() => void reloadDocument())
  window.lightEditor.onPreviewReloaded(() => {
    // The isolated preview has discarded all KaTeX/DOM state, so any old ACK
    // can no longer release our gate. Reissue a full render from current CM text.
    previewRenderInFlight = false
    previewInFlightRequestId = null
    pendingPreviewRequest = null
    previewChunkMapInvalid = true
    queuePreview('canonical')
  })
  window.lightEditor.onMenuToggleTheme(() => void toggleTheme())
  window.lightEditor.onMenuSetTheme((theme) => {
    void updateConfig({ theme })
  })
  window.lightEditor.onMenuFind(() => openFind())
  window.lightEditor.onMenuReplace(() => openReplace())
  window.lightEditor.onMenuCheckMath(() => checkMathNow())
  window.lightEditor.onMenuSettings(() => openSettings())
  window.lightEditor.onExternalChange((filePath) => void handleExternalChange(filePath))
  window.lightEditor.onCloseRequest(() => {
    void handleCloseRequest()
  })
  window.lightEditor.onZoomChanged((percent) => {
    setZoomPercent(percent)
  })
  window.lightEditor.onPreviewRenderComplete((result) => {
    // Ignore stale/duplicate ACKs; only the request currently in flight may
    // release the gate. This protects against preview reloads and IPC replay.
    if (!previewRenderInFlight || result.requestId !== previewInFlightRequestId) return
    previewRenderInFlight = false
    previewInFlightRequestId = null
    // Only a successful canonical completion establishes a trustworthy map.
    if (result.ok && result.mode === 'canonical' && result.version === documentVersion) {
      previewChunkMapInvalid = false
    }
    flushPendingPreview()
  })

  // Sync initial zoom percent into status bar
  void window.lightEditor.zoom('get').then((p) => setZoomPercent(p))

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
