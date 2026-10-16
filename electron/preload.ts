import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  OpenFileResult,
  PreviewAppearance,
  PreviewBounds,
  PreviewRenderComplete,
  PreviewRenderRequest,
  SaveFileResult
} from '../src/shared/types'

function onChannel(channel: string, handler: () => void): () => void {
  const listener = () => handler()
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (partial: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke('config:set', partial),
  openCustomPreviewCss: (): Promise<string> => ipcRenderer.invoke('preview:open-custom-css'),
  exportHtml: (source: string, baseDir: string | null, suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('export:html', source, baseDir, suggestedName),
  exportPdf: (source: string, baseDir: string | null, suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('export:pdf', source, baseDir, suggestedName),

  /** Always opens the chosen file in a new window (one document per window). */
  openFileInNewWindow: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:open-file-new-window'),

  newWindow: (): Promise<boolean> => ipcRenderer.invoke('window:new'),

  saveFileDialog: (suggestedName?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:save-file', suggestedName),

  /** Bind/load a file into THIS window (used by pending open / reload / save-as). */
  bindPath: (filePath: string): Promise<OpenFileResult> =>
    ipcRenderer.invoke('file:bind-path', filePath),

  saveFile: (filePath: string, content: string): Promise<SaveFileResult> =>
    ipcRenderer.invoke('file:save', filePath, content),

  readFile: (filePath: string): Promise<OpenFileResult> =>
    ipcRenderer.invoke('file:read', filePath),

  confirmReload: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirm-reload', filePath),
  confirmDocumentReload: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirm-document-reload', filePath),
  confirmDiscard: (): Promise<'save' | 'discard' | 'cancel'> =>
    ipcRenderer.invoke('dialog:confirm-discard'),

  takePendingOpen: (): Promise<string | null> =>
    ipcRenderer.invoke('file:take-pending-open'),

  /** After unsaved prompt is resolved (or doc is clean), allow main to close the window. */
  forceClose: (): Promise<boolean> => ipcRenderer.invoke('window:force-close'),

  /** Keep main process in sync for close-gate (dirty title / close dialog). */
  setDirty: (dirty: boolean): Promise<boolean> => ipcRenderer.invoke('window:set-dirty', dirty),

  onCloseRequest: (handler: () => void): (() => void) => onChannel('window:close-request', handler),

  onMenuOpen: (handler: () => void): (() => void) => onChannel('menu:open', handler),
  onMenuSave: (handler: () => void): (() => void) => onChannel('menu:save', handler),
  onMenuSaveAs: (handler: () => void): (() => void) => onChannel('menu:save-as', handler),
  onMenuExportHtml: (handler: () => void): (() => void) => onChannel('menu:export-html', handler),
  onMenuExportPdf: (handler: () => void): (() => void) => onChannel('menu:export-pdf', handler),
  onMenuReloadDocument: (handler: () => void): (() => void) => onChannel('menu:reload-document', handler),
  onPreviewReloaded: (handler: () => void): (() => void) => onChannel('preview:reloaded', handler),
  onMenuToggleTheme: (handler: () => void): (() => void) =>
    onChannel('menu:toggle-theme', handler),
  onMenuSetTheme: (handler: (theme: 'light' | 'dark') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark') => handler(theme)
    ipcRenderer.on('menu:set-theme', listener)
    return () => ipcRenderer.removeListener('menu:set-theme', listener)
  },
  onMenuFind: (handler: () => void): (() => void) => onChannel('menu:find', handler),
  onMenuReplace: (handler: () => void): (() => void) => onChannel('menu:replace', handler),
  onMenuCheckMath: (handler: () => void): (() => void) => onChannel('menu:check-math', handler),
  onMenuUndo: (handler: () => void): (() => void) => onChannel('menu:undo', handler),
  onMenuRedo: (handler: () => void): (() => void) => onChannel('menu:redo', handler),
  onMenuFormat: (handler: (action: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: string) => handler(action)
    ipcRenderer.on('menu:format', listener)
    return () => ipcRenderer.removeListener('menu:format', listener)
  },
  onMenuViewMode: (handler: (mode: 'editor' | 'split' | 'preview') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: 'editor' | 'split' | 'preview') => handler(mode)
    ipcRenderer.on('menu:view-mode', listener)
    return () => ipcRenderer.removeListener('menu:view-mode', listener)
  },
  onMenuSettings: (handler: () => void): (() => void) => onChannel('menu:settings', handler),
  onExternalChange: (handler: (filePath: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, filePath: string) => handler(filePath)
    ipcRenderer.on('file:external-change', listener)
    return () => ipcRenderer.removeListener('file:external-change', listener)
  },

  /** Popup a top-level application submenu (文件/编辑/查看/设置) at screen coords. */
  popupMenu: (menuLabel: string, x: number, y: number): Promise<boolean> =>
    ipcRenderer.invoke('menu:popup', menuLabel, x, y),

  setTitleBarTheme: (theme: 'light' | 'dark'): Promise<boolean> =>
    ipcRenderer.invoke('window:set-titlebar-theme', theme),

  /** View zoom percent: 50–300, step 10. */
  zoom: (action: 'in' | 'out' | 'reset' | 'get'): Promise<number> =>
    ipcRenderer.invoke('window:zoom', action),

  onZoomChanged: (handler: (percent: number) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, percent: number) => handler(percent)
    ipcRenderer.on('window:zoom-changed', listener)
    return () => ipcRenderer.removeListener('window:zoom-changed', listener)
  },

  setPreviewBounds: (bounds: PreviewBounds): void => {
    ipcRenderer.send('preview:set-bounds', bounds)
  },
  updatePreview: (request: PreviewRenderRequest): void => {
    ipcRenderer.send('preview:render', request)
  },
  setPreviewAppearance: (appearance: PreviewAppearance): void => {
    ipcRenderer.send('preview:appearance', appearance)
  },
  setPreviewOverlayOpen: (open: boolean): void => {
    ipcRenderer.send('preview:set-overlay-open', Boolean(open))
  },
  revealPreviewLine: (line: number): void => {
    ipcRenderer.send('preview:reveal-line', line)
  },
  onPreviewJumpToEditor: (handler: (line: number) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, line: number) => handler(line)
    ipcRenderer.on('preview:jump-to-editor', listener)
    return () => ipcRenderer.removeListener('preview:jump-to-editor', listener)
  },
  onPreviewRenderComplete: (handler: (result: PreviewRenderComplete) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: PreviewRenderComplete) => handler(result)
    ipcRenderer.on('preview:render-complete', listener)
    return () => ipcRenderer.removeListener('preview:render-complete', listener)
  }
}



contextBridge.exposeInMainWorld('lightEditor', api)

export type LightEditorApi = typeof api
