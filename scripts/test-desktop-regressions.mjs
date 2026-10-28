import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import esbuild from 'esbuild'
import electron from 'electron'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lke-desktop-regressions-'))
try {
  const base = path.join(temp, '笔记 空间 # %20')
  const assets = path.join(base, 'assets')
  await fs.mkdir(assets, { recursive: true })
  const image = path.join(assets, '图片 # %20.png')
  await fs.writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'))
  const link = path.join(assets, '文档 # %20.txt')
  await fs.writeFile(link, 'default application target')
  const relativeImage = 'assets/' + encodeURIComponent(path.basename(image))
  const relativeLink = 'assets/' + encodeURIComponent(path.basename(link))
  const slash = value => value.split(path.sep).join('/')
  const source = [
    '# Desktop regressions', '',
    `![absolute](<${slash(image)}>)`,
    `![relative](${relativeImage})`,
    `![file](${pathToFileURL(image).href})`,
    '<img alt="html" src="' + relativeImage + '">',
    '![reference][photo]', '',
    `[photo]: <${slash(image)}>`, '',
    `[relative-link](${relativeLink})`,
    `[absolute-link](<${slash(link)}>)`,
    `[file-link](${pathToFileURL(link).href})`,
    `[folder](<${pathToFileURL(assets).href}>)`,
    '[web](https://example.test/)',
    '[missing](missing.txt)',
    '[script](unsafe.cmd)', '[shortcut](unsafe.pif)', '[python](unsafe.py)', '[python-windowed](unsafe.pyw)', '',
    '<span id="target">anchor</span> [anchor](#target)', '',
    '![bad](javascript:alert(1))',
    '<img src="javascript:alert(1)" onerror="window.__unsafe = 1">',
    '<a href="javascript:alert(1)">unsafe</a>', ''
  ].join('\n')
  const document = path.join(base, 'report.md')
  await fs.writeFile(document, source)
  const bundle = path.join(temp, 'probe.js')
  await esbuild.build({
    stdin: { contents: `export { EditorView } from '@codemirror/view'; export { renderMarkdown } from './src/markdown/render';`, resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'browser', format: 'iife', globalName: 'DesktopProbe'
  })
  // Simulate an existing installation with the formerly supported 1000px cap.
  await fs.mkdir(path.join(temp, 'user-data'), { recursive: true })
  await fs.writeFile(path.join(temp, 'user-data', 'config.json'), JSON.stringify({ previewMaxWidth: 1000 }))
  const specFile = path.join(temp, 'spec.json')
  await fs.writeFile(specFile, JSON.stringify({ root, temp, base, assets, image, link, document, bundle, source,
    layoutOnly: process.argv.includes('--layout-only') }))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.LIGHT_EDITOR_DEV
  const result = spawnSync(electron, [path.join(root, 'scripts/desktop-regressions.cjs'), specFile], {
    env, encoding: 'utf8', timeout: 90000
  })
  console.log(result.stdout)
  if (result.stderr) console.error(result.stderr)
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'Electron desktop regressions failed')
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
