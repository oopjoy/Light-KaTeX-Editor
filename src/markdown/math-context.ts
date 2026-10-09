import { isMathEscaped } from './math-delimiters'

/** Cursor context also works while a formula is still being typed (no closer). */
export function isInsideMath(doc: string, pos: number): boolean {
  pos = Math.max(0, Math.min(pos, doc.length))
  let closing: '$' | '$$' | '\\)' | '\\]' | null = null
  let i = 0
  while (i < pos) {
    if (!closing && (i === 0 || doc[i - 1] === '\n')) {
      const lineEnd = doc.indexOf('\n', i)
      const line = doc.slice(i, lineEnd < 0 ? doc.length : lineEnd)
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        const endPattern = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`)
        let next = lineEnd < 0 ? doc.length : lineEnd + 1
        let after = doc.length
        while (next < doc.length) {
          const end = doc.indexOf('\n', next)
          if (endPattern.test(doc.slice(next, end < 0 ? doc.length : end).replace(/\r$/, ''))) {
            after = end < 0 ? doc.length : end + 1
            break
          }
          next = end < 0 ? doc.length : end + 1
        }
        if (pos <= after) return false
        i = after
        continue
      }
      // Ordinary top-level indented code is not a math context.
      if (/^(?: {4}|\t)/.test(line)) {
        if (lineEnd < 0 || pos <= lineEnd) return false
        i = lineEnd + 1
        continue
      }
    }

    if (!closing && doc[i] === '`' && !isMathEscaped(doc, i)) {
      let width = 1
      while (doc[i + width] === '`') width += 1
      let next = i + width
      let end = -1
      while (next < doc.length) {
        next = doc.indexOf('`', next)
        if (next < 0) break
        let length = 1
        while (doc[next + length] === '`') length += 1
        if (length === width) { end = next + length; break }
        next += length
      }
      if (end >= 0) {
        if (pos < end) return false
        i = end
        continue
      }
      i += width
      continue
    }

    if (closing) {
      if (doc.startsWith(closing, i) && !isMathEscaped(doc, i)) {
        // $$ does not close a single-dollar formula.
        if (closing !== '$' || doc[i + 1] !== '$') {
          i += closing.length
          closing = null
          continue
        }
      }
      if (doc[i] === '\n' && (closing === '$' ||
          (closing === '\\)' && /^\s*\n/.test(doc.slice(i + 1))))) closing = null
    } else if (!isMathEscaped(doc, i)) {
      const pair = doc.slice(i, i + 2)
      if (pair === '$$' || pair === '\\(' || pair === '\\[') {
        if (i + 2 > pos) return false
        closing = pair === '$$' ? '$$' : pair === '\\(' ? '\\)' : '\\]'
        i += 2
        continue
      }
      if (doc[i] === '$') closing = '$'
    }
    i += 1
  }
  return closing !== null
}
