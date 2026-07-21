import { EditorView } from '@codemirror/view'

export interface SourceRange {
  startLine: number
  endLine: number
  element: HTMLElement
}

/** Collect all preview anchors that carry source-line metadata. */
export function collectPreviewAnchors(previewRoot: HTMLElement): SourceRange[] {
  const nodes = previewRoot.querySelectorAll<HTMLElement>('[data-source-line]')
  const ranges: SourceRange[] = []
  nodes.forEach((element) => {
    const start = Number(element.getAttribute('data-source-line'))
    const end = Number(element.getAttribute('data-source-end-line') || start)
    if (!Number.isFinite(start) || start < 1) return
    ranges.push({
      startLine: start,
      endLine: Number.isFinite(end) && end >= start ? end : start,
      element
    })
  })
  return ranges
}

/** Find the best preview block covering a 1-based source line. Prefer tightest match. */
export function findPreviewForLine(previewRoot: HTMLElement, line: number): HTMLElement | null {
  const ranges = collectPreviewAnchors(previewRoot)
  let best: SourceRange | null = null
  for (const range of ranges) {
    if (line < range.startLine || line > range.endLine) continue
    if (
      !best ||
      range.endLine - range.startLine < best.endLine - best.startLine ||
      (range.endLine - range.startLine === best.endLine - best.startLine &&
        range.startLine > best.startLine)
    ) {
      best = range
    }
  }
  if (best) return best.element

  // Nearest preceding block
  let nearest: SourceRange | null = null
  for (const range of ranges) {
    if (range.startLine <= line) {
      if (!nearest || range.startLine > nearest.startLine) nearest = range
    }
  }
  return nearest?.element ?? null
}

/** From a clicked DOM node, walk up to the nearest source-mapped ancestor. */
export function findSourceLineFromTarget(target: EventTarget | null, previewRoot: HTMLElement): number | null {
  if (!(target instanceof Element)) return null
  const el = target.closest('[data-source-line]')
  if (!el || !previewRoot.contains(el)) return null
  const line = Number(el.getAttribute('data-source-line'))
  return Number.isFinite(line) && line >= 1 ? line : null
}

let flashTimer: number | null = null

export function flashElement(element: HTMLElement): void {
  element.classList.remove('sync-flash')
  // force reflow so animation restarts
  void element.offsetWidth
  element.classList.add('sync-flash')
  if (flashTimer !== null) window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => {
    element.classList.remove('sync-flash')
    flashTimer = null
  }, 1200)
}

/** Jump preview to the block for a 1-based source line. */
export function jumpPreviewToLine(previewRoot: HTMLElement, line: number): boolean {
  const el = findPreviewForLine(previewRoot, line)
  if (!el) return false
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flashElement(el)
  return true
}

/** Jump CodeMirror to a 1-based line and focus. */
export function jumpEditorToLine(view: EditorView, line: number): void {
  const total = view.state.doc.lines
  const safeLine = Math.min(Math.max(1, line), total)
  const lineObj = view.state.doc.line(safeLine)
  view.dispatch({
    selection: { anchor: lineObj.from },
    effects: EditorView.scrollIntoView(lineObj.from, { y: 'center' })
  })
  view.focus()
}
