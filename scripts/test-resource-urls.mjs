import assert from 'node:assert/strict'
import esbuild from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outfile = path.join(root, 'dist-electron/resource-url-test.mjs')
await esbuild.build({
  stdin: { contents: `export * from './src/markdown/resource-url'; export * from './electron/link-target';`, resolveDir: root, loader: 'ts' },
  outfile, bundle: true, platform: 'node', format: 'esm'
})
const { resolveResourceUrl: resolve, documentLinkTarget: target, RESOURCE_URI_PATTERN } = await import(pathToFileURL(outfile).href)
const bs = String.fromCharCode(92)
const base = 'C:/笔记 目录/notes'
const expectedBase = 'file:///C:/%E7%AC%94%E8%AE%B0%20%E7%9B%AE%E5%BD%95/'
assert.equal(resolve('assets/中文 图.png', base), expectedBase + 'notes/assets/%E4%B8%AD%E6%96%87%20%E5%9B%BE.png')
assert.equal(resolve('../图.pdf', base), expectedBase + '%E5%9B%BE.pdf')
assert.equal(resolve('C:/图片/a #1%.png', base), 'file:///C:/%E5%9B%BE%E7%89%87/a%20%231%25.png')
assert.equal(resolve('D:/a%20b.png', base), 'file:///D:/a%2520b.png')
assert.equal(resolve('D:/100%25.png', base), 'file:///D:/100%2525.png')
assert.equal(resolve('D:/literal%2520.png', base), 'file:///D:/literal%252520.png')
assert.equal(resolve(['D:', '图片', 'a.png'].join(bs), null), 'file:///D:/%E5%9B%BE%E7%89%87/a.png')
assert.equal(resolve(bs + bs + 'server' + bs + 'share' + bs + 'a b.png', null), 'file://server/share/a%20b.png')
assert.equal(resolve('/images/a.png', base), 'file:///C:/images/a.png')
assert.equal(resolve('/tmp/a b.png', null), 'file:///tmp/a%20b.png')
assert.equal(resolve('images/a.png', '/home/文档'), 'file:///home/%E6%96%87%E6%A1%A3/images/a.png')
assert.equal(resolve('a.png', 'C:/literal%20dir'), 'file:///C:/literal%2520dir/a.png')
assert.equal(resolve('a%23b.pdf#page=2', base), expectedBase + 'notes/a%23b.pdf#page=2')
assert.equal(resolve('https://example.com/a%20b.png', base), 'https://example.com/a%20b.png')
assert.equal(resolve('//example.com/a.png', base), 'https://example.com/a.png')
assert.equal(resolve('file:///C:/a%20b.png', base), 'file:///C:/a%20b.png')
assert.equal(resolve('#local', base), '#local')
assert.equal(resolve('a.png', null), 'a.png')
for (const scheme of ['javascript:alert(1)', 'vbscript:foo', 'powershell:foo', 'data:text/html,hi']) {
  assert.equal(RESOURCE_URI_PATTERN.test(scheme), false)
  assert.throws(() => target(scheme))
}
for (const protocol of ['https://example.test', 'http://example.test', 'mailto:a@example.test', 'tel:123']) {
  assert.equal(target(protocol).kind, 'external')
}
assert.throws(() => target('%invalid'))
assert.throws(() => target('file:///a%00b'))
const localPath = path.join(root, 'samples', '文档 # %20.pdf')
const opened = target(pathToFileURL(localPath).href)
assert.equal(opened.path, localPath)
assert.equal(opened.needsConfirmation, false)
for (const extension of ['cmd', 'pif', 'py', 'pyw', 'exe', 'lnk', 'url', 'jar', 'appref-ms']) {
  assert.equal(target(pathToFileURL(path.join(root, 'test.' + extension)).href).needsConfirmation, true)
}
console.log('PASS resource URL resolution, exact-once decoding and shell protocol policy')
