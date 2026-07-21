/**
 * Simple Markdown wrap shortcuts (source only, no WYSIWYG):
 *   Ctrl+B  **bold**
 *   Ctrl+I  *italic*
 *   Ctrl+`  `code`
 *   Ctrl+Shift+X  ~~strike~~
 *   Ctrl+Shift+K  [link](url)  (selection → link text; URL kept selected if empty)
 */
import { EditorSelection, type ChangeSpec } from '@codemirror/state'
import { type Command, type KeyBinding } from '@codemirror/view'

function wrapSelection(markerOpen: string, markerClose: string = markerOpen): Command {
  return (view) => {
    if (view.state.readOnly) return false
    const changes: ChangeSpec[] = []
    const ranges: { from: number; to: number }[] = []

    for (const range of view.state.selection.ranges) {
      const { from, to } = range
      const openLen = markerOpen.length
      const closeLen = markerClose.length
      const before = view.state.sliceDoc(Math.max(0, from - openLen), from)
      const after = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + closeLen))

      // Already wrapped → unwrap
      if (before === markerOpen && after === markerClose) {
        changes.push(
          { from: from - openLen, to: from, insert: '' },
          { from: to, to: to + closeLen, insert: '' }
        )
        ranges.push({ from: from - openLen, to: to - openLen })
        continue
      }

      // Empty selection → insert markers and put cursor between
      if (from === to) {
        const insert = markerOpen + markerClose
        changes.push({ from, to, insert })
        ranges.push({ from: from + openLen, to: from + openLen })
        continue
      }

      const selected = view.state.sliceDoc(from, to)
      // Selection already includes markers
      if (
        selected.startsWith(markerOpen) &&
        selected.endsWith(markerClose) &&
        selected.length >= openLen + closeLen
      ) {
        const inner = selected.slice(openLen, selected.length - closeLen)
        changes.push({ from, to, insert: inner })
        ranges.push({ from, to: from + inner.length })
        continue
      }

      changes.push({ from, to, insert: markerOpen + selected + markerClose })
      ranges.push({ from: from + openLen, to: to + openLen })
    }

    if (!changes.length) return false
    view.dispatch({
      changes,
      selection: EditorSelection.create(
        ranges.map((r) => EditorSelection.range(r.from, r.to)),
        view.state.selection.mainIndex
      ),
      userEvent: 'input'
    })
    return true
  }
}

/** Wrap as [text](url) — if empty selection, insert [text](url) with "text" selected. */
const wrapLink: Command = (view) => {
  if (view.state.readOnly) return false
  const changes: ChangeSpec[] = []
  const ranges: { from: number; to: number }[] = []

  for (const range of view.state.selection.ranges) {
    const { from, to } = range
    if (from === to) {
      const insert = '[text](url)'
      changes.push({ from, to, insert })
      ranges.push({ from: from + 1, to: from + 5 }) // select "text"
      continue
    }
    const selected = view.state.sliceDoc(from, to)
    // Already a markdown link — leave as-is (toggle off not worth complexity)
    if (/^\[[^\]]*\]\([^)]*\)$/.test(selected)) {
      ranges.push({ from, to })
      continue
    }
    const insert = `[${selected}](url)`
    changes.push({ from, to, insert })
    const urlFrom = from + 1 + selected.length + 2 // after "]("
    ranges.push({ from: urlFrom, to: urlFrom + 3 }) // select "url"
  }

  view.dispatch({
    changes,
    selection: EditorSelection.create(
      ranges.map((r) => EditorSelection.range(r.from, r.to)),
      view.state.selection.mainIndex
    ),
    userEvent: 'input'
  })
  return true
}

export const markdownFormatKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: wrapSelection('**') },
  { key: 'Mod-i', run: wrapSelection('*') },
  { key: 'Mod-`', run: wrapSelection('`') },
  { key: 'Mod-Shift-x', run: wrapSelection('~~') },
  { key: 'Mod-Shift-k', run: wrapLink }
]
