import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import esbuild from 'esbuild'
import electron from 'electron'
import { createTestPng } from './image-fixture.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lke-desktop-regressions-'))
try {
  const base = path.join(temp, '笔记 空间 # %20')
  const assets = path.join(base, 'assets')
  await fs.mkdir(assets, { recursive: true })
  const image = path.join(assets, '图片 # %20.png')
  await fs.writeFile(image, createTestPng())
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
    '<div class="gallery" style="display:flex;gap:8px;justify-content:center">',
    '<figure style="width:48%;margin:0"><img alt="gallery-a" src="' + relativeImage + '" style="width:100%"><figcaption>图 A</figcaption></figure>',
    '<figure style="width:48%;margin:0"><img alt="gallery-b" src="' + relativeImage + '" style="width:100%"><figcaption>图 B</figcaption></figure>',
    '</div>', '',
    '![reference][photo]', '',
    `[photo]: <${slash(image)}>`, '',
    '<p class="centered" style="text-align:center"><img alt="centered" src="' + relativeImage + '" style="width:48%"></p>', '',
    '<div class="float-layout"><img alt="floating" src="' + relativeImage + '" style="float:right;width:160px;margin:0 0 8px 12px"><span>Floating text beside the image.</span><br style="clear:both"></div>', '',
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
  if (process.argv.includes('--recovery-only')) {
    const crypto = await import('node:crypto')
    const key = crypto.createHash('sha256').update(path.normalize(document).toLowerCase(), 'utf8').digest('hex')
    await fs.mkdir(path.join(temp, 'user-data', 'recovery'), { recursive: true })
    await fs.writeFile(path.join(temp, 'user-data', 'recovery', `${key}.json`), JSON.stringify({
      path: document, content: source + '\\nRECOVERED', savedContent: source,
      lineEnding: 'lf', sourceMtimeMs: 0, updatedAt: Date.now()
    }))
  }
  const specFile = path.join(temp, 'spec.json')
  await fs.writeFile(specFile, JSON.stringify({ root, temp, base, assets, image, link, document, bundle, source,
    layoutOnly: process.argv.includes('--layout-only'), recoveryOnly: process.argv.includes('--recovery-only'),
    lifecycleOnly: process.argv.includes('--lifecycle-only'), crashStage: process.argv.includes('--crash-stage') }))
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
  if (process.argv.includes('--lifecycle-only')) {
    // The first process generated a real snapshot and exited abruptly. Reopen the same file.
    const spec = JSON.parse(await fs.readFile(specFile, 'utf8'))
    await fs.writeFile(specFile, JSON.stringify({ ...spec, lifecycleOnly: false, crashStage: true }))
    const reopened = spawnSync(electron, [path.join(root, 'scripts/desktop-regressions.cjs'), specFile], { env, encoding: 'utf8', timeout: 90000 })
    console.log(reopened.stdout)
    if (reopened.stderr) console.error(reopened.stderr)
    if (reopened.error) throw reopened.error
    assert.equal(reopened.status, 0, 'crash recovery reopen failed')
  }
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
