import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import katex from 'katex'
import { preprocessMath } from './math-preprocess'

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

function isEscaped(src: string, pos: number): boolean {
  let count = 0
  for (let i = pos - 1; i >= 0 && src[i] === '\\'; i -= 1) count += 1
  return count % 2 === 1
}

/**
 * Flexible display-math block rule.
 * Supports:
 *   $$\alpha$$                          (single line)
 *   $$\n...\n$$                         (classic multi-line)
 *   $$\begin{aligned}...\end{aligned}$$ (open/close may share the line with content)
 */
function mathBlock(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  if (start + 2 > max) return false
  if (state.src.slice(start, start + 2) !== '$$') return false

  // Must be at block start (allow only whitespace before on the line — tShift already accounts indent)
  const firstLineFull = state.src.slice(start, max)
  if (!firstLineFull.startsWith('$$')) return false

  // --- Single-line: $$...$$ ---
  // Content may include CJK; disallow raw newlines. Allow escaped \$.
  if (firstLineFull.length > 4) {
    // Try to find closing $$ on same line (not escaped)
    let close = -1
    for (let i = 2; i < firstLineFull.length - 1; i += 1) {
      if (firstLineFull[i] === '$' && firstLineFull[i + 1] === '$' && !isEscaped(firstLineFull, i)) {
        close = i
        break
      }
    }
    if (close > 2) {
      const after = firstLineFull.slice(close + 2)
      if (/^\s*$/.test(after)) {
        const content = firstLineFull.slice(2, close).trim()
        if (content.length > 0) {
          if (silent) return true
          const token = state.push('math_block', 'div', 0)
          token.content = content
          token.map = [startLine, startLine + 1]
          token.markup = '$$'
          token.block = true
          state.line = startLine + 1
          return true
        }
      }
    }
  }

  // --- Multi-line ---
  // Opening line: "$$" alone, or "$$" + trailing content (e.g. $$\begin{aligned})
  let openingRest = firstLineFull.slice(2)
  // If openingRest still starts with $ it is $$$ — not our concern
  if (openingRest.startsWith('$')) return false

  if (silent) return true

  const parts: string[] = []
  if (openingRest.trim()) {
    parts.push(openingRest.replace(/^\s+/, ''))
  }

  let nextLine = startLine + 1
  let closed = false
  let closingExtra = ''

  while (nextLine < endLine) {
    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine]
    const lineMax = state.eMarks[nextLine]
    const lineText = state.src.slice(lineStart, lineMax)

    // Closing line is exactly $$ (optional spaces)
    if (/^\$\$\s*$/.test(lineText)) {
      closed = true
      nextLine += 1
      break
    }

    // Closing line ends with $$  e.g. \end{aligned}$$
    const closeAt = findUnescapedClosingDollars(lineText)
    if (closeAt >= 0) {
      const before = lineText.slice(0, closeAt)
      const after = lineText.slice(closeAt + 2)
      if (/^\s*$/.test(after)) {
        if (before.trim()) parts.push(before.replace(/\s+$/, ''))
        closed = true
        nextLine += 1
        break
      }
    }

    parts.push(lineText)
    nextLine += 1
  }

  if (!closed) return false

  const content = parts.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
  const token = state.push('math_block', 'div', 0)
  token.content = content
  token.map = [startLine, nextLine]
  token.markup = '$$'
  token.block = true
  state.line = nextLine
  void closingExtra
  return true
}

function findUnescapedClosingDollars(line: string): number {
  for (let i = 0; i < line.length - 1; i += 1) {
    if (line[i] === '$' && line[i + 1] === '$' && !isEscaped(line, i)) {
      return i
    }
  }
  return -1
}

function mathInline(state: any, silent: boolean): boolean {
  const start = state.pos
  if (state.src[start] !== '$') return false
  if (state.src[start + 1] === '$') return false
  if (isEscaped(state.src, start)) return false

  // Find matching closing $ on the same line.
  // NOTE: do NOT skip "$1" / "$20" before looking for a closer — math notes
  // frequently write $1$, $2h$, $O(1/h)$. Currency like "costs $20" has no
  // closing $ and correctly falls through as plain text.
  let pos = start + 1
  while (pos < state.posMax) {
    if (state.src[pos] === '\n') return false
    if (state.src[pos] === '$' && !isEscaped(state.src, pos)) {
      // $$ would be display; treat as not our inline closer
      if (state.src[pos + 1] === '$') return false
      break
    }
    pos += 1
  }
  if (pos >= state.posMax || state.src[pos] !== '$') return false

  const content = state.src.slice(start + 1, pos)
  if (!content.trim()) return false

  // Optional soft currency guard: lone "$20.5" style without TeX tokens is rare
  // as math when content is ONLY a decimal number AND the next char after close
  // is a letter (e.g. $20USD) — still allow pure $1$ / $2$ / $3.14$.
  // (No reject — closed $...$ with any content is math.)

  if (!silent) {
    const token = state.push('math_inline', 'span', 0)
    token.content = content
    token.markup = '$'
  }
  state.pos = pos + 1
  return true
}

export function mathPlugin(md: MarkdownIt): void {
  md.block.ruler.before('fence', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  })
  md.inline.ruler.after('escape', 'math_inline', mathInline)

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

  md.renderer.rules.math_inline = (tokens: Token[], idx: number) => {
    const html = renderKatex(tokens[idx].content, false)
    return `<span class="math-inline">${html}</span>`
  }
}
