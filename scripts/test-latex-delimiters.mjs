import esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outfile = path.join(root, 'dist-electron', 'latex-delimiters-test.mjs')
const sourceLineOutfile = path.join(root, 'dist-electron', 'latex-delimiters-source-line-test.mjs')

await esbuild.build({
  entryPoints: [path.join(root, 'src/markdown/math-plugin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm'
})
await esbuild.build({
  entryPoints: [path.join(root, 'src/markdown/source-line.ts')],
  outfile: sourceLineOutfile,
  bundle: true,
  platform: 'node',
  format: 'esm'
})

const { mathPlugin } = await import(pathToFileURL(outfile).href)
const { sourceLinePlugin } = await import(pathToFileURL(sourceLineOutfile).href)
const MarkdownIt = (await import('markdown-it')).default
const md = new MarkdownIt()
md.use(mathPlugin)
md.use(sourceLinePlugin)
const renderMarkdown = (source) => md.render(source)

function assert(name, condition, detail) {
  if (condition) {
    console.log('PASS', name)
  } else {
    console.error('FAIL', name, detail)
    process.exitCode = 1
  }
}

const inline = renderMarkdown(String.raw`行内公式：\(e^{i\pi} + 1 = 0\)`, null)
assert('inline \\(...\\) renders', inline.includes('math-inline') && inline.includes('katex'), inline)
assert('inline delimiters removed', !inline.includes('\\(') && !inline.includes('\\)'), inline)

const display = renderMarkdown(String.raw`\[
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
\]`, null)
assert('display \\[...\\] renders', display.includes('math-block') && display.includes('katex-display'), display)
assert('display delimiters removed', !display.includes('\\[') && !display.includes('\\]'), display)

const sameLine = renderMarkdown(String.raw`\[a^2+b^2=c^2\]`, null)
assert('single-line \\[...\\] renders', sameLine.includes('math-block') && sameLine.includes('katex-display'), sameLine)
assert('single-line \\[...\\] source map', sameLine.includes('data-source-line="1"') && sameLine.includes('data-source-end-line="1"'), sameLine)

const mappedMultiline = renderMarkdown(`before\n\\[\nx + y\n\\]\nafter`, null)
assert('multiline \\[...\\] source map', mappedMultiline.includes('data-source-line="2"') && mappedMultiline.includes('data-source-end-line="4"'), mappedMultiline)

const legacyInline = renderMarkdown('legacy $x^2$ works', null)
assert('legacy $...$ still renders', legacyInline.includes('math-inline') && legacyInline.includes('katex'), legacyInline)
const legacyDisplay = renderMarkdown('$$\n\\frac{1}{2}\n$$', null)
assert('legacy $$...$$ still renders', legacyDisplay.includes('math-block') && legacyDisplay.includes('katex-display'), legacyDisplay)

const unmatched = renderMarkdown(String.raw`保留未闭合 \(x + 1`, null)
assert('unmatched delimiter stays literal', unmatched.includes('\\(x + 1'), unmatched)

const newlineMath = renderMarkdown(`跨行行内公式 \\(x + 1\n\\)`, null)
assert('newline-separated \\(...\\) renders', newlineMath.includes('math-inline'), newlineMath)

const midParagraphDisplay = renderMarkdown(String.raw`文本 \[x\]`, null)
assert('mid-paragraph \\[...\\] stays literal', midParagraphDisplay.includes('\\[x\\]'), midParagraphDisplay)

const trailingDisplay = renderMarkdown(String.raw`\[x\] trailing`, null)
assert('trailing-text \\[...\\] stays literal', trailingDisplay.includes('\\[x\\] trailing'), trailingDisplay)

const paragraphLiteral = renderMarkdown(`before\n\\[x\\] trailing\nafter`, null)
assert('literal trailing bracket does not split paragraph', (paragraphLiteral.match(/<p\b/g) ?? []).length === 1, paragraphLiteral)

const laterCloseLiteral = renderMarkdown(`before\n\\[x\\] trailing\nafter\n\\]`, null)
assert('malformed closer cannot pair with later \\]', !laterCloseLiteral.includes('math-block') && (laterCloseLiteral.match(/<p\b/g) ?? []).length === 1, laterCloseLiteral)

const tripleSlashInline = renderMarkdown(String.raw`\\\(x\)`, null)
assert('three-backslash opener resolves to \\(...\\)', tripleSlashInline.includes('math-inline'), tripleSlashInline)

if (!process.exitCode) console.log('ALL LATEX DELIMITER PASS')
