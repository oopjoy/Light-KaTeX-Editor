export interface OutlineHeading {
  level: number
  text: string
  line: number
}

/** Extract ATX headings outside fenced code blocks. Lines are 1-based. */
export function extractOutlineHeadings(source: string): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  let fence: '`' | '~' | null = null
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trimStart()
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/u)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence !== null) continue
    const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*?)[ \t]*#*[ \t]*$/u)
    if (!match) continue
    const text = stripHeadingMarkup(match[2])
    if (!text) continue
    headings.push({ level: match[1].length, text, line: index + 1 })
  }
  return headings
}

/** Return the deepest/latest heading containing a 1-based source line. */
export function headingAtLine(headings: OutlineHeading[], line: number): OutlineHeading | null {
  let result: OutlineHeading | null = null
  for (const heading of headings) {
    if (heading.line > line) break
    result = heading
  }
  return result
}

/** Return the heading ancestry for a source line, suitable for breadcrumbs. */
export function breadcrumbHeadings(headings: OutlineHeading[], line: number): OutlineHeading[] {
  const path: OutlineHeading[] = []
  for (const heading of headings) {
    if (heading.line > line) break
    while (path.length > 0 && path[path.length - 1].level >= heading.level) path.pop()
    path.push(heading)
  }
  return path
}

function stripHeadingMarkup(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/\*([^*]+)\*/gu, '$1')
    .replace(/~~([^~]+)~~/gu, '$1')
    .replace(/[\[\]*_~`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}
