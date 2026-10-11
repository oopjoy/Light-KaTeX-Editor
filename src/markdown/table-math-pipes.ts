import type MarkdownIt from 'markdown-it'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import type { RuleBlock } from 'markdown-it/lib/parser_block.mjs'
import { collectTableMathRanges } from './inline-math'

const BACKSLASH = String.fromCharCode(92)

/** A single BMP private-use code unit absent from this entire parse input. */
export function chooseTableMathMarker(source: string): string | null {
  const used = new Set<number>()
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i)
    if (code >= 0xe000 && code <= 0xf8ff) used.add(code)
  }
  for (let code = 0xe000; code <= 0xf8ff; code += 1) {
    if (!used.has(code)) return String.fromCharCode(code)
  }
  return null
}

function rowPipeOffsets(state: StateBlock, line: number): number[] {
  const start = state.bMarks[line] + state.tShift[line]
  const text = state.src.slice(start, state.eMarks[line])
  if (!text.includes('|') || (!text.includes('$') && !text.includes(BACKSLASH + '('))) return []
  const positions = new Set<number>()
  for (const range of collectTableMathRanges(state.md, text, state.env)) {
    for (let i = range.contentFrom; i < range.contentTo; i += 1) {
      // Protect ALL math pipes. Native table splitting removes the slash from
      // an escaped pipe too, silently changing TeX norm semantics.
      if (text[i] === '|') positions.add(start + i)
    }
  }
  return [...positions].sort((a, b) => a - b)
}

/** Copy only this table's characters and line arrays, never the whole document. */
function tableState(state: StateBlock, from: number, to: number, pipes: number[], marker: string | null): StateBlock {
  const shadow = Object.create(state) as StateBlock
  const base = state.bMarks[from]
  const limit = state.eMarks[to - 1]
  const pieces: string[] = []
  let cursor = base
  if (marker) {
    for (const pipe of pipes) {
      pieces.push(state.src.slice(cursor, pipe), marker)
      cursor = pipe + 1
    }
  }
  pieces.push(state.src.slice(cursor, limit))
  shadow.src = pieces.join('')
  shadow.bMarks = state.bMarks.slice(from, to).map(offset => offset - base)
  shadow.eMarks = state.eMarks.slice(from, to).map(offset => offset - base)
  shadow.tShift = state.tShift.slice(from, to)
  shadow.sCount = state.sCount.slice(from, to)
  shadow.bsCount = state.bsCount.slice(from, to)
  shadow.bMarks.push(shadow.src.length)
  shadow.eMarks.push(shadow.src.length)
  shadow.tShift.push(0)
  shadow.sCount.push(0)
  shadow.bsCount.push(0)
  shadow.tokens = []
  shadow.line = 0
  shadow.lineMax = to - from
  shadow.level = state.level
  return shadow
}

/**
 * Wrap (never fork) native table parsing. Only a table-local shadow sees the
 * markers. The real source/state stays untouched, including failed probes.
 * Cell content is restored before the core inline pass and KaTeX rendering.
 */
export function tableMathPipesPlugin(md: MarkdownIt): void {
  // markdown-it exposes replacement via .at(), but not lookup by name. Keep
  // the one registry lookup isolated and retain the original function/alt list.
  const ruler = md.block.ruler as unknown as {
    __rules__: { name: string; fn: RuleBlock; alt: string[] }[]
  }
  const table = ruler.__rules__.find(rule => rule.name === 'table')
  if (!table) return
  const nativeTable = table.fn
  const markers = new WeakMap<StateBlock, string | null>()
  function markerFor(state: StateBlock): string | null {
    if (!markers.has(state)) markers.set(state, chooseTableMathMarker(state.src))
    return markers.get(state) ?? null
  }

  md.block.ruler.at('table', (state, startLine, endLine, silent) => {
    if (startLine + 2 > endLine) return false
    const separator = state.src.slice(
      state.bMarks[startLine + 1] + state.tShift[startLine + 1], state.eMarks[startLine + 1]
    )
    // Candidate filter only. Native parsing owns syntax and indentation checks.
    if (!/^[-:| \t]+$/.test(separator)) return nativeTable(state, startLine, endLine, silent)

    const positions = rowPipeOffsets(state, startLine)
    let marker = positions.length ? markerFor(state) : null
    if (positions.length && !marker) return nativeTable(state, startLine, endLine, silent)
    const header = tableState(state, startLine, startLine + 2, positions, marker)
    if (!nativeTable(header, 0, 2, true)) return false
    if (silent) return true

    const terminators = md.block.ruler.getRules('blockquote')
    // Same parent context used by native table's terminator probes. Type
    // declarations omit 'table', although markdown-it sets it internally.
    const context = Object.assign(Object.create(state) as StateBlock, { parentType: 'table' })
    let stop = startLine + 2
    for (; stop < endLine; stop += 1) {
      if (state.sCount[stop] < state.blkIndent || state.sCount[stop] - state.blkIndent >= 4) break
      if (terminators.some(rule => rule(context, stop, endLine, true))) break
      const text = state.src.slice(state.bMarks[stop] + state.tShift[stop], state.eMarks[stop])
      if (!text.trim()) break
      positions.push(...rowPipeOffsets(state, stop))
    }
    if (!positions.length) return nativeTable(state, startLine, endLine, false)
    marker ??= markerFor(state)
    if (!marker) return nativeTable(state, startLine, endLine, false)

    const shadow = tableState(state, startLine, stop, positions, marker)
    let accepted: boolean
    try {
      accepted = nativeTable(shadow, 0, shadow.lineMax, false)
    } finally {
      // Restore even a throwing native rule's transient state; no marker can
      // escape to callers, inline parsing, KaTeX caches or source-copy paths.
      shadow.src = state.src.slice(state.bMarks[startLine], state.eMarks[stop - 1])
      for (const token of shadow.tokens) token.content = token.content.replaceAll(marker, '|')
    }
    if (!accepted) return false
    const mapped = new Set<number[]>()
    for (const token of shadow.tokens) {
      if (token.map && !mapped.has(token.map)) {
        mapped.add(token.map)
        token.map[0] += startLine
        token.map[1] += startLine
      }
      state.tokens.push(token)
    }
    state.line = startLine + shadow.line
    return true
  }, { alt: [...table.alt] })
}
