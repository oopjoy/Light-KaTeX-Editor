import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import esbuild from 'esbuild'
import electron from 'electron'
import { createTestPng } from './image-fixture.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lke-large-benchmark-'))
try {
  const bundle = path.join(temp, 'probe.js')
  await esbuild.build({
    stdin: { contents: "export { EditorView } from '@codemirror/view'", resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'browser', format: 'iife', globalName: 'DesktopProbe'
  })
  await fs.writeFile(path.join(temp, 'visible.png'), createTestPng())
  const cases = {
    markdown5000: Array.from({ length: 5000 }, (_, i) => i % 25 === 0
      ? '# Section ' + i : 'Line ' + i + ' with **text** and a [link](https://example.test).').join('\n'),
    formulas1000: Array.from({ length: 1000 }, (_, i) => '$x_' + i + ' + \\min|\\psi|$').join('\n\n'),
    tables800: '| a | b | c |\n| --- | --- | --- |\n' +
      Array.from({ length: 800 }, (_, i) => '| ' + i + ' | $|x_' + i + '|$ | row |').join('\n'),
    htmlAndImages: Array.from({ length: 300 }, (_, i) =>
      '<figure style="display:inline-flex;width:48%"><img src="visible.png" style="width:48%"><figcaption>Figure ' +
      i + '</figcaption></figure>').join('\n')
  }
  const results = []
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.LIGHT_EDITOR_DEV
  for (const [name, source] of Object.entries(cases)) {
    console.log('Benchmarking ' + name + '...')
    const document = path.join(temp, name + '.md')
    const spec = path.join(temp, name + '.json')
    await fs.writeFile(document, source)
    await fs.writeFile(spec, JSON.stringify({ root, temp, bundle, name, document, source }))
    const result = spawnSync(electron, [path.join(root, 'scripts/benchmark-large-doc.cjs'), spec], {
      env, encoding: 'utf8', timeout: 150000
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'benchmark process failed')
    const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('BENCHMARK_RESULT '))
    if (!line) throw new Error('Missing benchmark result: ' + result.stdout)
    const metrics = JSON.parse(line.slice('BENCHMARK_RESULT '.length))
    results.push(metrics)
    console.log(JSON.stringify(metrics))
  }
  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'Real Electron application: startup to laid-out preview, native insertText to editor state, input to preview, and canonical refresh; fonts and local images awaited. Single run per case; timings include IPC/polling overhead.',
    results
  }
  await fs.mkdir(path.join(root, 'reports'), { recursive: true })
  await fs.writeFile(path.join(root, 'reports/benchmark-latest.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('Saved reports/benchmark-latest.json')
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
