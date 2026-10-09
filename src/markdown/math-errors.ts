import katex from 'katex'
import MarkdownIt from 'markdown-it'
import { preprocessMath } from './math-preprocess'
import { mathPlugin } from './math-plugin'

export interface MathErrorItem {
  /** 1-based source line */
  line: number
  endLine: number
  displayMode: boolean
  source: string
  message: string
}

// Share the actual preview grammar: code spans/fences, indented code, escaped
// delimiters and unmatched openers must not produce phantom formula errors.
const parser = new MarkdownIt({ html: true }).use(mathPlugin)
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

/** Validate exactly the $ / $$ / \\( / \\[ formulas recognized by the preview. */
export function collectMathErrors(source: string): MathErrorItem[] {
  const errors: MathErrorItem[] = []
  function check(tex: string, displayMode: boolean, line: number, endLine: number): void {
    const message = validate(tex, displayMode)
    if (message) errors.push({ line, endLine, displayMode, source: tex.trim(), message })
  }
  let containerStartLine = 1
  for (const token of parser.parse(source, {})) {
    // Table cell inline tokens have no map; their tr_open owns the row map.
    if (token.map) containerStartLine = token.map[0] + 1
    if (token.type === 'math_block' && token.map) {
      check(token.content, true, token.map[0] + 1, token.map[1])
    }
    if (token.type !== 'inline') continue
    for (const child of token.children ?? []) {
      if (child.type !== 'math_inline' && child.type !== 'math_inline_display') continue
      const start = containerStartLine
      check(child.content, child.type === 'math_inline_display',
        start + (child.meta?.mathLine ?? 0), start + (child.meta?.mathEndLine ?? 0))
    }
  }
  return errors
}
