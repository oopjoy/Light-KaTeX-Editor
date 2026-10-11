import esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outfile = path.join(root, 'dist-electron', 'math-errors-delimiters-test.mjs')

await esbuild.build({
  entryPoints: [path.join(root, 'src/markdown/math-errors.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm'
})

const { collectMathErrors } = await import(pathToFileURL(outfile).href)

function assert(name, condition, detail) {
  if (condition) console.log('PASS', name)
  else {
    console.error('FAIL', name, detail)
    process.exitCode = 1
  }
}

assert(
  'valid display bracket has no error',
  collectMathErrors(String.raw`\[
\frac{1}{2}
\]`).length === 0,
  collectMathErrors(String.raw`\[
\frac{1}{2}
\]`)
)
assert(
  'invalid display bracket is diagnosed',
  collectMathErrors(String.raw`\[
\badcommand
\]`).length === 1,
  collectMathErrors(String.raw`\[
\badcommand
\]`)
)
assert(
  'invalid quote display bracket is diagnosed',
  collectMathErrors(`> \\[\n> \\badcommand\n> \\]`).length === 1,
  collectMathErrors(`> \\[\n> \\badcommand\n> \\]`)
)
assert(
  'invalid list display bracket is diagnosed',
  collectMathErrors(`- \\[\n  \\badcommand\n  \\]`).length === 1,
  collectMathErrors(`- \\[\n  \\badcommand\n  \\]`)
)
assert(
  'mid-paragraph bracket remains undiagnosed literal',
  collectMathErrors(String.raw`Text \[\badcommand\]`).length === 0,
  collectMathErrors(String.raw`Text \[\badcommand\]`)
)
assert(
  'trailing-text bracket remains undiagnosed literal',
  collectMathErrors(String.raw`\[\badcommand\] trailing`).length === 0,
  collectMathErrors(String.raw`\[\badcommand\] trailing`)
)
assert(
  'malformed closer with later \\] remains undiagnosed literal',
  collectMathErrors(`\\[\\badcommand\\] trailing\n\\]`).length === 0,
  collectMathErrors(`\\[\\badcommand\\] trailing\n\\]`)
)

if (!process.exitCode) console.log('ALL MATH ERROR DELIMITER PASS')
