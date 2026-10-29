import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lke-atomic-save-'))
try {
  const outfile = path.join(temp, 'atomic-file.mjs')
  await esbuild.build({
    entryPoints: [path.join(root, 'electron/atomic-file.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm'
  })
  const { atomicWriteUtf8 } = await import(pathToFileURL(outfile).href)
  const target = path.join(temp, 'nested', 'note.md')
  await atomicWriteUtf8(target, '旧内容\n')
  assert.equal(await fs.readFile(target, 'utf8'), '旧内容\n')
  await atomicWriteUtf8(target, '新内容\n第二行\n')
  assert.equal(await fs.readFile(target, 'utf8'), '新内容\n第二行\n')
  const leftovers = (await fs.readdir(path.dirname(target))).filter((name) => name.includes('.note.md.') && name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
  console.log('PASS atomic UTF-8 replacement, parent creation, and temporary cleanup')
  const expected = await fs.readFile(target, 'utf8')
  const originalOpen = fs.open
  const originalRename = fs.rename
  for (const stage of ['write', 'sync', 'EPERM', 'EEXIST', 'ENOTEMPTY', 'EIO']) {
    let renames = 0
    const injected = Object.assign(new Error(`Injected ${stage} failure`), { code: stage })
    fs.open = async (...args) => {
      const handle = await originalOpen(...args)
      if (stage === 'write') handle.writeFile = async () => { throw injected }
      if (stage === 'sync') handle.sync = async () => { throw injected }
      return handle
    }
    fs.rename = async (...args) => {
      renames++
      if (stage !== 'write' && stage !== 'sync') throw injected
      return originalRename(...args)
    }
    try {
      await assert.rejects(atomicWriteUtf8(target, 'must not replace the original'), error => error === injected)
    } finally {
      fs.open = originalOpen
      fs.rename = originalRename
    }
    assert.equal(await fs.readFile(target, 'utf8'), expected, `${stage}: original remains intact`)
    assert.equal(renames, stage === 'write' || stage === 'sync' ? 0 : 1, 'no destructive replacement retry')
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['note.md'], `${stage}: temporary cleanup`)
  }
  await atomicWriteUtf8(target, 'save still works after a failure')
  console.log('PASS write/sync/rename failure injection preserves original bytes and permits retry')
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
