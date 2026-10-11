import type MarkdownIt from 'markdown-it'

const BACKSLASH = String.fromCharCode(92)

export interface InlineMathRange {
  from: number
  to: number
  contentFrom: number
  contentTo: number
}

export function isMathEscaped(source: string, offset: number): boolean {
  let count = 0
  for (let i = offset - 1; i >= 0 && source[i] === BACKSLASH; i -= 1) count += 1
  return count % 2 === 1
}

/** The same delimiter matcher is used by rendering, table shielding and diagnostics. */
export function findInlineMathRange(source: string, start: number, max = source.length): InlineMathRange | null {
  const dollar = source[start] === '$'
  const bracket = source[start] === BACKSLASH && (source[start + 1] === '(' || source[start + 1] === '[')
  if (dollar) {
    if (source[start + 1] === '$' || isMathEscaped(source, start)) return null
  } else if (!bracket || isMathEscaped(source, start)) {
    return null
  }

  const width = dollar ? 1 : 2
  const closingChar = source[start + 1] === '[' ? ']' : ')'
  const contentFrom = start + width
  for (let pos = contentFrom; pos < max; pos += 1) {
    if (dollar && source.charCodeAt(pos) === 10) return null
    const closing = dollar
      ? source[pos] === '$'
      : source[pos] === BACKSLASH && pos + 1 < max && source[pos + 1] === closingChar
    if (!closing || isMathEscaped(source, pos)) continue
    if (dollar && source[pos + 1] === '$') return null
    if (!source.slice(contentFrom, pos).trim()) return null
    return { from: start, to: pos + width, contentFrom, contentTo: pos }
  }
  return null
}

const RANGE_COLLECTOR = Symbol('inline-math-range-collector')
interface RangeCollector {
  source: string
  ranges: InlineMathRange[]
}

/** Called only for accepted, non-silent math tokens (not speculative link-label probes). */
export function recordInlineMathRange(source: string, env: any, range: InlineMathRange): void {
  const collector: RangeCollector | undefined = env?.[RANGE_COLLECTOR]
  // Images recursively parse their alt text with another source string. Those
  // child-relative offsets must never be treated as offsets into this row.
  if (collector?.source === source) collector.ranges.push(range)
}

/**
 * Use the real inline parser, not a competing Markdown lexer. Code spans,
 * escapes, link destinations and HTML attributes keep their native precedence.
 * This only tokenizes: it never calls KaTeX or renders HTML.
 */
export function collectInlineMathRanges(md: MarkdownIt, source: string, env: any): InlineMathRange[] {
  const collector: RangeCollector = { source, ranges: [] }
  md.inline.parse(source, md, { ...env, [RANGE_COLLECTOR]: collector }, [])
  return collector.ranges
}

/** Native GFM splitting treats a pipe immediately after a slash as escaped. */
function isCellPipe(source: string, pos: number): boolean {
  return source[pos] === '|' && source[pos - 1] !== BACKSLASH
}

/**
 * Determine provisional cells with the shared math matcher, then accept only
 * math that the real inline parser recognizes within each cell. Whole-row
 * inline parsing is wrong: two unrelated backticks in separate cells could
 * otherwise hide the formula in the middle cell.
 */
export function collectTableMathRanges(md: MarkdownIt, source: string, env: any): InlineMathRange[] {
  // Forward references are not available during the block pass. Fail closed
  // for possible reference identifiers, using the real link parser to locate
  // them. A placeholder reference is probe-only: label math remains eligible,
  // but math-looking text in an identifier/destination is never shielded.
  const unresolvedReference = { href: '#', title: '' }
  const references = new Proxy(env?.references ?? Object.create(null), {
    get: (target, key) => Reflect.get(target, key) ?? unresolvedReference
  })
  const probeEnv = { ...env, references }
  const candidates: InlineMathRange[] = []
  const protectedPipes = new Set<number>()
  function add(range: InlineMathRange): void {
    candidates.push(range)
    for (let i = range.contentFrom; i < range.contentTo; i += 1) {
      if (source[i] === '|') protectedPipes.add(i)
    }
  }
  let probe = new md.inline.State(source, md, probeEnv, [])
  for (let pos = 0; pos < source.length;) {
    const range = findInlineMathRange(source, pos)
    if (range) { add(range); pos = range.to; continue }
    probe.pos = pos
    md.inline.skipToken(probe)
    // Delegate escapes, HTML tags, autolinks and link destinations to native
    // syntax. Their literal dollars must not consume a later math opener.
    if (source[pos] === '[' && probe.pos > pos + 1) {
      for (const labelRange of collectInlineMathRanges(md, source.slice(pos, probe.pos), probeEnv)) {
        add({
          from: pos + labelRange.from, to: pos + labelRange.to,
          contentFrom: pos + labelRange.contentFrom, contentTo: pos + labelRange.contentTo
        })
      }
    }
    // Opaque Markdown tokens cannot cross an actual column boundary. Resume
    // AFTER the first non-math pipe with fresh inline context, not at the
    // whole-row token's endpoint: that endpoint might lie inside a formula
    // in the next cell. Dollars in the opaque prefix remain skipped, while a
    // genuine next-cell formula can extend beyond that obsolete endpoint.
    let boundary = -1
    for (let i = pos; i < probe.pos; i += 1) {
      if (isCellPipe(source, i) && !protectedPipes.has(i)) { boundary = i; break }
    }
    if (boundary >= 0) {
      pos = boundary + 1
      probe = new md.inline.State(source, md, probeEnv, [])
    } else {
      pos = probe.pos
    }
  }
  if (!protectedPipes.size) return []

  const candidateEnds = new Map(candidates.map(range => [range.from, range.to]))
  const accepted: InlineMathRange[] = []
  let start = 0
  for (let end = 0; end <= source.length; end += 1) {
    if (end < source.length && (!isCellPipe(source, end) || protectedPipes.has(end))) continue
    for (const range of collectInlineMathRanges(md, source.slice(start, end), probeEnv)) {
      if (candidateEnds.get(start + range.from) !== start + range.to) continue
      accepted.push({
        from: start + range.from, to: start + range.to,
        contentFrom: start + range.contentFrom, contentTo: start + range.contentTo
      })
    }
    start = end + 1
  }
  return accepted
}
