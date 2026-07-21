import esbuild from 'esbuild'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outfile = path.join(root, 'dist-electron', 'math-preprocess-test.mjs')

await esbuild.build({
  entryPoints: [path.join(root, 'src/markdown/math-preprocess.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm'
})

const { preprocessMath, wrapCjkAsText, ensureDisplayLinebreaks } = await import(
  pathToFileURL(outfile).href
)

function assert(name, cond, detail) {
  if (!cond) {
    console.error('FAIL', name, detail)
    process.exitCode = 1
  } else {
    console.log('PASS', name)
  }
}

const cjk = wrapCjkAsText(String.raw`误差 \le \varepsilon`)
assert('cjk wrap', cjk.includes(String.raw`\text{误差}`), cjk)

const already = wrapCjkAsText(String.raw`\text{误差}`)
assert('no double wrap text', already === String.raw`\text{误差}`, already)

const mixed = wrapCjkAsText(String.raw`状态量 U^{n+1}`)
assert('mixed cjk', mixed.includes(String.raw`\text{状态量}`), mixed)

const br = ensureDisplayLinebreaks(String.raw`a = b + c \\
d = e + f`)
assert('auto aligned', br.includes(String.raw`\begin{aligned}`) && br.includes(String.raw`\\`), br)

const aligned = String.raw`\begin{aligned}
E &= mc^2 \\
F &= ma
\end{aligned}`
const br2 = ensureDisplayLinebreaks(aligned)
assert('skip existing aligned', br2 === aligned.trim() || !br2.includes(String.raw`\begin{aligned}
\begin{aligned}`), br2)

const slash = ensureDisplayLinebreaks(String.raw`x = 1 //
y = 2`)
assert('// to \\', slash.includes(String.raw`\\`) && slash.includes(String.raw`\begin{aligned}`), slash)

const inline = preprocessMath(String.raw`误差 \le \varepsilon`, false)
assert('inline preprocess', inline.includes(String.raw`\text{误差}`) && !inline.includes('aligned'), inline)

const display = preprocessMath(String.raw`a=1 \\
b=2`, true)
assert('display preprocess', display.includes('aligned'), display)

if (!process.exitCode) console.log('ALL PREPROCESS PASS')
