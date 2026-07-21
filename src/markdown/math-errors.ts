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

function offsetToLine(src: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1
  }
  return line
}

function validate(tex: string, displayMode: boolean): string | null {
  const prepared = preprocessMath(tex, displayMode)
  try {
    katex.renderToString(prepared, {
      displayMode,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      output: 'html'
    })
    return null
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return msg.replace(/^KaTeX parse error:\s*/i, '').trim() || msg
  }
}

/**
 * Scan markdown source for $...$ / $$...$$ regions and report KaTeX failures.
 * Line numbers are 1-based (editor-compatible).
 */
export function collectMathErrors(source: string): MathErrorItem[] {
  const errors: MathErrorItem[] = []
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
              line: offsetToLine(source, open),
              endLine: offsetToLine(source, close),
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
            const line = offsetToLine(source, open)
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
