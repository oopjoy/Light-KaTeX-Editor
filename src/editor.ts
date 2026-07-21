import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  drawSelection,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel
} from '@codemirror/search'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  foldNodeProp
} from '@codemirror/language'
import { mathAutocompleteExtension } from './math-complete'
import { createLightSearchPanel } from './search-panel'
import { markdownFormatKeymap } from './markdown-keymap'

export interface EditorAppearance {
  fontSize: number
  fontFamily: string
  lineHeight: number
  theme: 'light' | 'dark'
}

export interface CreateEditorOptions {
  parent: HTMLElement
  doc: string
  appearance: EditorAppearance
  onChange: (value: string) => void
  /** 1-based line from context menu "jump to preview". */
  onJumpToPreview?: (line: number) => void
}

/**
 * Math-note source coloring — deliberately NOT using Markdown syntaxHighlighting.
 *
 * Markdown's lezer grammar constantly mis-tags LaTeX (`|`, `_`, `[]`, fragments
 * inside $$...$$, whole lines after `$`) as link/url/atom/keyword → random blues.
 * Neutralizing every tag still leaks color via nested marks / default styles.
 *
 * Instead: plain body text everywhere, and only ATX heading lines (`#`…`######`)
 * get a single decoration color. Folding/structure still use the markdown parser.
 */
const headingLineMark = Decoration.mark({ class: 'cm-md-heading' })
/** TeXstudio-like math delimiter color — only the `$` / `$$` tokens. */
const mathDollarMark = Decoration.mark({ class: 'cm-math-dollar' })

function isEscapedAt(src: string, pos: number): boolean {
  let count = 0
  for (let i = pos - 1; i >= 0 && src.charCodeAt(i) === 92; i -= 1) count += 1
  return count % 2 === 1
}

function buildHeadingDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      if (/^#{1,6}[ \t]/.test(line.text) || /^#{1,6}$/.test(line.text)) {
        builder.add(line.from, line.to, headingLineMark)
      }
      pos = line.to + 1
    }
  }
  return builder.finish()
}

/**
 * Color only unescaped `$` and `$$` delimiters green (TeXstudio style).
 * Visible ranges only — math body stays plain. Fenced code is not specially
 * skipped (rare `$` in ``` fences; fine for notes).
 */
function buildDollarDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = view.state.doc
  const marks: Array<{ from: number; to: number }> = []

  for (const { from, to } of view.visibleRanges) {
    const start = Math.max(0, from)
    const end = Math.min(doc.length, to)
    if (start >= end) continue
    // Include 1 char before for escape detection at boundary.
    const pad = start > 0 ? 1 : 0
    const chunkFrom = start - pad
    const chunk = doc.sliceString(chunkFrom, end)
    let i = pad
    while (i < chunk.length) {
      if (chunk[i] !== '$') {
        i += 1
        continue
      }
      if (isEscapedAt(chunk, i)) {
        i += 1
        continue
      }
      const abs = chunkFrom + i
      if (i + 1 < chunk.length && chunk[i + 1] === '$' && !isEscapedAt(chunk, i + 1)) {
        marks.push({ from: abs, to: abs + 2 })
        i += 2
        continue
      }
      marks.push({ from: abs, to: abs + 1 })
      i += 1
    }
  }

  marks.sort((a, b) => a.from - b.from || a.to - b.to)
  let lastTo = -1
  for (const m of marks) {
    if (m.from < lastTo) continue
    builder.add(m.from, m.to, mathDollarMark)
    lastTo = m.to
  }
  return builder.finish()
}

const headingHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildHeadingDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildHeadingDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)

const dollarHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDollarDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDollarDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)

/**
 * Only `*...*` / `**...**` count as emphasis/strong in the parser tree
 * (used for structure; we no longer color emphasis). Underscore stays plain.
 */
const EmphasisAsteriskOnly = {
  resolve: 'Emphasis',
  mark: 'EmphasisMark'
} as const

const markdownAsteriskEmphasisOnly = {
  parseInline: [
    {
      name: 'Emphasis',
      parse(cx: {
        char: (n: number) => number
        slice: (a: number, b: number) => string
        addDelimiter: (
          type: { resolve: string; mark: string },
          from: number,
          to: number,
          open: boolean,
          close: boolean
        ) => number
      }, next: number, start: number): number {
        // 42 = '*'. Ignore '_' (95) entirely.
        if (next !== 42) return -1
        let pos = start + 1
        while (cx.char(pos) === 42) pos += 1
        const before = cx.slice(start - 1, start)
        const after = cx.slice(pos, pos + 1)
        const punct = /[!"#$%&'()*+,.\/:;<=>?@\[\\\]^`{|}~-]/u
        const pBefore = punct.test(before)
        const pAfter = punct.test(after)
        const sBefore = /\s|^$/.test(before)
        const sAfter = /\s|^$/.test(after)
        const leftFlanking = !sAfter && (!pAfter || sBefore || pBefore)
        const rightFlanking = !sBefore && (!pBefore || sAfter || pAfter)
        const canOpen = leftFlanking
        const canClose = rightFlanking
        if (!canOpen && !canClose) return -1
        return cx.addDelimiter(EmphasisAsteriskOnly, start, pos, canOpen, canClose)
      }
    }
  ]
}

function editorTheme(appearance: EditorAppearance) {
  const isDark = appearance.theme === 'dark'
  const bg = isDark ? '#0d1117' : '#ffffff'
  const fg = isDark ? '#e6edf3' : '#1f2328'
  const gutterBg = isDark ? '#0d1117' : '#f6f8fa'
  const gutterFg = isDark ? '#6e7681' : '#8c959f'
  const active = isDark ? 'rgba(56, 139, 253, 0.12)' : 'rgba(234, 238, 242, 0.9)'
  const selection = isDark ? '#264f78' : '#add6ff'
  const caret = isDark ? '#e6edf3' : '#1f2328'
  const match = isDark ? 'rgba(210, 153, 34, 0.35)' : 'rgba(255, 213, 0, 0.35)'

  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: `${appearance.fontSize}px`,
        backgroundColor: bg,
        color: fg
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: appearance.fontFamily,
        lineHeight: String(appearance.lineHeight),
        fontWeight: '400',
        fontSynthesis: 'none',
        fontFeatureSettings: '"liga" 0, "calt" 0',
        fontVariantLigatures: 'none'
      },
      '.cm-content': {
        fontFamily: 'inherit',
        fontWeight: '400',
        textDecoration: 'none',
        fontSynthesis: 'none',
        caretColor: caret,
        padding: '10px 0 28px'
      },
      '.cm-line': {
        padding: '0 12px 0 4px'
      },
      '.cm-gutters': {
        backgroundColor: gutterBg,
        color: gutterFg,
        borderRight: isDark ? '1px solid #30363d' : '1px solid #e2e4e8',
        minWidth: '52px'
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 10px 0 8px',
        fontSize: '0.9em',
        minWidth: '2.4em'
      },
      // Active line: only light wash on the line number gutter.
      // Do NOT paint the whole content line — it would cover selection blue.
      '.cm-activeLine': {
        backgroundColor: 'transparent'
      },
      '.cm-activeLineGutter': {
        backgroundColor: active,
        color: isDark ? '#e6edf3' : '#1f2328'
      },
      // Selection always wins over any residual line backgrounds
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: selection
      },
      '.cm-activeLine .cm-selectionBackground': {
        backgroundColor: selection
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: caret
      },
      '.cm-searchMatch': {
        backgroundColor: match,
        outline: '1px solid transparent'
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: isDark ? 'rgba(255, 123, 114, 0.45)' : 'rgba(255, 170, 0, 0.55)'
      },
      '.cm-foldGutter .cm-gutterElement': {
        color: gutterFg
      },
      '.cm-link, .cm-url, .tok-link, .tok-url': {
        textDecoration: 'none'
      },
      '.cm-line, .cm-line *': {
        fontWeight: 'inherit'
      },
      '.cm-panels': {
        backgroundColor: isDark ? '#161b22' : '#f6f8fa',
        color: fg
      },
      '.cm-panels.cm-panels-top': {
        borderBottom: isDark ? '1px solid #30363d' : '1px solid #e2e4e8'
      },
      '.cm-panels.cm-panels-bottom': {
        borderTop: isDark ? '1px solid #30363d' : '1px solid #e2e4e8'
      },
      // Override CM search baseTheme padding (was 2px 6px — glued to left edge)
      '.cm-panel.cm-search': {
        padding: '12px 44px 14px 56px'
      },
      '.cm-textfield': {
        backgroundColor: isDark ? '#0d1117' : '#ffffff',
        color: fg,
        border: isDark ? '1px solid #30363d' : '1px solid #d0d7de',
        borderRadius: '6px',
        padding: '4px 10px',
        fontSize: '14px'
      },
      '.cm-button': {
        backgroundImage: 'none',
        backgroundColor: isDark ? '#21262d' : '#f6f8fa',
        color: fg,
        border: isDark ? '1px solid #30363d' : '1px solid #d0d7de',
        borderRadius: '6px',
        padding: '0 12px',
        fontSize: '13.5px'
      },
      '.cm-panel input[type=checkbox]': {
        accentColor: isDark ? '#2f81f7' : '#0969da'
      }
    },
    { dark: isDark }
  )
}

/** Chinese UI strings for CodeMirror search / goto-line panels. */
const chinesePhrases = EditorState.phrases.of({
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全选匹配',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '全词匹配',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'current match': '当前匹配',
  'on line': '位于行',
  'Go to line': '转到行',
  go: '转到',
  'replaced match on line $': '已替换第 $ 行的匹配',
  'replaced $ matches': '已替换 $ 处匹配'
})

const appearanceCompartment = new Compartment()

/** VS Code–like fold chevron: expanded = down, collapsed = right. */
function createFoldChevron(open: boolean): HTMLElement {
  const el = document.createElement('span')
  el.className = open ? 'cm-fold-chevron cm-fold-chevron-open' : 'cm-fold-chevron cm-fold-chevron-closed'
  el.setAttribute('aria-hidden', 'true')
  // 16×16 viewBox, stroke chevron — scales crisply on HiDPI
  el.innerHTML = open
    ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`
    : `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M6.25 4.5L9.75 8L6.25 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`
  return el
}

export function createEditor(options: CreateEditorOptions): EditorView {
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.doc,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        foldGutter({
          // VS Code–style chevrons (SVG), clearer than tiny ▾/▸ glyphs
          markerDOM: (open) => createFoldChevron(open)
        }),
        bracketMatching(),
        highlightSelectionMatches(),
        // Search/replace panel at top — custom 3-row layout (A)
        search({ top: true, createPanel: createLightSearchPanel }),
        chinesePhrases,
        mathAutocompleteExtension(),
        // NO syntaxHighlighting — Markdown tag colors break math notes.
        // Only ATX headings + math `$`/`$$` delimiters get decorations.
        headingHighlight,
        dollarHighlight,
        // CommonMark base for folding/structure; no GFM tables/autolink.
        // Asterisk-only emphasis: `_` is not italic (math subscripts stay plain).
        markdown({
          base: commonmarkLanguage,
          extensions: [
            markdownAsteriskEmphasisOnly,
            {
              props: [foldNodeProp.add(() => () => null)]
            }
          ]
        }),
        keymap.of([
          indentWithTab,
          ...markdownFormatKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            options.onChange(update.state.doc.toString())
          }
        }),
        appearanceCompartment.of(editorTheme(options.appearance)),
        EditorView.contentAttributes.of({
          spellcheck: 'false',
          autocapitalize: 'off',
          autocorrect: 'off'
        }),
        EditorView.lineWrapping,
        EditorView.domEventHandlers({
          contextmenu(event, view) {
            if (!options.onJumpToPreview) return false
            event.preventDefault()
            showEditorContextMenu(event.clientX, event.clientY, view, options.onJumpToPreview)
            return true
          }
        })
      ]
    })
  })
  return view
}

export function setEditorAppearance(view: EditorView, appearance: EditorAppearance): void {
  view.dispatch({
    effects: [appearanceCompartment.reconfigure(editorTheme(appearance))]
  })
}

/** Open CodeMirror search panel (includes Find + Replace fields). */
export function openEditorFind(view: EditorView): void {
  openSearchPanel(view)
}

/** Same panel as find — focus replace field when present. */
export function openEditorReplace(view: EditorView): void {
  openSearchPanel(view)
  // After panel mounts, focus the replace input if available.
  requestAnimationFrame(() => {
    const input = view.dom.querySelector<HTMLInputElement>('.cm-panel.cm-search input[name=replace]')
    if (input) {
      input.focus()
      input.select()
    }
  })
}

export function setEditorContent(view: EditorView, content: string): void {
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: content
    }
  })
}

export function getCursorLine(view: EditorView): number {
  const pos = view.state.selection.main.head
  return view.state.doc.lineAt(pos).number
}

let menuEl: HTMLDivElement | null = null

function dismissMenu(): void {
  if (menuEl) {
    menuEl.remove()
    menuEl = null
  }
  window.removeEventListener('mousedown', onMenuOutside, true)
  window.removeEventListener('keydown', onMenuKey, true)
}

function onMenuOutside(event: MouseEvent): void {
  if (menuEl && event.target instanceof Node && !menuEl.contains(event.target)) {
    dismissMenu()
  }
}

function onMenuKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') dismissMenu()
}

async function copySelection(view: EditorView): Promise<void> {
  const { from, to } = view.state.selection.main
  if (from === to) return
  const text = view.state.sliceDoc(from, to)
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    document.execCommand('copy')
  }
}

async function cutSelection(view: EditorView): Promise<void> {
  const { from, to } = view.state.selection.main
  if (from === to) return
  const text = view.state.sliceDoc(from, to)
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // still delete selection even if clipboard write fails
  }
  view.dispatch({
    changes: { from, to, insert: '' },
    selection: { anchor: from },
    userEvent: 'delete.cut'
  })
}

async function pasteIntoEditor(view: EditorView): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text == null) return
    const { from, to } = view.state.selection.main
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.paste'
    })
  } catch {
    document.execCommand('paste')
  }
}

function showEditorContextMenu(
  x: number,
  y: number,
  view: EditorView,
  onJumpToPreview: (line: number) => void
): void {
  dismissMenu()
  const line = getCursorLine(view)
  const pos = view.posAtCoords({ x, y })
  const targetLine = pos !== null ? view.state.doc.lineAt(pos).number : line

  const menu = document.createElement('div')
  menu.className = 'editor-context-menu'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  menu.innerHTML = `
    <button type="button" data-action="jump-preview">跳转到预览（第 ${targetLine} 行）</button>
    <div class="menu-sep"></div>
    <button type="button" data-action="cut">剪切</button>
    <button type="button" data-action="copy">复制</button>
    <button type="button" data-action="paste">粘贴</button>
  `.trim()
  document.body.appendChild(menu)
  menuEl = menu

  const rect = menu.getBoundingClientRect()
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`
  }

  menu.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest('button[data-action]')
    if (!btn) return
    const action = btn.getAttribute('data-action')
    dismissMenu()
    if (action === 'jump-preview') {
      if (pos !== null) view.dispatch({ selection: { anchor: pos } })
      onJumpToPreview(targetLine)
      return
    }
    view.focus()
    if (action === 'cut') {
      void cutSelection(view)
    } else if (action === 'copy') {
      void copySelection(view)
    } else if (action === 'paste') {
      void pasteIntoEditor(view)
    }
  })

  window.addEventListener('mousedown', onMenuOutside, true)
  window.addEventListener('keydown', onMenuKey, true)
}
