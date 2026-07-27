import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'
import './preview-styles.css'

import morphdom from 'morphdom'
import { buildPreviewRenderPlan, renderMarkdown, type PreviewRenderChunk } from './markdown/render'
import type {
  PreviewAppearance,
  PreviewHtmlExportRequest,
  PreviewRenderRequest
} from './shared/types'

const previewRoot = document.getElementById('preview-root')
if (!previewRoot) throw new Error('#preview-root missing')
const root: HTMLElement = previewRoot

let lastRequestId = -1
let canonicalSource = ''
let canonicalBaseDir: string | null = null
let renderChunks: PreviewRenderChunk[] = []
/** Global document features that make a standalone section semantically unsafe. */
let localRenderingDisabled = false
let flashTimer: number | null = null

function applyCustomCss(css: string): void {
  let style = document.getElementById('user-preview-css') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'user-preview-css'
    document.head.appendChild(style)
  }
  style.textContent = css
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function exportedStyleText(): string {
  let css = ''
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      css += `${Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n')}\n`
    } catch {
      // All export stylesheets are local app assets. Keep export usable if a
      // browser ever rejects an individual sheet's cssRules access.
    }
  }
  return css
}

function exportHtml(request: PreviewHtmlExportRequest): void {
  try {
    const content = renderMarkdown(request.source, request.baseDir)
    const theme = document.documentElement.dataset.theme ?? 'light'
    const appearanceStyle = document.documentElement.getAttribute('style') ?? ''
    const html = `<!doctype html>
<html lang="zh-CN" data-theme="${escapeHtml(theme)}" style="${escapeHtml(appearanceStyle)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(request.title)}</title>
<style>
${exportedStyleText()}
</style>
</head>
<body>
<main id="preview-root" class="preview-root" aria-label="Markdown 预览">${content}</main>
</body>
</html>`
    window.lightPreview.exportHtmlResult({ requestId: request.requestId, html })
  } catch (error) {
    console.error('HTML export render failed', error)
    window.lightPreview.exportHtmlResult({ requestId: request.requestId, html: '' })
  }
}

function applyAppearance(appearance: PreviewAppearance): void {
  const html = document.documentElement
  html.dataset.theme = appearance.theme
  html.style.setProperty('--preview-font', appearance.fontFamily)
  html.style.setProperty('--preview-font-size', `${appearance.fontSize}px`)
  html.style.setProperty('--preview-line-height', String(appearance.lineHeight))
  html.style.setProperty('--preview-max-width', appearance.maxWidth > 0 ? `${appearance.maxWidth}px` : 'none')
}

function lineForTarget(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null
  const element = target.closest<HTMLElement>('[data-source-line]')
  if (!element || !root.contains(element)) return null
  const line = Number(element.dataset.sourceLine)
  return Number.isFinite(line) && line >= 1 ? line : null
}

function flash(element: HTMLElement): void {
  element.classList.remove('sync-flash')
  void element.offsetWidth
  element.classList.add('sync-flash')
  if (flashTimer !== null) window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => {
    element.classList.remove('sync-flash')
    flashTimer = null
  }, 1200)
}

function revealLine(line: number): void {
  const nodes = root.querySelectorAll<HTMLElement>('[data-source-line]')
  let covering: HTMLElement | null = null
  let preceding: HTMLElement | null = null
  for (const node of nodes) {
    const start = Number(node.dataset.sourceLine)
    const end = Number(node.dataset.sourceEndLine) || start
    if (!Number.isFinite(start)) continue
    if (line >= start && line <= end) {
      if (!covering || end - start < (Number(covering.dataset.sourceEndLine) || Number(covering.dataset.sourceLine)) - Number(covering.dataset.sourceLine)) {
        covering = node
      }
    }
    if (start <= line && (!preceding || start > Number(preceding.dataset.sourceLine))) preceding = node
  }
  const target = covering ?? preceding
  if (!target) return
  target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flash(target)
}

function equivalent(a: Element, b: Element): boolean {
  if (a.tagName !== b.tagName || a.attributes.length !== b.attributes.length) return false
  for (const attr of Array.from(a.attributes)) {
    if (b.getAttribute(attr.name) !== attr.value) return false
  }
  if (a.children.length !== b.children.length) return false
  for (let i = 0; i < a.children.length; i += 1) {
    if (!equivalent(a.children[i], b.children[i])) return false
  }
  return a.textContent === b.textContent
}

function sourceLineForNode(node: Node): number | null {
  if (!(node instanceof HTMLElement)) return null
  const line = Number(node.dataset.sourceLine)
  return Number.isFinite(line) && line >= 1 ? line : null
}

function chunkIndexForLine(chunks: PreviewRenderChunk[], line: number): number | null {
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    if (line >= chunk.startLine && line <= chunk.endLine) return index
  }
  return null
}

function createChunkWrapper(doc: Document, chunk: PreviewRenderChunk): HTMLElement {
  const wrapper = doc.createElement('div')
  wrapper.className = 'preview-chunk'
  wrapper.dataset.previewChunkId = chunk.id
  wrapper.dataset.previewChunkStartLine = String(chunk.startLine)
  wrapper.dataset.previewChunkEndLine = String(chunk.endLine)
  return wrapper
}

/**
 * The canonical HTML was rendered from the complete document. We merely group
 * its already-correct top-level DOM nodes under lightweight chunk wrappers.
 */
function wrapCanonicalChunks(nextRoot: HTMLElement, chunks: PreviewRenderChunk[]): void {
  const wrappers = chunks.map((chunk) => createChunkWrapper(nextRoot.ownerDocument, chunk))
  const originalNodes = Array.from(nextRoot.childNodes)
  let currentIndex = 0

  for (const node of originalNodes) {
    const line = sourceLineForNode(node)
    if (line !== null) {
      const found = chunkIndexForLine(chunks, line)
      if (found !== null) currentIndex = found
    }
    wrappers[currentIndex]?.appendChild(node)
  }

  nextRoot.replaceChildren(...wrappers)
}

function canonicalRender(request: PreviewRenderRequest): void {
  const html = renderMarkdown(request.source, request.baseDir)
  const parsed = new DOMParser().parseFromString(
    `<main id="preview-root" class="preview-root">${html}</main>`,
    'text/html'
  )
  const nextRoot = parsed.getElementById('preview-root')
  if (!(nextRoot instanceof HTMLElement)) return

  const plan = buildPreviewRenderPlan(request.source)
  wrapCanonicalChunks(nextRoot, plan.chunks)
  morphdom(root, nextRoot, {
    childrenOnly: true,
    onBeforeElUpdated(from, to) {
      // Whole-document diff is deliberately low-frequency. Keep unchanged
      // KaTeX and Markdown subtrees intact when equality is proven.
      return !equivalent(from, to)
    }
  })
  canonicalSource = request.source
  canonicalBaseDir = request.baseDir
  renderChunks = plan.chunks
  // Conservative by design: a false positive only uses canonical rendering.
  localRenderingDisabled = plan.hasTopLevelHtmlBlock || /(?:^|\n)\s*\[[^\]]+\]:/u.test(request.source)
}

function chunkCoveringEdit(fromLine: number, toLine: number): PreviewRenderChunk | null {
  return renderChunks.find(
    (chunk) => fromLine >= chunk.startLine && toLine <= chunk.endLine
  ) ?? null
}

function sourceLines(source: string, startLine: number, endLine: number): string | null {
  const lines = source.split('\n')
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return null
  return lines.slice(startLine - 1, endLine).join('\n')
}

function wrapperForChunk(chunk: PreviewRenderChunk): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-preview-chunk-id="${chunk.id}"]`)
}

function localRender(request: PreviewRenderRequest): boolean {
  if (
    !request.localEdit || !canonicalSource ||
    canonicalBaseDir !== request.baseDir || localRenderingDisabled
  ) return false
  const chunk = chunkCoveringEdit(request.localEdit.fromLine, request.localEdit.toLine)
  if (!chunk) return false

  // Editor currently limits local requests to edits without a newline or block
  // marker, so source spans after this chunk retain their canonical line map.
  const source = sourceLines(request.source, chunk.startLine, chunk.endLine)
  const wrapper = wrapperForChunk(chunk)
  if (source === null || !wrapper) return false

  const html = renderMarkdown(source, request.baseDir, chunk.startLine - 1)
  const parsed = new DOMParser().parseFromString('<div id="local-root"></div>', 'text/html')
  const localRoot = parsed.getElementById('local-root')
  if (!(localRoot instanceof HTMLElement)) return false
  const replacement = createChunkWrapper(parsed, chunk)
  replacement.innerHTML = html
  localRoot.appendChild(replacement)

  morphdom(wrapper, replacement, {
    onBeforeElUpdated(from, to) {
      return !equivalent(from, to)
    }
  })
  return true
}

function render(request: PreviewRenderRequest): void {
  if (request.requestId <= lastRequestId) {
    // Appearance changes and preview reload recovery can replay an IPC request
    // this renderer already applied. ACK it without repeating Markdown/KaTeX.
    window.lightPreview.renderComplete({
      requestId: request.requestId,
      version: request.version,
      mode: request.mode,
      ok: true
    })
    return
  }
  try {
    if (request.mode === 'local' && localRender(request)) {
      lastRequestId = request.requestId
      window.lightPreview.renderComplete({
        requestId: request.requestId,
        version: request.version,
        mode: 'local',
        ok: true
      })
      return
    }
    // A rejected local request deliberately falls back to canonical rendering:
    // correctness wins over a guessed partial Markdown interpretation.
    canonicalRender(request)
    lastRequestId = request.requestId
    window.lightPreview.renderComplete({
      requestId: request.requestId,
      version: request.version,
      mode: 'canonical',
      ok: true
    })
  } catch (error) {
    console.error('Preview render failed', error)
    // Release editor-side single-flight scheduling even if malformed Markdown,
    // a third-party renderer, or DOM work unexpectedly throws. Keep request ID
    // unchanged so the same request may be retried later.
    window.lightPreview.renderComplete({
      requestId: request.requestId,
      version: request.version,
      mode: request.mode,
      ok: false
    })
  }
}

root.addEventListener('dblclick', (event) => {
  const target = event.target
  if (target instanceof HTMLElement && target.closest('a, button, input, textarea, select, label')) return
  const line = lineForTarget(target)
  if (line === null) return
  event.preventDefault()
  window.lightPreview.jumpToEditor(line)
})

window.lightPreview.onAppearance(applyAppearance)
window.lightPreview.onCustomCss(applyCustomCss)
window.lightPreview.onExportHtml(exportHtml)
window.lightPreview.onRender(render)
window.lightPreview.onRevealLine(revealLine)
