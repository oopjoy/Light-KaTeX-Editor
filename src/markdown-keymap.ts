/**
 * Simple Markdown wrap shortcuts (source only, no WYSIWYG):
 *   Ctrl+B  **bold**
 *   Ctrl+I  *italic*
 *   Ctrl+`  `code`
 *   Ctrl+Shift+X  ~~strike~~
 *   Ctrl+Shift+K  [link](url)  (selection → link text; URL kept selected if empty)
 */
import { EditorSelection, type ChangeSpec } from '@codemirror/state'
import { EditorView, type Command, type KeyBinding } from '@codemirror/view'

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

const wrapImage: Command = (view) => {
  if (view.state.readOnly) return false
  const changes: ChangeSpec[] = []
  const ranges: { from: number; to: number }[] = []
  for (const range of view.state.selection.ranges) {
    const { from, to } = range
    const selected = view.state.sliceDoc(from, to)
    const alt = selected || 'alt'
    const insert = `![${alt}](url)`
    changes.push({ from, to, insert })
    ranges.push({ from: from + 2, to: from + 2 + alt.length })
  }
  view.dispatch({
    changes,
    selection: EditorSelection.create(
      ranges.map((range) => EditorSelection.range(range.from, range.to)),
      view.state.selection.mainIndex
    ),
    userEvent: 'input.format'
  })
  return true
}

export type MarkdownFormatAction =
  | 'bold'
  | 'italic'
  | 'code'
  | 'link'
  | 'image'
  | 'quote'
  | 'bullet-list'
  | 'ordered-list'
  | 'heading'
  | 'inline-math'
  | 'display-math'

function prefixSelectedLines(view: EditorView, prefix: string): boolean {
  if (view.state.readOnly) return false
  const ranges = view.state.selection.ranges
  const changes: ChangeSpec[] = []
  const selections: { from: number; to: number }[] = []
  const seen = new Set<number>()
  for (const range of ranges) {
    const first = view.state.doc.lineAt(range.from)
    const last = view.state.doc.lineAt(range.to)
    for (let lineNo = first.number; lineNo <= last.number; lineNo += 1) {
      if (seen.has(lineNo)) continue
      seen.add(lineNo)
      const line = view.state.doc.line(lineNo)
      changes.push({ from: line.from, to: line.from, insert: prefix })
    }
    selections.push({
      from: range.from + prefix.length,
      to: range.to + prefix.length * (last.number - first.number + 1)
    })
  }
  if (!changes.length) return false
  view.dispatch({
    changes,
    selection: EditorSelection.create(
      selections.map((range) => EditorSelection.range(range.from, range.to)),
      view.state.selection.mainIndex
    ),
    userEvent: 'input.format'
  })
  return true
}

/** Apply one of the visible Markdown toolbar operations to the current selection. */
export function applyMarkdownFormat(view: EditorView, action: MarkdownFormatAction): boolean {
  switch (action) {
    case 'bold': return wrapSelection('**')(view)
    case 'italic': return wrapSelection('*')(view)
    case 'code': return wrapSelection('`')(view)
    case 'link': return wrapLink(view)
    case 'image': return wrapImage(view)
    case 'quote': return prefixSelectedLines(view, '> ')
    case 'bullet-list': return prefixSelectedLines(view, '- ')
    case 'ordered-list': return prefixSelectedLines(view, '1. ')
    case 'heading': return prefixSelectedLines(view, '# ')
    case 'inline-math': return wrapSelection('$')(view)
    case 'display-math': {
      if (view.state.readOnly) return false
      const { from, to } = view.state.selection.main
      const selected = view.state.sliceDoc(from, to)
      const insert = selected ? `$$\n${selected}\n$$` : '$$\nx\n$$'
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + (selected ? insert.length : 3) },
        userEvent: 'input.format'
      })
      return true
    }
  }
}

export const markdownFormatKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: wrapSelection('**') },
  { key: 'Mod-i', run: wrapSelection('*') },
  { key: 'Mod-`', run: wrapSelection('`') },
  { key: 'Mod-Shift-x', run: wrapSelection('~~') },
  { key: 'Mod-Shift-k', run: wrapLink }
]
