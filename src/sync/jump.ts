import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

export interface SourceRange {
  startLine: number
  endLine: number
  element: HTMLElement
}

const setSourceFlash = StateEffect.define<number | null>()
const sourceFlashMark = Decoration.line({ class: 'cm-source-sync-flash' })

/** Installed once in CodeMirror; effect adds/removes one temporary line mark. */
export const sourceLineFlashExtension: Extension = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setSourceFlash)) continue
      next = effect.value === null
        ? Decoration.none
        : Decoration.set([sourceFlashMark.range(effect.value)])
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

const sourceFlashTimers = new WeakMap<EditorView, number>()

/** Briefly highlight a source line after preview → source navigation. */
export function flashEditorLine(view: EditorView, line: number): void {
  const safeLine = Math.min(Math.max(1, line), view.state.doc.lines)
  const from = view.state.doc.line(safeLine).from
  const oldTimer = sourceFlashTimers.get(view)
  if (oldTimer !== undefined) window.clearTimeout(oldTimer)

  // Clear first so repeated jumps to the same line restart the CSS animation.
  view.dispatch({ effects: setSourceFlash.of(null) })
  window.requestAnimationFrame(() => {
    if (!view.dom.isConnected) return
    view.dispatch({ effects: setSourceFlash.of(from) })
    const timer = window.setTimeout(() => {
      if (view.dom.isConnected) view.dispatch({ effects: setSourceFlash.of(null) })
      sourceFlashTimers.delete(view)
    }, 1200)
    sourceFlashTimers.set(view, timer)
  })
}

function sourceRangeForElement(element: HTMLElement): SourceRange | null {
  const localStart = Number(element.dataset.localSourceLine)
  const section = element.closest<HTMLElement>('[data-preview-section-start-line]')
  if (Number.isFinite(localStart) && section) {
    const sectionStart = Number(section.dataset.previewSectionStartLine)
    const localEnd = Number(element.dataset.localSourceEndLine) || localStart
    if (Number.isFinite(sectionStart) && sectionStart >= 1) {
      const startLine = sectionStart + localStart - 1
      return {
        startLine,
        endLine: Math.max(startLine, sectionStart + localEnd - 1),
        element
      }
    }
  }

  const start = Number(element.dataset.sourceLine)
  const end = Number(element.dataset.sourceEndLine) || start
  if (!Number.isFinite(start) || start < 1) return null
  return { startLine: start, endLine: Number.isFinite(end) && end >= start ? end : start, element }
}

/** Collect all preview anchors and resolve section-local line metadata on demand. */
export function collectPreviewAnchors(previewRoot: HTMLElement): SourceRange[] {
  const nodes = previewRoot.querySelectorAll<HTMLElement>(
    '[data-source-line], [data-local-source-line]'
  )
  const ranges: SourceRange[] = []
  nodes.forEach((element) => {
    const range = sourceRangeForElement(element)
    if (range) ranges.push(range)
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
  const el = target.closest<HTMLElement>('[data-source-line], [data-local-source-line]')
  if (!el || !previewRoot.contains(el)) return null
  return sourceRangeForElement(el)?.startLine ?? null
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
