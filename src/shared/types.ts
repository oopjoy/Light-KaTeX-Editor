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
  previewLineHeight: number
  /**
   * Preview content max width in px.
   * 0 = fill the whole preview pane (no artificial column).
   */
  previewMaxWidth: number
  /** When true, Ctrl+= / Ctrl+- also scales preview font size. */
  linkFontSizes: boolean
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

export interface LightEditorApi {
  getConfig: () => Promise<AppConfig>
  setConfig: (partial: Partial<AppConfig>) => Promise<AppConfig>
  /** Open file picker and always open the file in a new window. */
  openFileInNewWindow: () => Promise<string | null>
  newWindow: () => Promise<boolean>
  saveFileDialog: (suggestedName?: string) => Promise<string | null>
  bindPath: (filePath: string) => Promise<OpenFileResult>
  saveFile: (filePath: string, content: string) => Promise<SaveFileResult>
  readFile: (filePath: string) => Promise<OpenFileResult>
  confirmReload: (filePath: string) => Promise<boolean>
  confirmDiscard: () => Promise<'save' | 'discard' | 'cancel'>
  takePendingOpen: () => Promise<string | null>
  forceClose: () => Promise<boolean>
  setDirty: (dirty: boolean) => Promise<boolean>
  onCloseRequest: (handler: () => void) => () => void
  onMenuOpen: (handler: () => void) => () => void
  onMenuSave: (handler: () => void) => () => void
  onMenuSaveAs: (handler: () => void) => () => void
  onMenuToggleTheme: (handler: () => void) => () => void
  onMenuSetTheme: (handler: (theme: 'light' | 'dark') => void) => () => void
  onMenuFind: (handler: () => void) => () => void
  onMenuReplace: (handler: () => void) => () => void
  onMenuSettings: (handler: () => void) => () => void
  onExternalChange: (handler: (filePath: string) => void) => () => void
  popupMenu: (menuLabel: string, x: number, y: number) => Promise<boolean>
  setTitleBarTheme: (theme: 'light' | 'dark') => Promise<boolean>
  zoom: (action: 'in' | 'out' | 'reset' | 'get') => Promise<number>
  onZoomChanged: (handler: (percent: number) => void) => () => void
}


declare global {
  interface Window {
    lightEditor: LightEditorApi
  }
}

export {}
