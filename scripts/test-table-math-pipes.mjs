import assert from 'node:assert/strict'
import esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import MarkdownIt from 'markdown-it'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outfile = path.join(root, 'dist-electron', 'table-math-pipes-test.mjs')
await esbuild.build({
  stdin: {
    contents: `export { mathPlugin } from './src/markdown/math-plugin';
      export { sourceLinePlugin } from './src/markdown/source-line';
      export { chooseTableMathMarker } from './src/markdown/table-math-pipes';
      export { collectMathErrors } from './src/markdown/math-errors';
      export { buildPreviewRenderPlan, findTopLevelHeadingLines } from './src/markdown/render';`,
    resolveDir: root, loader: 'ts'
  },
  outfile, bundle: true, platform: 'node', format: 'esm'
})
const { mathPlugin, sourceLinePlugin, chooseTableMathMarker, collectMathErrors,
  buildPreviewRenderPlan, findTopLevelHeadingLines } = await import(pathToFileURL(outfile).href)

function parser(shield = true) {
  const md = new MarkdownIt({ html: true, linkify: true })
  const original = md.block.ruler.__rules__.find(r => r.name === 'table')
  const nativeTable = original.fn
  const alt = [...original.alt]
  md.use(mathPlugin).use(sourceLinePlugin)
  if (!shield) md.block.ruler.at('table', nativeTable, { alt })
  return md
}
const md = parser()
const native = parser(false)
let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('PASS', name)
  } catch (error) {
    console.error('FAIL', name, error)
    process.exitCode = 1
  }
}
function math(tokens) {
  return tokens.flatMap(t => t.children ?? []).filter(t => t.type === 'math_inline').map(t => t.content)
}
function rows(source) {
  const result = []
  for (const token of md.parse(source, {})) {
    if (token.type === 'tr_open') result.push([])
    if (token.type === 'inline' && result.length) result.at(-1).push(token.content)
  }
  return result
}
function unchanged(source) {
  assert.deepEqual(md.parse(source, {}), native.parse(source, {}))
  assert.equal(md.render(source), native.render(source))
}
const original = String.raw`| $t$ | $\min|\psi|$ | raw winding |
| --- | --- | --- |
| 1 | 2 | 3 |`
const body = String.raw`| t | formula | note |
| --- | --- | --- |
| $t$ | $\min|\psi|$ | raw winding |`

test('original header is a three-column table, not a paragraph', () => {
  assert.deepEqual(rows(original), [
    ['$t$', String.raw`$\min|\psi|$`, 'raw winding'], ['1', '2', '3']
  ])
  assert.deepEqual(math(md.parse(original, {})), ['t', String.raw`\min|\psi|`])
})
test('body pipes do not split formulas or truncate the last cell', () => {
  assert.deepEqual(rows(body)[1], ['$t$', String.raw`$\min|\psi|$`, 'raw winding'])
  assert.equal((md.render(body).match(/class="math-inline"/g) ?? []).length, 2)
})
test('all norm backslashes survive native table unescaping', () => {
  const source = String.raw`| norm | sized | note |
| --- | --- | --- |
| $\|\psi\|$ | $\left|x\right|$ | intact |`
  assert.deepEqual(math(md.parse(source, {})), [String.raw`\|\psi\|`, String.raw`\left|x\right|`])
  assert.deepEqual(rows(source)[1], [String.raw`$\|\psi\|$`, String.raw`$\left|x\right|$`, 'intact'])
  assert.ok(!md.render(source).includes('katex-error'))
})
test('parenthesis math in header and body uses the same shielding', () => {
  const source = String.raw`| \( |x| \) | note |
| --- | --- |
| \( \|x\| \) | intact |`
  assert.deepEqual(math(md.parse(source, {})), [' |x| ', String.raw` \|x\| `])
  assert.equal(rows(source)[1][1], 'intact')
})
test('body rows need not have any non-math pipes (one-column table)', () => {
  const source = String.raw`| formula |
| --- |
$|x|$`
  assert.deepEqual(rows(source), [['formula'], ['$|x|$']])
})
test('optional outer pipes and alignment retain native semantics', () => {
  const source = String.raw`$|x|$ | note
:--- | ---:
$\|y\|$ | intact`
  assert.deepEqual(rows(source), [['$|x|$', 'note'], [String.raw`$\|y\|$`, 'intact']])
  const cells = md.parse(source, {}).filter(t => ['th_open', 'td_open'].includes(t.type))
  assert.deepEqual(cells.map(t => t.attrGet('style')), [
    'text-align:left', 'text-align:right', 'text-align:left', 'text-align:right'
  ])
})

test('unclosed and escaped math stays on the native fallback path', () => {
  for (const value of [String.raw`$|x|`, String.raw`\$|x|$`]) {
    unchanged(`| a | b | c |\n| --- | --- | --- |\n| ${value} | keep | end |`)
  }
  const triple = String.raw`\\\( |x| \)`
  const tripleSource = `| a | b | c |\n| --- | --- | --- |\n| ${triple} | keep | end |`
  assert.deepEqual(rows(tripleSource)[1], [triple, 'keep', 'end'])
  assert.deepEqual(math(md.parse(tripleSource, {})), [' |x| '])
})
test('double/triple-dollar cells do not gain a new math dialect', () => {
  for (const value of ['$$|x|$$', '$$$|x|$$$']) {
    const source = `| formula | note |\n| --- | --- |\n| ${value} | keep |`
    unchanged(source)
    assert.deepEqual(math(md.parse(source, {})), [])
  }
})
test('currency, escaped dollars inside math, and multiple formulas', () => {
  const source = String.raw`| formula | note |
| --- | --- |
| $\text{\$}|x|$ and \( |y| \) | costs $20 |`
  assert.deepEqual(math(md.parse(source, {})), [String.raw`\text{\$}|x|`, ' |y| '])
  assert.equal(rows(source)[1][1], 'costs $20')
})
test('code spans use native GFM pipe behavior, not math shielding', () => {
  for (const value of ['`$|x|$`', '``$|x|$``', '`' + String.raw`$\|x\|$` + '`']) {
    unchanged(`| code | note |\n| --- | --- |\n| ${value} | keep |`)
  }
  const mixed = '| code | math | note |\n| --- | --- | --- |\n| `$x$` | $|y|$ | keep |'
  assert.deepEqual(math(md.parse(mixed, {})), ['|y|'])
  // A backtick in a formula is TeX content, not a Markdown code opener.
  const formula = String.raw`\text{` + String.fromCharCode(96) + '}|x|'
  assert.deepEqual(math(md.parse(`| $${formula}$ | note |\n| --- | --- |`, {})), [formula])
})
test('fences, indented code, HTML, references and non-tables are unchanged', () => {
  for (const source of [
    '```md\n' + original + '\n```',
    '~~~~md\n' + original + '\n~~~~',
    original.split('\n').map(line => '    ' + line).join('\n'),
    '<div>\n' + original + '\n</div>',
    '| $|x|$ | ordinary prose |',
    '| $|x|$ | two columns |\n| --- | --- | --- |',
    '[id]: https://example.test/$x|y$|z\n\n[id]',
    '[link](https://example.test/$x|y$) | $|z|$',
    '<span title="$x|y$">plain</span> | $|z|$',
    '`before\n| $|x|$ | ordinary code |\nafter`'
  ]) unchanged(source)
})
test('a valid table interrupts a paragraph before inline-code parsing, as in GFM', () => {
  const wrap = source => '`before\n' + source + '\nafter`'
  const withoutMathPipes = original.replace(String.raw`$\min|\psi|$`, '$x$')
  assert.ok(native.parse(wrap(withoutMathPipes), {}).some(t => t.type === 'table_open'))
  assert.ok(md.parse(wrap(original), {}).some(t => t.type === 'table_open'))
})
test('math in link labels is recognized, but destinations/HTML attrs are not', () => {
  const source = '| [$|x|$](https://example.test/) | note |\n| --- | --- |'
  assert.deepEqual(math(md.parse(source, {})), ['|x|'])
  for (const value of ['[x](https://example.test/$x|y$)', '<span title="$x|y$">x</span>']) {
    unchanged(`| a | b |\n| --- | --- |\n| ${value} | end |`)
  }
})
test('backticks in different cells do not suppress middle-cell math', () => {
  const source = '| a | b | c |\n| --- | --- | --- |\n| ` | $|x|$ | ` |'
  assert.deepEqual(rows(source)[1], ['`', '$|x|$', '`'])
  assert.deepEqual(math(md.parse(source, {})), ['|x|'])
  const codeDollar = '| a | b |\n| --- | --- |\n| `$` | $|x|$ |'
  assert.deepEqual(rows(codeDollar)[1], ['`$`', '$|x|$'])
  assert.deepEqual(math(md.parse(codeDollar, {})), ['|x|'])
})
test('next-cell math can extend past an obsolete whole-row token endpoint', () => {
  const tick = String.fromCharCode(96)
  const cases = [
    [tick, String.raw`$\text{` + tick + '}|x|$'],
    ['<span title="', String.raw`$\text{">}|x|$`],
    ['[label](/url "', String.raw`$\text{")}|x|$`]
  ]
  for (const [prefix, formula] of cases) {
    const source = `| a | b | c |\n| --- | --- | --- |\n| ${prefix} | ${formula} | keep |`
    assert.deepEqual(rows(source)[1], [prefix, formula, 'keep'])
    assert.deepEqual(math(md.parse(source, {})), [formula.slice(1, -1)])
  }
})
test('HTML and link fragments in different cells cannot consume middle-cell math', () => {
  for (const [left, right] of [['<span title="', '">'], ['[label](/', ')']]) {
    const source = `| a | b | c |\n| --- | --- | --- |\n| ${left} | $|x|$ | ${right} |`
    assert.deepEqual(rows(source)[1], [left, '$|x|$', right])
    assert.deepEqual(math(md.parse(source, {})), ['|x|'])
  }
})
test('literal dollars in HTML attributes and link targets cannot steal math openers', () => {
  for (const prefix of [
    '<span title="$">label</span>', '[label](https://example.test/$)',
    '<https://example.test/$>', '[label](/url "$ title")',
    '`$`', '``$``', String.raw`\$ money`
  ]) {
    const cell = prefix + ' $|x|$'
    const source = `| a | b |\n| --- | --- |\n| ${cell} | keep |`
    assert.deepEqual(rows(source)[1], [cell, 'keep'])
    assert.deepEqual(math(md.parse(source, {})), ['|x|'])
  }
})
test('reference identifiers are never shielded, regardless of definition order', () => {
  const table = '| a | b |\n| --- | --- |\n| $x$ | [label][id $|y|$] |'
  const definition = '[id $|y|$]: /url'
  unchanged(table + '\n\n' + definition)
  unchanged(definition + '\n\n' + table)
  unchanged(table)
  const labelMath = '| [$|x|$][id] | note |\n| --- | --- |'
  assert.deepEqual(math(md.parse(labelMath + '\n\n[id]: /url', {})), ['|x|'])
})
test('many small tables only allocate table-sized parse shadows', () => {
  const measured = new MarkdownIt()
  const rule = measured.block.ruler.__rules__.find(r => r.name === 'table')
  const originalRule = rule.fn
  const sizes = []
  measured.block.ruler.at('table', (state, start, end, silent) => {
    if (state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]).startsWith('| $t$')) {
      sizes.push(state.src.length)
    }
    return originalRule(state, start, end, silent)
  }, { alt: [...rule.alt] })
  measured.use(mathPlugin)
  for (const count of [100, 1000]) {
    sizes.length = 0
    const source = Array(count).fill(original).join('\n\n')
    const start = performance.now()
    const tokens = measured.parse(source, {})
    assert.equal(tokens.filter(t => t.type === 'table_open').length, count)
    assert.ok(Math.max(...sizes) <= original.length)
    console.log(`  ${count} small tables: ${(performance.now() - start).toFixed(1)} ms, max shadow ${Math.max(...sizes)} chars`)
  }
})
test('tables inside quotes and lists preserve the same formula text', () => {
  for (const source of [
    original.split('\n').map(line => '> ' + line).join('\n'),
    original.split('\n').map((line, index) => (index === 0 ? '- ' : '  ') + line).join('\n'),
    original.split('\n').map((line, index) => (index === 0 ? '> 1. ' : '>    ') + line).join('\n')
  ]) {
    assert.deepEqual(math(md.parse(source, {})), ['t', String.raw`\min|\psi|`])
    assert.equal(md.parse(source, {}).filter(t => t.type === 'table_open').length, 1)
  }
})
test('terminating heading, fence and following text never receive markers', () => {
  const source = original + '\n# next $|y|$\n\n```\n$|z|$\n```\n\nend'
  const tokens = md.parse(source, {})
  assert.deepEqual(math(tokens), ['t', String.raw`\min|\psi|`, '|y|'])
  assert.equal(tokens.find(t => t.type === 'fence').content, '$|z|$\n')
  assert.equal(tokens.find(t => t.type === 'table_open').map[1], 3)
})
test('marker collision, exhaustion and successive parses cannot corrupt input', () => {
  const first = String.fromCharCode(0xe000)
  const second = String.fromCharCode(0xe001)
  assert.equal(chooseTableMathMarker(''), first)
  assert.equal(chooseTableMathMarker(first), second)
  const source = original.replace('raw winding', first)
  assert.equal(rows(source)[0][2], first)
  assert.equal(rows(original)[0][2], 'raw winding')
  const allMarkers = Array.from({ length: 0x1900 }, (_, i) => String.fromCharCode(0xe000 + i)).join('')
  assert.equal(chooseTableMathMarker(allMarkers), null)
  unchanged(allMarkers + '\n\n' + original)
  const env = {}
  const before = JSON.stringify(env)
  md.parse(source, env)
  assert.equal(JSON.stringify(env), before)
  assert.equal(Object.getOwnPropertySymbols(env).length, 0)
  for (const token of md.parse(original, {})) assert.ok(!token.content.includes(first))
})
test('no shielding residue escapes a rejected or throwing table rule', () => {
  const broken = new MarkdownIt()
  const originalRule = broken.block.ruler.__rules__.find(r => r.name === 'table')
  const nativeTable = originalRule.fn
  let capturedState
  broken.block.ruler.at('table', (state, start, end, silent) => {
    capturedState = state
    if (!silent) throw new Error('test native table failure')
    return nativeTable(state, start, end, silent)
  }, { alt: [...originalRule.alt] })
  broken.use(mathPlugin)
  assert.throws(() => broken.parse(original, {}), /test native table failure/)
  assert.equal(capturedState.src, original)
})

test('CRLF, emoji, table line maps and local source offsets remain correct', () => {
  const source = '# 😀 heading\r\n\r\n' + original.replaceAll('\n', '\r\n')
  const tokens = md.parse(source, {})
  assert.deepEqual(tokens.find(t => t.type === 'table_open').map, [2, 5])
  assert.deepEqual(math(tokens), ['t', String.raw`\min|\psi|`])
  const absolute = md.render(original, { sourceLineOffset: 20 })
  assert.ok(absolute.includes('<table data-source-line="21" data-source-end-line="23">'))
  const local = md.render(original, { sourceLineOffset: 20, sourceLineMode: 'local' })
  assert.ok(local.includes('<table data-local-source-line="1" data-local-source-end-line="3">'))
  assert.deepEqual(findTopLevelHeadingLines(source), [1])
})
test('render-plan parser never cuts a large math table into chunks', () => {
  const source = '# Table\n\n' + original + '\n' + Array(450).fill(String.raw`| 1 | $\|x\|$ | end |`).join('\n') + '\n\n# End\ntext'
  const plan = buildPreviewRenderPlan(source)
  const table = md.parse(source, {}).find(t => t.type === 'table_open')
  assert.ok(table)
  assert.ok(plan.chunks.some(c => c.startLine <= table.map[0] + 1 && c.endLine >= table.map[1]))
  for (const chunk of plan.chunks) {
    assert.ok(!(chunk.endLine > table.map[0] && chunk.endLine < table.map[1]))
  }
})
test('canonical and chunk parses agree, and incomplete header can become a table', () => {
  const source = '# First\n\n' + original + '\n\n# Second\n\n' + body
  const fullMath = math(md.parse(source, {}))
  const chunkMath = buildPreviewRenderPlan(source).chunks.flatMap(chunk => {
    const part = source.split('\n').slice(chunk.startLine - 1, chunk.endLine).join('\n')
    return math(md.parse(part, {}))
  })
  assert.deepEqual(chunkMath, fullMath)
  const header = original.split('\n')[0]
  assert.ok(!md.parse(header, {}).some(t => t.type === 'table_open'))
  assert.ok(md.parse(header + '\n| --- | --- | --- |', {}).some(t => t.type === 'table_open'))
})
test('diagnostics keep exact TeX including pipes and norm backslashes', () => {
  const formula = String.raw`\badcommand\|x\|`
  const source = `| math | note |\n| --- | --- |\n| $${formula}$ | end |`
  assert.deepEqual(math(md.parse(source, {})), [formula])
  const errors = collectMathErrors(source)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].source, formula)
  assert.equal(errors[0].line, 3)
})

if (!process.exitCode) console.log(`ALL ${passed} TABLE MATH PIPE TESTS PASS`)
