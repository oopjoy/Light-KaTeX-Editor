import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import MarkdownIt from 'markdown-it'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cache = path.join(root, 'node_modules/.cache')
await fs.mkdir(cache, { recursive: true })
const temp = await fs.mkdtemp(path.join(cache, 'math-delimiters-'))
try {
  const outfile = path.join(temp, 'test-api.mjs')
  await esbuild.build({
    stdin: { contents: `export { mathPlugin } from './src/markdown/math-plugin';
      export { collectMathErrors } from './src/markdown/math-errors';
      export { isInsideMath } from './src/markdown/math-context';
      export { preprocessMath } from './src/markdown/math-preprocess';`,
      resolveDir: root, loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external'
  })
  const { mathPlugin, collectMathErrors, isInsideMath, preprocessMath } = await import(pathToFileURL(outfile).href)
  const md = new MarkdownIt({ html: true }).use(mathPlugin)
  const formulas = source => md.parse(source, {}).flatMap(t => t.type === 'math_block' ? [t] :
    (t.children ?? []).filter(c => c.type === 'math_inline' || c.type === 'math_inline_display'))
  let passed = 0
  function test(name, fn) { fn(); passed += 1; console.log('PASS', name) }
  const raw = String.raw

  for (const [name, source, types] of [
    ['dollar inline/numbers', '$h$ $1$ $O(\\log(1/h))$', ['math_inline', 'math_inline', 'math_inline']],
    ['parentheses inline', raw`前文 \(E_{\mathrm{acc}}\) 后文 \(H_{c1}\)`, ['math_inline', 'math_inline']],
    ['inline across soft break', raw`\(a+
b\)`, ['math_inline']],
    ['display same line', raw`\[\alpha+\beta=\gamma\]`, ['math_block']],
    ['display multiple lines', raw`\[
\frac{a}{b}
\]`, ['math_block']],
    ['display mixed with paragraph', raw`前文 \[x^2\] 后文`, ['math_inline_display']],
    ['display with trailing prose', raw`\[x^2\] 后文`, ['math_inline_display']],
    ['existing dollars', '$$a$$\n\n$$\nb\\\\c\n$$', ['math_block', 'math_block']],
    ['blockquote', raw`> \[
> a+b
> \]`, ['math_block']],
    ['list', raw`- \[
  a+b
  \]`, ['math_block']],
    ['bold inline', raw`**能量 \(E=mc^2\)**`, ['math_inline']],
    ['table inline', '| A | B |\n| --- | --- |\n| \\(x\\) | $y$ |', ['math_inline', 'math_inline']],
    ['CRLF', '\\[\r\na+b\r\n\\]', ['math_block']],
    ['paragraph interruption', '前文\n\\[\nx\n\\]\n后文', ['math_block']],
    ['three-backslash opener', raw`\\\(x\)`, ['math_inline']]
  ]) test(name, () => {
    assert.deepEqual(formulas(source).map(t => t.type), types)
    assert.equal(collectMathErrors(source).length, 0)
    assert.match(md.render(source), /class="katex"/)
  })

  for (const [name, source] of [
    ['escaped delimiters', raw`\\(x\\) \\[x\\] \$x\$`],
    ['inline code', '`\\(\\badcommand\\) $\\badcommand$`'],
    ['multiple backtick code', '`` ` \\[\\badcommand\\] ``'],
    ['backtick fence', '```tex\n\\[\\badcommand\\]\n```'],
    ['tilde fence', '~~~tex\n\\(\\badcommand\\)\n~~~'],
    ['long indented fence', '  ````tex\n\\[\\badcommand\\]\n```\n````'],
    ['indented code', '    \\[\\badcommand\\]'],
    ['unclosed inline', raw`before \(x after`],
    ['unclosed display', raw`\[
x

# Still a heading`],
    ['mismatched closer', raw`\(x\]`],
    ['empty math', raw`\( \) \[ \]`],
    ['currency', 'costs $20 tomorrow'],
    ['HTML code', '<pre>\\(\\badcommand\\)</pre>']
  ]) test(name, () => {
    assert.equal(formulas(source).length, 0)
    assert.equal(collectMathErrors(source).length, 0)
    assert.doesNotMatch(md.render(source), /class="katex"/)
  })

  test('unmatched block keeps following Markdown', () => {
    const html = md.render('\\[\nx\n\n# Still a heading\n\n$y$')
    assert.match(html, /<h1>Still a heading<\/h1>/)
    assert.equal(formulas('\\[\nx\n\n# Still a heading\n\n$y$').length, 1)
  })
  test('mixed delimiters keep math body untouched', () => {
    const source = raw`\(\text{price: \$20} + x_1\)`
    assert.equal(formulas(source)[0].content, raw`\text{price: \$20} + x_1`)
  })
  test('escaped close is not a delimiter', () => {
    assert.equal(formulas(raw`\(a\\)b\)`)[0].content, raw`a\\)b`)
  })
  test('block source map includes both delimiters', () => {
    assert.deepEqual(formulas('前文\n\n\\[\nx\n\\]\n\n后文')[0].map, [2, 5])
  })
  test('error panel and preview agree for all delimiters', () => {
    const source = '标题\n\n\\[\n\\badcommand\n\\]\n\n前文 \\(\\badcommand\\)\n\n$\\badcommand$\n\n$$\\badcommand$$'
    const errors = collectMathErrors(source)
    assert.equal(errors.length, 4)
    assert.deepEqual(errors.map(e => [e.line, e.endLine, e.displayMode]), [[3, 5, true], [7, 7, false], [9, 9, false], [11, 11, true]])
  })
  test('multi-line inline errors map to source', () => {
    const errors = collectMathErrors('text\n\\(\n\\badcommand\n\\)')
    assert.deepEqual(errors.map(e => [e.line, e.endLine]), [[2, 4]])
  })
  test('table errors retain row numbers', () => {
    const errors = collectMathErrors('| A | B |\n| --- | --- |\n| \\(\\badcommand\\) | $\\badcommand$ |')
    assert.deepEqual(errors.map(e => [e.line, e.endLine]), [[3, 3], [3, 3]])
  })
  test('quoted errors retain source numbers', () => {
    const errors = collectMathErrors('intro\n\n> \\[\n> \\badcommand\n> \\]')
    assert.deepEqual(errors.map(e => [e.line, e.endLine]), [[3, 5]])
  })
  test('gathered inside boxed is not wrapped again', () => {
    const tex = raw`\boxed{\begin{gathered}\text{超导腔体}\\\Downarrow\\\text{材料实验}\end{gathered}}`
    assert.equal(preprocessMath(tex, true), tex)
    assert.equal(collectMathErrors('\\[\n' + tex + '\n\\]').length, 0)
    assert.match(md.render('\\[\n' + tex + '\n\\]'), /class="katex"/)
  })
  for (const [source, expected] of [
    [raw`\(x+\alpha`, true], [raw`\(x\) text`, false],
    ['\\[\nx+\\alpha', true], [raw`\[x\] text`, false],
    ['$x+\\alpha', true], ['$$\nx+\\alpha', true],
    [raw`\\(x`, false], ['`\\(x`', false], ['`\\(x` trailing', false],
    ['~~~tex\n\\(x', false], ['````tex\n```\n\\(x', false],
    ['    \\(x', false], ['$x\ntext', false],
    ['text \\(x+\ny', true], ['\\(x\n\ntext', false]
  ]) test(`completion ${JSON.stringify(source)}`, () => assert.equal(isInsideMath(source, source.length), expected))

  console.log(`ALL ${passed} MATH DELIMITER TESTS PASSED`)
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
