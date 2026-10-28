export interface WindowBounds {
  width: number
  height: number
  x?: number
  y?: number
}

/**
 * App-level settings stored in %APPDATA%/light-katex-editor/config.json
 * (never written next to Markdown files).
 */
export interface AppConfig {
  recentFiles: string[]
  windowBounds: WindowBounds
  splitRatio: number
  theme: 'light' | 'dark'
  /** @deprecated prefer editorFontSize; kept for older config files */
  fontSize: number
  editorFontSize: number
  previewFontSize: number
  /** CSS font-family stack for source pane */
  editorFontFamily: string
  /** CSS font-family stack for preview body */
  previewFontFamily: string
  editorLineHeight: number
  /** Lightweight mathematical Markdown colors in the source pane. */
  sourceColoring: boolean
  previewLineHeight: number
  /** @deprecated Legacy config key; normalized to 0. Both panes always fill available width. */
  previewMaxWidth: number
  /** When true, Ctrl+= / Ctrl+- also scales preview font size. */
  linkFontSizes: boolean
  /** Run full-document KaTeX diagnostics after each edit pause. */
  liveMathCheck: boolean
  autoSave: boolean
}

export interface DocumentState {
  path: string | null
  content: string
  savedContent: string
  encoding: 'utf-8'
  lineEnding: 'lf' | 'crlf'
  externalModifiedAt: number
}

export interface OpenFileResult {
  path: string
  content: string
  encoding: 'utf-8'
  lineEnding: 'lf' | 'crlf'
  mtimeMs: number
}

export interface SaveFileResult {
  path: string
  mtimeMs: number
}

/** Appearance properties consumed by the isolated preview WebContentsView. */
export interface PreviewAppearance {
  theme: 'light' | 'dark'
  fontFamily: string
  fontSize: number
  lineHeight: number
}

/** A conservative editor-side hint for one safe same-line source edit. */
export interface PreviewLocalEditHint {
  /** 1-based inclusive source line range in the current document. */
  fromLine: number
  toLine: number
}

/** Host → isolated preview render payload. Source remains the single truth. */
export interface PreviewRenderRequest {
  /** Monotonic IPC request identity; distinct from document version. */
  requestId: number
  version: number
  source: string
  baseDir: string | null
  /** Canonical is a full-document semantic rebuild; local updates one safe island. */
  mode: 'canonical' | 'local'
  /** Present only for a conservative local fast-path request. */
  localEdit?: PreviewLocalEditHint
}

export interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** One-shot request to serialize Preview's canonical rendering as standalone HTML. */
export interface PreviewHtmlExportRequest {
  requestId: number
  source: string
  baseDir: string | null
  title: string
}

export interface PreviewHtmlExportResult {
  requestId: number
  html: string
}

/** Completion acknowledgement emitted by the isolated preview renderer. */
export interface PreviewRenderComplete {
  requestId: number
  version: number
  mode: 'canonical' | 'local'
  /** False means Preview caught an error; caller must release its single-flight gate. */
  ok: boolean
}

export interface LightEditorApi {
  getConfig: () => Promise<AppConfig>
  setConfig: (partial: Partial<AppConfig>) => Promise<AppConfig>
  /** Creates the user preview CSS file if needed and reveals it in Explorer. */
  openCustomPreviewCss: () => Promise<string>
  /** Render the current document as a self-contained HTML file. */
  exportHtml: (source: string, baseDir: string | null, suggestedName: string) => Promise<string | null>
  /** Export the current document as a fixed-layout A4 PDF. */
  exportPdf: (source: string, baseDir: string | null, suggestedName: string) => Promise<string | null>
  /** Open file picker and always open the file in a new window. */
  openFileInNewWindow: () => Promise<string | null>
  newWindow: () => Promise<boolean>
  saveFileDialog: (suggestedName?: string) => Promise<string | null>
  bindPath: (filePath: string) => Promise<OpenFileResult>
  saveFile: (filePath: string, content: string) => Promise<SaveFileResult>
  readFile: (filePath: string) => Promise<OpenFileResult>
  confirmReload: (filePath: string) => Promise<boolean>
  confirmDocumentReload: (filePath: string) => Promise<boolean>
  confirmDiscard: () => Promise<'save' | 'discard' | 'cancel'>
  takePendingOpen: () => Promise<string | null>
  forceClose: () => Promise<boolean>
  setDirty: (dirty: boolean) => Promise<boolean>
  onCloseRequest: (handler: () => void) => () => void
  onMenuOpen: (handler: () => void) => () => void
  onMenuSave: (handler: () => void) => () => void
  onMenuSaveAs: (handler: () => void) => () => void
  onMenuExportHtml: (handler: () => void) => () => void
  onMenuExportPdf: (handler: () => void) => () => void
  onMenuReloadDocument: (handler: () => void) => () => void
  /** Preview WebContents was restarted; canonical-render the current source. */
  onPreviewReloaded: (handler: () => void) => () => void
  onMenuToggleTheme: (handler: () => void) => () => void
  onMenuSetTheme: (handler: (theme: 'light' | 'dark') => void) => () => void
  onMenuFind: (handler: () => void) => () => void
  onMenuReplace: (handler: () => void) => () => void
  onMenuCheckMath: (handler: () => void) => () => void
  onMenuUndo: (handler: () => void) => () => void
  onMenuRedo: (handler: () => void) => () => void
  onMenuFormat: (handler: (action: string) => void) => () => void
  onMenuViewMode: (handler: (mode: 'editor' | 'split' | 'preview') => void) => () => void
  onMenuSettings: (handler: () => void) => () => void
  onExternalChange: (handler: (filePath: string) => void) => () => void
  popupMenu: (menuLabel: string, x: number, y: number) => Promise<boolean>
  setTitleBarTheme: (theme: 'light' | 'dark') => Promise<boolean>
  zoom: (action: 'in' | 'out' | 'reset' | 'get') => Promise<number>
  onZoomChanged: (handler: (percent: number) => void) => () => void
  /** Host layout/content bridge to the isolated right-hand preview view. */
  setPreviewBounds: (bounds: PreviewBounds) => void
  updatePreview: (request: PreviewRenderRequest) => void
  setPreviewAppearance: (appearance: PreviewAppearance) => void
  /** Hide the native Preview WebContentsView while a Renderer modal is open. */
  setPreviewOverlayOpen: (open: boolean) => void
  revealPreviewLine: (line: number) => void
  onPreviewJumpToEditor: (handler: (line: number) => void) => () => void
  onPreviewRenderComplete: (handler: (result: PreviewRenderComplete) => void) => () => void
}

export interface PreviewBridge {
  onRender: (handler: (request: PreviewRenderRequest) => void) => () => void
  onAppearance: (handler: (appearance: PreviewAppearance) => void) => () => void
  onRevealLine: (handler: (line: number) => void) => () => void
  onCustomCss: (handler: (css: string) => void) => () => void
  onExportHtml: (handler: (request: PreviewHtmlExportRequest) => void) => () => void
  exportHtmlResult: (result: PreviewHtmlExportResult) => void
  jumpToEditor: (line: number) => void
  /** Open document links with the OS default app; never navigate Preview away. */
  openLink: (href: string) => Promise<void>
  renderComplete: (result: PreviewRenderComplete) => void
}


declare global {
  interface Window {
    lightEditor: LightEditorApi
  }
}

export {}
