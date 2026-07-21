import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

/** markdown-it token.map is 0-based [start, endExclusive]. Export 1-based line numbers. */
export function applySourceLineAttrs(token: Token): void {
  if (!token.map) return
  const start = token.map[0] + 1
  const end = Math.max(start, token.map[1])
  token.attrSet('data-source-line', String(start))
  token.attrSet('data-source-end-line', String(end))
}

function wrapRule(md: MarkdownIt, ruleName: string): void {
  const original = md.renderer.rules[ruleName]
  md.renderer.rules[ruleName] = (tokens, idx, options, env, self) => {
    applySourceLineAttrs(tokens[idx])
    if (original) return original(tokens, idx, options, env, self)
    return self.renderToken(tokens, idx, options)
  }
}

/**
 * Inject data-source-line / data-source-end-line on block-level HTML tags
 * so preview <-> source jump can map DOM nodes back to Markdown lines.
 */
export function sourceLinePlugin(md: MarkdownIt): void {
  const rules = [
    'paragraph_open',
    'heading_open',
    'blockquote_open',
    'bullet_list_open',
    'ordered_list_open',
    'list_item_open',
    'table_open',
    'thead_open',
    'tbody_open',
    'tr_open',
    'th_open',
    'td_open',
    'fence',
    'code_block',
    'hr',
    'html_block',
    'math_block'
  ]

  for (const rule of rules) {
    wrapRule(md, rule)
  }
}
