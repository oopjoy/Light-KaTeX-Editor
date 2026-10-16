import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js'
import { mathPlugin } from './math-plugin'
import { sourceLinePlugin } from './source-line'
import { normalizeLocalDestination, resolveResourceUrl, RESOURCE_URI_PATTERN } from './resource-url'

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

// Local documents intentionally support file URLs; retain markdown-it's
// protections for javascript/vbscript and non-image data URLs.
const defaultValidateLink = md.validateLink.bind(md)
md.validateLink = (url: string) => /^file:/i.test(url) || defaultValidateLink(url)
const defaultNormalizeLink = md.normalizeLink.bind(md)
md.normalizeLink = (url: string) => defaultNormalizeLink(normalizeLocalDestination(url))

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
    if (!token.attrGet('href')?.startsWith('#')) token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  if (defaultLinkOpen) return defaultLinkOpen(tokens, idx, options, env, self)
  return self.renderToken(tokens, idx, options)
}

/** 1-based source lines of headings that markdown-it confirms are top-level blocks. */
export function findTopLevelHeadingLines(source: string): number[] {
  return md
    .parse(source, {})
    .filter((token) => token.type === 'heading_open' && token.level === 0 && token.map)
    .map((token) => token.map![0] + 1)
}

/** A parser-backed render island used by the Preview fast path. */
export interface PreviewRenderChunk {
  /** Stable only within one canonical parse; source span is the real identity. */
  id: string
  startLine: number
  endLine: number
}

export interface PreviewRenderPlan {
  chunks: PreviewRenderChunk[]
  /** Raw HTML block output has no reliable source-line DOM anchor. */
  hasTopLevelHtmlBlock: boolean
}

/**
 * Target size for a section split, while still allowing natural Markdown block
 * boundaries to win. A title section up to MAX stays whole.
 */
const PREVIEW_CHUNK_TARGET_LINES = 260
const PREVIEW_CHUNK_MAX_LINES = 400

/**
 * Build a small number of independent preview chunks from one parser pass.
 *
 * Headings are the primary section boundary. Only a section over 400 lines is
 * split further, and then only immediately after a markdown-it-confirmed
 * top-level block (never through a list/table/quote/fence/math block).
 */
export function buildPreviewRenderPlan(source: string): PreviewRenderPlan {
  const lineCount = Math.max(1, source.split('\n').length)
  const headingLines: number[] = []
  const blockEnds = new Set<number>()
  let hasTopLevelHtmlBlock = false
  for (const token of md.parse(source, {})) {
    // Opening top-level block tokens own their map. Closing tokens and inline
    // children must never become a possible split location.
    if (token.level !== 0 || !token.map) continue
    if (token.type === 'heading_open') headingLines.push(token.map[0] + 1)
    if (token.type === 'html_block') hasTopLevelHtmlBlock = true
    const endLine = token.map[1]
    if (endLine > token.map[0]) blockEnds.add(endLine)
  }
  const sectionStarts = [1, ...headingLines.filter((line) => line > 1)]
  const sortedBlockEnds = [...blockEnds].sort((a, b) => a - b)
  const chunks: PreviewRenderChunk[] = []

  for (let sectionIndex = 0; sectionIndex < sectionStarts.length; sectionIndex += 1) {
    let startLine = sectionStarts[sectionIndex]
    const endLine = (sectionStarts[sectionIndex + 1] ?? (lineCount + 1)) - 1
    while (endLine - startLine + 1 > PREVIEW_CHUNK_MAX_LINES) {
      const minimum = startLine + Math.floor(PREVIEW_CHUNK_TARGET_LINES * 0.7) - 1
      const preferred = startLine + PREVIEW_CHUNK_TARGET_LINES - 1
      const maximum = Math.min(endLine - 1, startLine + PREVIEW_CHUNK_MAX_LINES - 1)
      const candidates = sortedBlockEnds.filter((line) => line >= minimum && line <= maximum)
      // Nearest boundary to target, preferring the later one on an exact tie.
      const boundary = candidates.reduce<number | null>((best, line) => {
        if (best === null) return line
        const distance = Math.abs(line - preferred)
        const bestDistance = Math.abs(best - preferred)
        return distance < bestDistance || (distance === bestDistance && line > best) ? line : best
      }, null)

      // Parser recovery can leave no safe block boundary. Preserve semantic
      // correctness by leaving this exceptional large section intact.
      if (boundary === null || boundary < startLine) break
      chunks.push({ id: `${startLine}:${boundary}`, startLine, endLine: boundary })
      startLine = boundary + 1
    }
    chunks.push({ id: `${startLine}:${endLine}`, startLine, endLine })
  }

  return { chunks, hasTopLevelHtmlBlock }
}

export function renderMarkdown(
  source: string,
  baseDir: string | null,
  sourceLineOffset = 0,
  sourceLineMode: 'absolute' | 'local' = 'absolute'
): string {
  const env = { baseDir, sourceLineOffset, sourceLineMode }
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
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: RESOURCE_URI_PATTERN
  })

  // Resolve both Markdown and sanitized raw-HTML resource attributes. This
  // must run for absolute paths even in an unsaved document (no baseDir).
  if (!/<(?:img|a)\b/i.test(clean)) return clean
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div id="root">${clean}</div>`, 'text/html')
  const root = doc.getElementById('root')
  if (!root) return clean

  root.querySelectorAll('img[src], a[href]').forEach((element) => {
    const attr = element.tagName === 'IMG' ? 'src' : 'href'
    const value = element.getAttribute(attr)
    if (value) element.setAttribute(attr, resolveResourceUrl(value, baseDir))
  })

  return root.innerHTML
}
