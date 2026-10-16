const BACKSLASH = String.fromCharCode(92)
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[/\\]/
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

/** Encode a path segment once. Markdown-it already percent-encodes its URLs. */
function encodeSegment(segment: string, alreadyEncoded: boolean): string {
  if (alreadyEncoded) {
    try { segment = decodeURIComponent(segment) } catch { /* literal percent */ }
  }
  return encodeURIComponent(segment)
}

function absoluteFileUrl(path: string, alreadyEncoded: boolean): string | null {
  const normalized = path.replaceAll(BACKSLASH, '/')
  if (WINDOWS_ABSOLUTE.test(normalized)) {
    return new URL(`file:///${normalized.slice(0, 2)}/${normalized.slice(3).split('/').map(s => encodeSegment(s, alreadyEncoded)).join('/')}`).href
  }
  if (normalized.startsWith('//')) {
    const [host, ...segments] = normalized.slice(2).split('/')
    if (!host || !segments[0]) return null
    return new URL(`file://${host}/${segments.map(s => encodeSegment(s, alreadyEncoded)).join('/')}`).href
  }
  if (normalized.startsWith('/')) {
    return new URL(`file://${normalized.split('/').map(s => encodeSegment(s, alreadyEncoded)).join('/')}`).href
  }
  return null
}

/** Raw drive/UNC destinations are filesystem paths; percent signs are literal. */
export function normalizeLocalDestination(value: string): string {
  if (!WINDOWS_ABSOLUTE.test(value) && !value.startsWith(BACKSLASH + BACKSLASH)) return value
  try { return absoluteFileUrl(value, false) ?? value } catch { return value }
}

/**
 * Resolve resource attributes, not document text. Drive/UNC paths are filesystem
 * paths; relative paths use the Markdown document directory, never the app's
 * preview.html. Hash-only links retain in-document navigation. Unknown schemes
 * are left to the sanitizer/main-process allowlist, never treated as filenames.
 */
export function resolveResourceUrl(reference: string, baseDir: string | null): string {
  const value = reference.trim()
  if (!value || value.startsWith('#')) return value
  try {
    if (WINDOWS_ABSOLUTE.test(value) || value.startsWith(BACKSLASH + BACKSLASH)) {
      return normalizeLocalDestination(value)
    }
    if (SCHEME.test(value)) return value
    // Markdown protocol-relative URLs are web URLs, not Windows UNC paths.
    if (value.startsWith('//')) return `https:${value}`
    const normalized = value.replaceAll(BACKSLASH, '/')
    if (normalized.startsWith('/') && !WINDOWS_ABSOLUTE.test(baseDir ?? '')) {
      const end = normalized.search(/[?#]/)
      const file = end < 0 ? normalized : normalized.slice(0, end)
      return (absoluteFileUrl(file, true) ?? file) + (end < 0 ? '' : normalized.slice(end))
    }
    if (!baseDir) return value
    const base = absoluteFileUrl(baseDir.replace(/[/\\]+$/, '') + '/', false)
    if (!base) return value
    const end = normalized.search(/[?#]/)
    const pathname = end < 0 ? normalized : normalized.slice(0, end)
    const suffix = end < 0 ? '' : normalized.slice(end)
    return new URL(pathname.split('/').map(s => encodeSegment(s, true)).join('/') + suffix, base).href
  } catch {
    return value
  }
}

// Extend DOMPurify's normal URI policy only for file URLs and absolute Windows
// paths. Do not enable ALLOW_UNKNOWN_PROTOCOLS or relax event/script filtering.
export const RESOURCE_URI_PATTERN = /^(?:(?:https?|mailto|tel|file|blob):|[A-Za-z]:[/\\]|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
