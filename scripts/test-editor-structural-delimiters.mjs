import esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outfile = path.join(root, 'dist-electron', 'editor-structural-delimiters-test.mjs')

await esbuild.build({
  entryPoints: [path.join(root, 'src/editor.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm'
})

const { isStructuralMarkdownEditText } = await import(pathToFileURL(outfile).href)

function assert(name, condition, detail) {
  if (condition) console.log('PASS', name)
  else {
    console.error('FAIL', name, detail)
    process.exitCode = 1
  }
}

assert('opening \\[ is structural', isStructuralMarkdownEditText(String.raw`\[`), String.raw`\[`)
assert('closing \\] is structural', isStructuralMarkdownEditText(String.raw`\]`), String.raw`\]`)
assert('ordinary inline text remains local-safe', !isStructuralMarkdownEditText('x + y'), 'x + y')

if (!process.exitCode) console.log('ALL EDITOR STRUCTURAL DELIMITER PASS')
