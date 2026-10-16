import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type DocumentLinkTarget =
  | { kind: 'file'; path: string; needsConfirmation: boolean }
  | { kind: 'external'; url: string }

/** No arbitrary shell protocol handlers or command-line interpolation. */
export function documentLinkTarget(href: unknown): DocumentLinkTarget {
  if (typeof href !== 'string' || !href || href.length > 32768) throw new Error('无效的链接')
  const url = new URL(href)
  if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
    return { kind: 'external', url: url.href }
  }
  if (url.protocol !== 'file:') throw new Error('不支持此链接类型')
  // Node handles Windows drive letters, UNC and percent decoding exactly once.
  const filePath = fileURLToPath(url)
  if (filePath.includes(String.fromCharCode(0)) || !path.isAbsolute(filePath)) throw new Error('无效的本地路径')
  const extension = path.extname(filePath.replace(/[. ]+$/, '')).toLowerCase()
  const executable = new Set([
    '.exe', '.com', '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.jse',
    '.wsf', '.wsh', '.msi', '.msp', '.scr', '.hta', '.lnk', '.url', '.reg',
    '.cpl', '.msc', '.pif', '.scf', '.sct', '.inf', '.application', '.appref-ms',
    '.gadget', '.psm1', '.psd1', '.py', '.pyw', '.pyc', '.pyo', '.pyz', '.pyzw',
    '.pl', '.rb', '.jar', '.app', '.command', '.sh', '.desktop'
  ])
  return { kind: 'file', path: filePath, needsConfirmation: executable.has(extension) }
}
