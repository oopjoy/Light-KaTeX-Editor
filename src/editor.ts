import { Compartment, EditorState, RangeSetBuilder, Transaction, type Extension } from '@codemirror/state'
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
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands'
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
  foldService
} from '@codemirror/language'
import { mathAutocompleteExtension } from './math-complete'
import { createLightSearchPanel } from './search-panel'
import { markdownFormatKeymap } from './markdown-keymap'
import { sourceLineFlashExtension } from './sync/jump'

export interface EditorAppearance {
  fontSize: number
  fontFamily: string
  lineHeight: number
  sourceColoring: boolean
  theme: 'light' | 'dark'
}

export interface EditorChangeHint {
  /** 1-based inclusive line span in the post-transaction document. */
  fromLine: number
  toLine: number
  /** A single non-structural same-line edit is eligible for preview's safe fast path. */
  isConservativeLocalEdit: boolean
}

export interface CreateEditorOptions {
  parent: HTMLElement
  doc: string
  appearance: EditorAppearance
  onChange: (
    visibleCharacterDelta: number,
    userEvent: string | null,
    changeHint: EditorChangeHint
  ) => void
  /** Passive cursor/selection notification for outline state. */
  onSelectionChange?: (line: number) => void
  /** 1-based line from context menu "jump to preview". */
  onJumpToPreview?: (line: number) => void
}

/**
 * Math-note source coloring — deliberately NOT using Markdown syntaxHighlighting.
 *
 * Markdown's lezer grammar constantly mis-tags LaTeX (`|`, `_`, `[]`, fragments
 * inside $$...$$, whole lines after `$`) as link/url/atom/keyword → random blues.
 * Instead this is a small visible-line scanner: predictable colors without parser
 * recovery work on every keystroke in a large formula note.
 */
const headingLineMark = Decoration.mark({ class: 'cm-md-heading' })
/** TeXstudio-like color for dollar and LaTeX math delimiters. */
const mathDollarMark = Decoration.mark({ class: 'cm-math-dollar' })
const latexCommandMark = Decoration.mark({ class: 'cm-latex-command' })
const latexEnvironmentMark = Decoration.mark({ class: 'cm-latex-environment' })
const commentMark = Decoration.mark({ class: 'cm-md-comment' })
const codeFenceMark = Decoration.mark({ class: 'cm-md-code-fence' })
const linkMark = Decoration.mark({ class: 'cm-md-link' })
const strongMark = Decoration.mark({ class: 'cm-md-strong' })
const emphasisMark = Decoration.mark({ class: 'cm-md-emphasis' })
const quoteMark = Decoration.mark({ class: 'cm-md-quote-marker' })
const listMark = Decoration.mark({ class: 'cm-md-list-marker' })

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
 * Color unescaped `$`, `$$`, `\\(`, `\\)`, `\\[` and `\\]` green.
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
      if (chunk[i] === '\\' && /[()[\]]/.test(chunk[i + 1] ?? '') && !isEscapedAt(chunk, i)) {
        marks.push({ from: chunkFrom + i, to: chunkFrom + i + 2 })
        i += 2
        continue
      }
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

type SourceToken = {
  from: number
  to: number
  decoration: Decoration
  /** Larger priority wins where source tokens overlap. */
  priority: number
}

function addRegexTokens(
  tokens: SourceToken[],
  text: string,
  lineFrom: number,
  regex: RegExp,
  decoration: Decoration,
  priority: number,
  group = 0
): void {
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const value = match[group]
    const offset = group === 0 ? match.index : match.index + match[0].indexOf(value)
    if (value) tokens.push({ from: lineFrom + offset, to: lineFrom + offset + value.length, decoration, priority })
    if (match[0].length === 0) regex.lastIndex += 1
  }
}

/**
 * Small, visible-line source scanner. It intentionally colors only stable tokens:
 * comments, fence marks, links, quote/list prefixes and TeX command/environment
 * names. Formula variables and Markdown punctuation stay neutral.
 */
function buildSourceSyntaxDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tokens: SourceToken[] = []

  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      const text = line.text
      // An ATX title is deliberately one blue unit, without noisy inner colors.
      if (!/^(?: {0,3})#{1,6}(?:[ \t]|$)/.test(text)) {
        addRegexTokens(tokens, text, line.from, /<!--[\s\S]*?-->/g, commentMark, 100)
        addRegexTokens(tokens, text, line.from, /%%.*$/g, commentMark, 100)
        addRegexTokens(tokens, text, line.from, /^\s*(?:`{3,}|~{3,})[^`~]*$/g, codeFenceMark, 90)
        // Keep underscore neutral for LaTeX subscripts; only Markdown asterisk
        // emphasis receives an actual font weight/style in the source pane.
        addRegexTokens(tokens, text, line.from, /\*\*(?=\S)(?:[^*\n]|\*(?!\*))+?\S\*\*/g, strongMark, 80)
        addRegexTokens(tokens, text, line.from, /(?<!\*)\*(?![\s*])(?:[^*\n]|\*(?=[^*]))+?(?<!\s)\*(?!\*)/g, emphasisMark, 75)
        addRegexTokens(tokens, text, line.from, /^\s*>+/g, quoteMark, 70)
        addRegexTokens(tokens, text, line.from, /^\s*(?:[-+*]|\d+[.)])(?=\s)/g, listMark, 70)
        // Link label and target get one restrained link color, including reference links.
        addRegexTokens(tokens, text, line.from, /!?\[[^\]\n]+\](?:\([^\)\n]+\)|\[[^\]\n]*\])/g, linkMark, 60)
        // Environments win over the overlapping generic \begin / \end command.
        addRegexTokens(tokens, text, line.from, /\\(?:begin|end)\s*\{[^}\n]+\}/g, latexEnvironmentMark, 50)
        addRegexTokens(tokens, text, line.from, /\\[A-Za-z]+\*?/g, latexCommandMark, 40)
      }
      pos = line.to + 1
    }
  }

  tokens.sort((a, b) => a.from - b.from || b.priority - a.priority || b.to - a.to)
  let occupiedUntil = -1
  for (const token of tokens) {
    if (token.from < occupiedUntil) continue
    builder.add(token.from, token.to, token.decoration)
    occupiedUntil = token.to
  }
  return builder.finish()
}

const sourceSyntaxHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildSourceSyntaxDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildSourceSyntaxDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)

/**
 * Lightweight ATX heading folding. The source intentionally has no full
 * Markdown language parser—formula-heavy notes otherwise make Lezer recover
 * through thousands of LaTeX punctuation tokens after edits.
 */
const headingFoldService = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart)
  const heading = /^(?: {0,3})(#{1,6})(?:[ \t]|$)/.exec(line.text)
  if (!heading) return null
  const level = heading[1].length

  for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
    const candidate = state.doc.line(number)
    const next = /^(?: {0,3})(#{1,6})(?:[ \t]|$)/.exec(candidate.text)
    if (next && next[1].length <= level) {
      const to = candidate.from - 1
      return to > line.to ? { from: line.to, to } : null
    }
  }

  return state.doc.length > line.to ? { from: line.to, to: state.doc.length } : null
})

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
const sourceColoringCompartment = new Compartment()
const sourceColoringClassCompartment = new Compartment()

/** A delimiter which can alter Markdown block boundaries must bypass Preview's local fast path. */
export function isStructuralMarkdownEditText(text: string): boolean {
  return /(?:\r?\n|^(?: {0,3}#{1,6}(?:[ \t]|$)|\s*(?:[-+*]|\d+[.)])[ \t]+|\s*>|\s*\[[^\]]+\]:|\s*(?:```|~~~)|\s*\||\s*(?:---+|===+)\s*$|\s*<\/?[A-Za-z!])|\$\$|\\[\[\]])/m.test(text)
}

function sourceColoringExtensions(enabled: boolean): Extension {
  return enabled ? [headingHighlight, dollarHighlight, sourceSyntaxHighlight] : []
}

function sourceColoringEditorAttributes(enabled: boolean): Extension {
  return EditorView.editorAttributes.of({
    class: enabled ? 'cm-source-coloring-default' : 'cm-source-coloring-off'
  })
}

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
        // No full syntaxHighlighting — Markdown grammar colors break math notes.
        // These visible-line token decorations can be disabled instantly.
        sourceColoringCompartment.of(sourceColoringExtensions(options.appearance.sourceColoring)),
        sourceColoringClassCompartment.of(sourceColoringEditorAttributes(options.appearance.sourceColoring)),
        sourceLineFlashExtension,
        headingFoldService,
        keymap.of([
          indentWithTab,
          ...markdownFormatKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          { key: 'Mod-Shift-z', run: redo, preventDefault: true },
          ...searchKeymap,
          ...foldKeymap
        ]),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet && !update.docChanged) {
            options.onSelectionChange?.(update.state.doc.lineAt(update.state.selection.main.head).number)
          }
          if (!update.docChanged) return

          // Keep status-bar character count incremental. Recounting the whole
          // 2k+ line document after every keypress is unnecessary work.
          let visibleCharacterDelta = 0
          let changeCount = 0
          let postFromLine = 1
          let postToLine = 1
          let isConservativeLocalEdit = true
          update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            changeCount += 1
            const removed = update.startState.sliceDoc(fromA, toA)
            const insertedText = inserted.toString()
            visibleCharacterDelta -= removed.match(/\S/gu)?.length ?? 0
            visibleCharacterDelta += insertedText.match(/\S/gu)?.length ?? 0

            // Do not attempt a local preview when line boundaries or classic
            // Markdown structural markers may have changed. The preview will
            // use its canonical whole-document debounce in those cases.
            const oldStartLine = update.startState.doc.lineAt(fromA).text
            const oldEndLine = update.startState.doc.lineAt(Math.min(toA, update.startState.doc.length)).text
            const newStartLine = update.state.doc.lineAt(fromB).text
            const newEndLine = update.state.doc.lineAt(Math.min(toB, update.state.doc.length)).text
            if (
              isStructuralMarkdownEditText(removed) || isStructuralMarkdownEditText(insertedText) ||
              isStructuralMarkdownEditText(oldStartLine) || isStructuralMarkdownEditText(oldEndLine) ||
              isStructuralMarkdownEditText(newStartLine) || isStructuralMarkdownEditText(newEndLine)
            ) {
              isConservativeLocalEdit = false
            }
            postFromLine = update.state.doc.lineAt(fromB).number
            postToLine = update.state.doc.lineAt(Math.min(toB, update.state.doc.length)).number
          })
          if (changeCount !== 1) isConservativeLocalEdit = false
          const userEvent = update.transactions
            .map((transaction) => transaction.annotation(Transaction.userEvent))
            .find((event): event is string => typeof event === 'string') ?? null
          options.onChange(visibleCharacterDelta, userEvent, {
            fromLine: postFromLine,
            toLine: postToLine,
            isConservativeLocalEdit
          })
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

/** Menu actions must use the same CM history as historyKeymap, not Chromium undo. */
export function performEditorUndo(view: EditorView): boolean {
  const changed = undo(view)
  view.focus()
  return changed
}

export function performEditorRedo(view: EditorView): boolean {
  const changed = redo(view)
  view.focus()
  return changed
}

export function setEditorAppearance(view: EditorView, appearance: EditorAppearance): void {
  view.dispatch({
    effects: [
      appearanceCompartment.reconfigure(editorTheme(appearance)),
      sourceColoringCompartment.reconfigure(sourceColoringExtensions(appearance.sourceColoring)),
      sourceColoringClassCompartment.reconfigure(sourceColoringEditorAttributes(appearance.sourceColoring))
    ]
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
