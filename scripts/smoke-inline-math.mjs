import katex from '../node_modules/katex/dist/katex.mjs'
import MarkdownIt from '../node_modules/markdown-it/index.mjs'

function isEscaped(src, pos) {
  let count = 0
  for (let i = pos - 1; i >= 0 && src[i] === '\\'; i -= 1) count += 1
  return count % 2 === 1
}

function mathInline(state, silent) {
  const start = state.pos
  if (state.src[start] !== '$') return false
  if (state.src[start + 1] === '$') return false
  if (isEscaped(state.src, start)) return false
  let pos = start + 1
  while (pos < state.posMax) {
    if (state.src[pos] === '\n') return false
    if (state.src[pos] === '$' && !isEscaped(state.src, pos)) {
      if (state.src[pos + 1] === '$') return false
      break
    }
    pos += 1
  }
  if (pos >= state.posMax || state.src[pos] !== '$') return false
  const content = state.src.slice(start + 1, pos)
  if (!content.trim()) return false
  if (!silent) {
    const token = state.push('math_inline', 'span', 0)
    token.content = content
    token.markup = '$'
  }
  state.pos = pos + 1
  return true
}

const md = new MarkdownIt()
md.inline.ruler.after('escape', 'math_inline', mathInline)
md.renderer.rules.math_inline = (tokens, idx) =>
  katex.renderToString(tokens[idx].content, { throwOnError: false, strict: 'ignore' })

const s = '在从 $h$ 到 $1$ 的不同尺度上有 $O(\\log(1/h))$ 个'
const html = md.renderInline(s)
const plain = html.replace(/<[^>]+>/g, '')
console.log('plain:', plain)
console.log('has raw $1$:', plain.includes('$1$'))
console.log('has raw leftover $O:', plain.includes('$O'))
console.log('currency no close:', md.renderInline('costs $20 tomorrow'))
