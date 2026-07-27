import katex from 'katex'
import { preprocessMath } from './math-preprocess'

export interface MathErrorItem {
  /** 1-based source line */
  line: number
  endLine: number
  displayMode: boolean
  source: string
  message: string
}

function isEscaped(src: string, pos: number): boolean {
  let count = 0
  for (let i = pos - 1; i >= 0 && src[i] === '\\'; i -= 1) count += 1
  return count % 2 === 1
}

function buildLineStarts(src: string): number[] {
  const starts = [0]
  for (let i = 0; i < src.length; i += 1) {
    if (src.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/** 1-based line via binary search; avoids rescanning the source per error. */
function offsetToLine(lineStarts: number[], offset: number): number {
  let low = 0
  let high = lineStarts.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (lineStarts[mid] <= offset) low = mid + 1
    else high = mid
  }
  return Math.max(1, low)
}

// Success entries are only formula-source keys plus null, so covering a typical
// 2k–4k formula note is inexpensive and avoids sequential LRU thrashing.
const VALIDATION_CACHE_LIMIT = 5000
const validationCache = new Map<string, string | null>()

function validate(tex: string, displayMode: boolean): string | null {
  const key = `${displayMode ? 'D' : 'I'}\u0000${tex}`
  if (validationCache.has(key)) {
    const cached = validationCache.get(key) ?? null
    validationCache.delete(key)
    validationCache.set(key, cached)
    return cached
  }

  const prepared = preprocessMath(tex, displayMode)
  let result: string | null = null
  try {
    katex.renderToString(prepared, {
      displayMode,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      output: 'html'
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    result = msg.replace(/^KaTeX parse error:\s*/i, '').trim() || msg
  }

  validationCache.set(key, result)
  if (validationCache.size > VALIDATION_CACHE_LIMIT) {
    const oldest = validationCache.keys().next().value as string | undefined
    if (oldest !== undefined) validationCache.delete(oldest)
  }
  return result
}

/**
 * Scan markdown source for $...$ / $$...$$ regions and report KaTeX failures.
 * Line numbers are 1-based (editor-compatible).
 */
export function collectMathErrors(source: string): MathErrorItem[] {
  const errors: MathErrorItem[] = []
  const lineStarts = buildLineStarts(source)
  const n = source.length
  let i = 0

  while (i < n) {
    // skip fenced code blocks ```
    if (source.startsWith('```', i) && (i === 0 || source[i - 1] === '\n')) {
      const end = source.indexOf('\n```', i + 3)
      if (end < 0) break
      i = end + 4
      continue
    }

    if (source[i] === '$' && !isEscaped(source, i)) {
      // display $$
      if (source[i + 1] === '$') {
        const open = i
        let j = i + 2
        let close = -1
        while (j < n - 1) {
          if (source[j] === '$' && source[j + 1] === '$' && !isEscaped(source, j)) {
            close = j
            break
          }
          j += 1
        }
        if (close > open + 2) {
          const content = source.slice(open + 2, close)
          const message = validate(content, true)
          if (message) {
            errors.push({
              line: offsetToLine(lineStarts, open),
              endLine: offsetToLine(lineStarts, close),
              displayMode: true,
              source: content.trim(),
              message
            })
          }
          i = close + 2
          continue
        }
        i += 2
        continue
      }

      // inline $
      const open = i
      let j = i + 1
      let close = -1
      while (j < n) {
        if (source[j] === '\n') break
        if (source[j] === '$' && !isEscaped(source, j)) {
          close = j
          break
        }
        j += 1
      }
      if (close > open + 1) {
        const content = source.slice(open + 1, close)
        if (content.trim()) {
          const message = validate(content, false)
          if (message) {
            const line = offsetToLine(lineStarts, open)
            errors.push({
              line,
              endLine: line,
              displayMode: false,
              source: content.trim(),
              message
            })
          }
        }
        i = close + 1
        continue
      }
    }
    i += 1
  }

  return errors
}
