/**
 * Preprocess math source before handing it to KaTeX.
 *
 * 1. Auto-wrap CJK / fullwidth runs in \text{...} so Chinese works inside $...$ / $$...$$.
 * 2. In display mode, if the body uses \\ line breaks but is not already inside a
 *    multi-line environment, wrap it in aligned so \\ works without \begin{aligned}.
 */

const MULTILINE_ENV =
  /\\begin\s*\{(aligned|align\*?|gather\*?|eqnarray\*?|cases|array|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|split|CD)\}/

/** CJK unified ideographs + extension A + compatibility + CJK punctuation + fullwidth forms. */
const CJK_RUN =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF\u2E80-\u2EFF\u31C0-\u31EF]+/g

/**
 * Wrap CJK character runs in \text{...}, but skip runs that are already inside
 * \text / \mbox / \mathrm / \mathbf / \textrm / \textbf / \textsf / \texttt groups
 * at the top-ish level (brace-aware scan).
 */
export function wrapCjkAsText(source: string): string {
  // Fast path: no CJK
  if (!/[\u3400-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/.test(source)) {
    return source
  }

  // Mark regions already inside text-like commands so we don't double-wrap.
  const protectedRanges: Array<{ start: number; end: number }> = []
  const textCmd =
    /\\(text|mbox|hbox|vbox|mathrm|mathbf|mathit|mathsf|mathtt|textrm|textbf|textit|textsf|texttt|operatorname)\s*\{/g
  let match: RegExpExecArray | null
  while ((match = textCmd.exec(source)) !== null) {
    const openBrace = match.index + match[0].length - 1
    const close = findMatchingBrace(source, openBrace)
    if (close > openBrace) {
      protectedRanges.push({ start: match.index, end: close + 1 })
      textCmd.lastIndex = close + 1
    }
  }

  // Also protect \begin{...} \end{...} names (no CJK there normally) and comments — skip.

  return source.replace(CJK_RUN, (run, offset: number) => {
    if (protectedRanges.some((r) => offset >= r.start && offset < r.end)) {
      return run
    }
    // Escape special TeX chars inside \text{} minimally
    const safe = run.replace(/([{}%&_#$])/g, '\\$1')
    return `\\text{${safe}}`
  })
}

function findMatchingBrace(src: string, openIndex: number): number {
  if (src[openIndex] !== '{') return -1
  let depth = 0
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '\\') {
      i += 1 // skip escaped char
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * If display math uses \\ but isn't already in a multi-line env, wrap with aligned.
 * Also normalize accidental single-slash line breaks that users sometimes type as //
 * when they mean \\ (only when // appears as a line-break token, not in URLs).
 */
export function ensureDisplayLinebreaks(source: string): string {
  let body = source.trim()
  if (!body) return body

  // Treat bare // (not part of :// or \\) as LaTeX line break when it looks intentional.
  // Common in notes when users type // instead of \\.
  body = body.replace(/(^|[^:\\])\/\//g, '$1\\\\')

  if (!body.includes('\\\\')) return body
  if (MULTILINE_ENV.test(body)) return body

  // Avoid wrapping pure single-line content that only has \\ as a symbol somehow — still ok in aligned.
  return `\\begin{aligned}\n${body}\n\\end{aligned}`
}

export function preprocessMath(source: string, displayMode: boolean): string {
  let out = source
  // Normalize CRLF inside math
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  out = wrapCjkAsText(out)
  if (displayMode) {
    out = ensureDisplayLinebreaks(out)
  }
  return out
}
