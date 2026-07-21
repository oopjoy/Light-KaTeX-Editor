import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js'
import { mathPlugin } from './math-plugin'
import { sourceLinePlugin } from './source-line'

function escapeHtml(code: string): string {
  return code
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
  highlight(code: string, language: string): string {
    if (language && hljs.getLanguage(language)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language, ignoreIllegals: true }).value}</code></pre>`
      } catch {
        // fall through
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`
  }
})

md.use(taskLists, { enabled: true, label: true, labelAfter: true })
md.use(mathPlugin)
md.use(sourceLinePlugin)

// Only *...* / **...** for emphasis/strong — never underscore.
// Keeps LaTeX subscripts like \phi_h from becoming <em> in preview.
// markdown-it stores rules on ruler.__rules__; wrap the emphasis tokenize rule.
{
  type InlineRule = {
    name: string
    enabled: boolean
    fn: (state: { src: string; pos: number }, silent: boolean) => boolean
  }
  const ruler = md.inline.ruler as unknown as { __rules__?: InlineRule[] }
  const emph = ruler.__rules__?.find((r) => r.name === 'emphasis')
  if (emph) {
    const orig = emph.fn.bind(null)
    emph.fn = (state, silent) => {
      if (state.src.charCodeAt(state.pos) === 0x5f /* _ */) return false
      return orig(state, silent)
    }
  }
}

// Open external links in a new window/tab context (Electron will intercept)
const defaultLinkOpen = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (token.attrIndex('href') >= 0) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  if (defaultLinkOpen) return defaultLinkOpen(tokens, idx, options, env, self)
  return self.renderToken(tokens, idx, options)
}

export function renderMarkdown(source: string, baseDir: string | null): string {
  const env = { baseDir }
  const dirty = md.render(source, env)
  const clean = DOMPurify.sanitize(dirty, {
    ADD_TAGS: ['annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac'],
    ADD_ATTR: [
      'class',
      'style',
      'title',
      'target',
      'rel',
      'aria-hidden',
      'focusable',
      'viewBox',
      'xmlns',
      'data-source-line',
      'data-source-end-line'
    ],
    ALLOW_DATA_ATTR: true,
    ALLOW_UNKNOWN_PROTOCOLS: false
  })

  if (!baseDir) return clean

  // Resolve relative image sources against the markdown file directory.
  // Electron can load local file:// URLs when src uses absolute file paths encoded as file URL.
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div id="root">${clean}</div>`, 'text/html')
  const root = doc.getElementById('root')
  if (!root) return clean

  root.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src')
    if (!src) return
    if (/^(https?:|data:|file:|blob:)/i.test(src)) return
    if (src.startsWith('//')) return
    try {
      // Build a file URL from baseDir + relative path
      const normalized = src.replaceAll('\\', '/')
      const joined = joinPath(baseDir, normalized)
      img.setAttribute('src', pathToFileUrl(joined))
    } catch {
      // leave original src
    }
  })

  return root.innerHTML
}

function joinPath(base: string, relative: string): string {
  const baseParts = base.replaceAll('\\', '/').split('/').filter(Boolean)
  // On Windows, drive letter stays first
  const isWin = /^[A-Za-z]:/.test(base)
  const drive = isWin ? baseParts.shift() : null
  const relParts = relative.split('/')
  for (const part of relParts) {
    if (!part || part === '.') continue
    if (part === '..') {
      baseParts.pop()
      continue
    }
    baseParts.push(part)
  }
  if (isWin && drive) return `${drive}/${baseParts.join('/')}`
  return `/${baseParts.join('/')}`
}

function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/')
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`
  }
  return `file://${encodeURI(normalized)}`
}
