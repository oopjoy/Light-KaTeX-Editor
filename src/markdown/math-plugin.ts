import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import katex from 'katex'
import { preprocessMath } from './math-preprocess'
import { isMathEscaped as isEscaped, findMathClose } from './math-delimiters'
import { findInlineMathRange, recordInlineMathRange } from './inline-math'
import { tableMathPipesPlugin } from './table-math-pipes'

/** Most formulas do not change between keystrokes. Avoid rebuilding hundreds
 * of identical KaTeX DOM strings on every full-preview refresh. */
const KATEX_CACHE_ENTRY_LIMIT = 4096
/** Approx. 24 MB UTF-16 characters; bounds renderer memory while covering long notes. */
const KATEX_CACHE_CHAR_LIMIT = 12_000_000
const katexHtmlCache = new Map<string, string>()
let katexCacheChars = 0

function cacheKatex(key: string, html: string): string {
  const previous = katexHtmlCache.get(key)
  if (previous !== undefined) katexCacheChars -= key.length + previous.length
  katexHtmlCache.set(key, html)
  katexCacheChars += key.length + html.length

  while (
    katexHtmlCache.size > KATEX_CACHE_ENTRY_LIMIT ||
    katexCacheChars > KATEX_CACHE_CHAR_LIMIT
  ) {
    const oldest = katexHtmlCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    const removed = katexHtmlCache.get(oldest)
    katexHtmlCache.delete(oldest)
    katexCacheChars -= oldest.length + (removed?.length ?? 0)
  }
  return html
}

function renderKatex(source: string, displayMode: boolean): string {
  const key = `${displayMode ? 'D' : 'I'}\u0000${source}`
  const cached = katexHtmlCache.get(key)
  if (cached !== undefined) {
    // Refresh insertion order for simple LRU behavior.
    katexHtmlCache.delete(key)
    katexHtmlCache.set(key, cached)
    return cached
  }

  const prepared = preprocessMath(source, displayMode)
  try {
    return cacheKatex(key, katex.renderToString(prepared, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'html'
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const escaped = source
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
    return cacheKatex(
      key,
      `<span class="math-error" title="${message.replaceAll('"', '&quot;')}">${escaped}</span>`
    )
  }
}

/** Matched display blocks: $$...$$ or \\[...\\], including multi-line TeX.
 * Use markdown-it's container offsets so quotes/lists keep their source maps.
 * Never consume an unmatched opener or cross the enclosing container boundary.
 */
function mathBlock(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const opening = state.src.slice(start, start + 2)
  if (opening !== '$$' && opening !== '\\[') return false
  if (opening === '$$' && state.src[start + 2] === '$') return false
  const closing = opening === '$$' ? '$$' : '\\]'
  const parts: string[] = []

  for (let line = startLine; line < endLine; line += 1) {
    const lineStart = state.bMarks[line] + state.tShift[line]
    const lineEnd = state.eMarks[line]
    if (line > startLine && lineStart < lineEnd && state.sCount[line] < state.blkIndent) break
    const text = state.src.slice(lineStart, lineEnd)
    const from = line === startLine ? 2 : 0
    const close = findMathClose(text, closing, from)
    if (close >= 0) {
      // Text after the closer belongs to a paragraph, not a stand-alone block.
      if (text.slice(close + 2).trim()) return false
      parts.push(text.slice(from, close))
      const content = parts.join('\n').trim()
      if (!content) return false
      if (silent) return true
      const token = state.push('math_block', 'div', 0)
      token.content = content
      token.map = [startLine, line + 1]
      token.markup = opening
      token.block = true
      state.line = line + 1
      return true
    }
    parts.push(text.slice(from))
  }
  return false
}

/** Must run BEFORE Markdown's escape rule, which otherwise consumes \\( / \\[. */
function mathBackslash(state: any, silent: boolean): boolean {
  const start = state.pos
  if (state.src.slice(start, start + 2) !== '\\(') return false
  const range = findInlineMathRange(state.src, start, state.posMax)
  if (!range) {
    if (!silent) state.push('text', '', 0).content = '\\('
    state.pos = start + 2
    return true
  }
  if (!silent) {
    const token = state.push('math_inline', 'span', 0)
    token.content = state.src.slice(range.contentFrom, range.contentTo)
    token.markup = '\\('
    setInlineMathLines(token, state.src, start, range.contentTo)
    recordInlineMathRange(state.src, state.env, range)
  }
  state.pos = range.to
  return true
}

/** \\[...\\] is block-only; preserve it literally when it occurs in a paragraph. */
function mathBracketLiteral(state: any, silent: boolean): boolean {
  const start = state.pos
  if (state.src.slice(start, start + 2) !== '\\[' || isEscaped(state.src, start)) return false
  const close = findMathClose(state.src, '\\]', start + 2, state.posMax)
  const end = close >= 0 ? close + 2 : start + 2
  if (!silent) state.push('text', '', 0).content = state.src.slice(start, end)
  state.pos = end
  return true
}

/** Keep a standalone closing delimiter visible instead of losing its slash. */
function mathBracketLiteralClose(state: any, silent: boolean): boolean {
  const start = state.pos
  if (state.src.slice(start, start + 2) !== '\\]' || isEscaped(state.src, start)) return false
  if (!silent) state.push('text', '', 0).content = '\\]'
  state.pos = start + 2
  return true
}

function setInlineMathLines(token: Token, source: string, start: number, end: number): void {
  const line = source.slice(0, start).split('\n').length - 1
  token.meta = { mathLine: line, mathEndLine: line + source.slice(start, end).split('\n').length - 1 }
}

function mathInline(state: any, silent: boolean): boolean {
  const start = state.pos
  if (state.src[start] !== '$') return false
  const range = findInlineMathRange(state.src, start, state.posMax)
  if (!range) return false
  if (!silent) {
    const token = state.push('math_inline', 'span', 0)
    token.content = state.src.slice(range.contentFrom, range.contentTo)
    token.markup = '$'
    setInlineMathLines(token, state.src, start, range.contentTo)
    recordInlineMathRange(state.src, state.env, range)
  }
  state.pos = range.to
  return true
}

export function mathPlugin(md: MarkdownIt): void {
  md.block.ruler.before('fence', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  })
  md.inline.ruler.before('escape', 'math_backslash', mathBackslash)
  md.inline.ruler.before('escape', 'math_bracket_literal', mathBracketLiteral)
  md.inline.ruler.before('escape', 'math_bracket_literal_close', mathBracketLiteralClose)
  md.inline.ruler.after('escape', 'math_inline', mathInline)
  md.use(tableMathPipesPlugin)

  md.renderer.rules.math_block = (tokens: Token[], idx: number, _options, env) => {
    const token = tokens[idx]
    const html = renderKatex(token.content, true)
    const renderEnv = env as { sourceLineOffset?: unknown; sourceLineMode?: unknown }
    const local = renderEnv.sourceLineMode === 'local'
    const startAttr = local ? 'data-local-source-line' : 'data-source-line'
    const endAttr = local ? 'data-local-source-end-line' : 'data-source-end-line'
    const start = token.attrGet(startAttr)
    const end = token.attrGet(endAttr)
    let lineAttrs = ''
    if (start) {
      lineAttrs = ` ${startAttr}="${start}" ${endAttr}="${end || start}"`
    } else if (token.map) {
      const lineOffset = local ? 0 : Number(renderEnv.sourceLineOffset) || 0
      const s = token.map[0] + 1 + lineOffset
      const e = Math.max(s, token.map[1] + lineOffset)
      lineAttrs = ` ${startAttr}="${s}" ${endAttr}="${e}"`
    }
    return `<div class="math-block"${lineAttrs}>${html}</div>\n`
  }

  md.renderer.rules.math_inline_display = (tokens: Token[], idx: number) => {
    return `<span class="math-inline math-display">${renderKatex(tokens[idx].content, true)}</span>`
  }

  md.renderer.rules.math_inline = (tokens: Token[], idx: number) => {
    const html = renderKatex(tokens[idx].content, false)
    return `<span class="math-inline">${html}</span>`
  }
}
