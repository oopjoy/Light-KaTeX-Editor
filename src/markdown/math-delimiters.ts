/** Backslash parity matters: \\( is literal, while \( opens math. */
export function isMathEscaped(src: string, pos: number): boolean {
  let count = 0
  for (let i = pos - 1; i >= 0 && src[i] === '\\'; i -= 1) count += 1
  return count % 2 === 1
}

export function findMathClose(src: string, closing: string, from: number, end = src.length): number {
  let pos = src.indexOf(closing, from)
  while (pos >= 0 && pos + closing.length <= end) {
    if (!isMathEscaped(src, pos)) return pos
    pos = src.indexOf(closing, pos + 1)
  }
  return -1
}
