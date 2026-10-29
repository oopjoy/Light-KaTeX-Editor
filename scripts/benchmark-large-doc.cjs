const { app, BrowserWindow, ipcMain } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const assert = require('node:assert/strict')
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
app.setPath('userData', path.join(spec.temp, 'user-data-' + spec.name))
app.setPath('sessionData', path.join(spec.temp, 'session-data-' + spec.name))
process.argv = [process.argv[0], spec.root, spec.document]
const started = performance.now()
let phase = 'startup'
function setPhase(value) {
  phase = value
  writeFileSync(path.join(spec.temp, spec.name + '.progress'), value)
}
const completions = []
ipcMain.on('preview:render-complete', (_event, result) => completions.push(result))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const result = await check().catch(() => null)
    if (result) return result
    await delay(20)
  }
  throw new Error('Benchmark timed out: ' + label)
}
const timeout = setTimeout(() => { console.error('Benchmark timeout during ' + phase); app.exit(1) }, 120000)
;(async () => {
  await import(pathToFileURL(path.join(spec.root, 'dist-electron/main.js')).href)
  await app.whenReady()
  const win = await until(async () => BrowserWindow.getAllWindows()[0], 'main window')
  await until(() => win.webContents.executeJavaScript("!!document.querySelector('.cm-content')"), 'editor')
  await win.webContents.executeJavaScript(readFileSync(spec.bundle, 'utf8'))
  const view = "DesktopProbe.EditorView.findFromDOM(document.querySelector('.cm-editor'))"
  await until(() => win.webContents.executeJavaScript(view + '.state.doc.toString() === ' + JSON.stringify(spec.source)), 'document open')
  const preview = win.contentView.children.find(child => child.webContents)
  await until(async () => completions.length > 0, 'initial Preview render')
  setPhase('initial layout/fonts/images')
  assert.equal(completions.at(-1).ok, true, 'initial preview rendered successfully')
  async function settlePreview() {
    return preview.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      const images = [...document.querySelectorAll('#preview-root img')];
      await Promise.all(images.map(i => i.decode()));
      if (images.some(i => !i.naturalWidth)) throw new Error('Image failed to load');
      // Force layout directly: an offscreen native view may suspend animation frames.
      document.getElementById('preview-root').getBoundingClientRect();
      return { images: images.length, formulas:document.querySelectorAll('#preview-root .katex').length };
    })()`)
  }
  const rendered = await settlePreview()
  setPhase('native input')
  const firstOpenMs = performance.now() - started
  if (spec.name === 'formulas1000') assert.equal(rendered.formulas, 1000)
  if (spec.name === 'htmlAndImages') assert.equal(rendered.images, 300)
  await win.webContents.executeJavaScript(`(() => {const v=${view};v.focus();v.dispatch({selection:{anchor:v.state.doc.length}});})()`)
  const count = completions.length
  const inputStarted = performance.now()
  await win.webContents.insertText('BENCH-INPUT')
  await until(() => win.webContents.executeJavaScript(view + ".state.doc.toString().endsWith('BENCH-INPUT')"), 'native text input')
  const inputResponseMs = performance.now() - inputStarted
  setPhase('input Preview completion')
  await until(async () => completions.length > count, 'input Preview completion')
  assert.equal(completions.at(-1).ok, true, 'input preview rendered successfully')
  await settlePreview()
  const inputToPreviewMs = performance.now() - inputStarted
  setPhase('canonical refresh')
  const beforeRefresh = completions.length
  const refreshStarted = performance.now()
  await win.webContents.executeJavaScript('window.lightEditor.updatePreview(' + JSON.stringify({requestId:100000,version:100000,source:spec.source,baseDir:path.dirname(spec.document),mode:'canonical'}) + ')')
  await until(async () => completions.length > beforeRefresh && completions.at(-1).requestId === 100000, 'canonical refresh')
  assert.equal(completions.at(-1).ok, true, 'canonical preview rendered successfully')
  await settlePreview()
  const fullRefreshMs = performance.now() - refreshStarted
  const round = n => Math.round(n * 100) / 100
  console.log('BENCHMARK_RESULT ' + JSON.stringify({name:spec.name,lines:spec.source.split('\n').length,chars:spec.source.length,...rendered,firstOpenMs:round(firstOpenMs),inputResponseMs:round(inputResponseMs),inputToPreviewMs:round(inputToPreviewMs),fullRefreshMs:round(fullRefreshMs)}))
  clearTimeout(timeout)
  app.exit(0)
})().catch(error => {console.error(error);clearTimeout(timeout);app.exit(1)})
