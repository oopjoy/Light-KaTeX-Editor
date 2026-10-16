import { contextBridge, ipcRenderer } from 'electron'
import type {
  PreviewAppearance,
  PreviewBridge,
  PreviewHtmlExportRequest,
  PreviewHtmlExportResult,
  PreviewRenderComplete,
  PreviewRenderRequest
} from '../src/shared/types'

function onChannel<T>(channel: string, handler: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => handler(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const previewBridge: PreviewBridge = {
  onRender: (handler: (request: PreviewRenderRequest) => void): (() => void) =>
    onChannel('preview:render', handler),
  onAppearance: (handler: (appearance: PreviewAppearance) => void): (() => void) =>
    onChannel('preview:appearance', handler),
  onRevealLine: (handler: (line: number) => void): (() => void) =>
    onChannel('preview:reveal-line', handler),
  onCustomCss: (handler: (css: string) => void): (() => void) =>
    onChannel('preview:custom-css', handler),
  onExportHtml: (handler: (request: PreviewHtmlExportRequest) => void): (() => void) =>
    onChannel('preview:export-html', handler),
  exportHtmlResult: (result: PreviewHtmlExportResult): void => {
    ipcRenderer.send('preview:export-html-result', result)
  },
  jumpToEditor: (line: number): void => {
    ipcRenderer.send('preview:jump-to-editor', line)
  },
  openLink: (href: string): Promise<void> => ipcRenderer.invoke('preview:open-link', href),
  renderComplete: (result: PreviewRenderComplete): void => {
    ipcRenderer.send('preview:render-complete', result)
  }
}

contextBridge.exposeInMainWorld('lightPreview', previewBridge)
