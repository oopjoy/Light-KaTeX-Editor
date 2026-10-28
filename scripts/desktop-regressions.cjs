const { app, BrowserWindow, Menu, shell, dialog } = require('electron')
const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
app.setPath('userData', path.join(spec.temp, 'user-data'))
app.setPath('sessionData', path.join(spec.temp, 'session-data'))
process.argv = [process.argv[0], spec.root, spec.document]
const opened = [], external = [], messages = []
// Verify default-app dispatch without actually launching unrelated programs.
shell.openPath = async file => { opened.push(file); return existsSync(file) ? '' : 'Test: file not found' }
shell.openExternal = async url => { external.push(url) }
dialog.showMessageBox = async (_window, options) => { messages.push(options); return { response: 0 } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    try { const value = await Promise.race([Promise.resolve().then(check), delay(1000).then(() => null)]); if (value) return value } catch { /* page boot */ }
    await delay(50)
  }
  throw new Error('Timed out: ' + label)
}
let win, preview
const view = `DesktopProbe.EditorView.findFromDOM(document.querySelector('.cm-editor'))`
const evaluate = code => win.webContents.executeJavaScript(code, true)
const doc = () => evaluate(`${view}.state.doc.toString()`)
async function menu(id, window = win) {
  const item = Menu.getApplicationMenu().getMenuItemById(id)
  assert.ok(item, id)
  assert.notEqual(item.role, 'undo')
  assert.notEqual(item.role, 'redo')
  assert.equal(item.registerAccelerator, false)
  item.click(item, window, {})
  await delay(100)
}
async function edit(text) {
  await evaluate(`(() => { const v = ${view}; v.focus(); v.dispatch({ changes: { from: v.state.doc.length, insert: ${JSON.stringify(text)} }, selection: { anchor: v.state.doc.length + ${text.length} }, userEvent: 'input.type' }); })()`)
}
async function key(keyCode, modifiers) {
  win.focus()
  win.webContents.focus()
  await evaluate(`${view}.focus()`)
  await until(() => evaluate(`${view}.hasFocus`), 'keyboard focus')
  await evaluate(`window.__testKeys = []; window.addEventListener('keydown', e => { setTimeout(() => window.__testKeys.push({key:e.key, ctrl:e.ctrlKey, shift:e.shiftKey, target:e.target.className, prevented:e.defaultPrevented}), 0) }, {once:true, capture:true})`)
  const before = await doc()
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await until(() => evaluate(`window.__testKeys.length > 0`), 'keyboard event delivery')
  if (await doc() === before) console.log('Keyboard no-op diagnostic:', JSON.stringify(await evaluate(`window.__testKeys`)))
}
async function clickLink(text, button = 0) {
  await preview.webContents.executeJavaScript(`(() => {
    const a = [...document.querySelectorAll('#preview-root a')].find(a => a.textContent === ${JSON.stringify(text)});
    if (!a) throw new Error('Missing anchor');
    a.dispatchEvent(new MouseEvent(${JSON.stringify(button === 1 ? 'auxclick' : 'click')}, { bubbles: true, cancelable: true, button: ${button} }));
  })()`)
  await delay(100)
}
const watchdog = setTimeout(() => { console.error('Desktop regression timeout'); app.exit(1) }, 70000)
;(async () => {
  await import(pathToFileURL(path.join(spec.root, 'dist-electron/main.js')).href)
  await app.whenReady()
  win = await until(() => BrowserWindow.getAllWindows()[0], 'main window')
  await until(() => win.webContents.executeJavaScript(`!!window.lightEditor && !!document.querySelector('.cm-content')`), 'editor ready')
  await evaluate(readFileSync(spec.bundle, 'utf8'))
  await until(async () => (await doc()) === spec.source, 'source file opened')
  preview = win.contentView.children.find(child => child.webContents)
  assert.ok(preview)
  await until(() => preview.webContents.executeJavaScript(`document.querySelectorAll('#preview-root img[alt]').length >= 5`), 'preview render')

  if (!spec.layoutOnly) {
  await edit('MENU-HISTORY')
  await until(() => evaluate(`document.title.startsWith('●')`), 'dirty title')
  await evaluate(`document.querySelector('[data-menu="编辑"]').focus()`)
  await menu('edit-undo')
  assert.equal(await doc(), spec.source)
  assert.equal(await evaluate(`document.title.startsWith('●')`), false)
  assert.equal(await evaluate(`document.activeElement === ${view}.contentDOM`), true)
  await menu('edit-redo')
  assert.equal(await doc(), spec.source + 'MENU-HISTORY')
  await until(() => preview.webContents.executeJavaScript(`document.getElementById('preview-root').textContent.includes('MENU-HISTORY')`), 'redo updates preview')
  preview.webContents.focus()
  await menu('edit-undo')
  assert.equal(await doc(), spec.source)
  await until(() => preview.webContents.executeJavaScript(`!document.getElementById('preview-root').textContent.includes('MENU-HISTORY')`), 'undo updates preview')
  await menu('edit-undo')
  assert.equal(await doc(), spec.source, 'empty history is a no-op')
  console.log('PASS real Electron menu -> preload -> CodeMirror undo/redo, dirty flag, focus and Preview')

  await edit('FIRST')
  await delay(650)
  await edit('SECOND')
  await key('Z', ['control'])
  assert.equal(await doc(), spec.source + 'FIRST', 'Ctrl+Z applies exactly one history event')
  await key('Y', ['control'])
  assert.equal(await doc(), spec.source + 'FIRSTSECOND')
  await key('Z', ['control'])
  await key('Z', ['control', 'shift'])
  assert.equal(await doc(), spec.source + 'FIRSTSECOND')
  await menu('edit-undo')
  await edit('REPLACED')
  await menu('edit-redo')
  assert.equal(await doc(), spec.source + 'FIRSTREPLACED', 'new edit invalidates redo')
  console.log('PASS keyboard Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z and menu share a single history')
  const sourceBeforeInputUndo = await doc()
  await evaluate(`(() => { const input = document.createElement('input'); input.id = 'history-input-test'; document.body.append(input); input.focus(); })()`)
  await win.webContents.insertText('query')
  assert.equal(await evaluate(`document.getElementById('history-input-test').value`), 'query')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] })
  await until(() => evaluate(`document.getElementById('history-input-test').value === ''`), 'native input undo')
  assert.equal(await doc(), sourceBeforeInputUndo, 'input shortcuts do not undo source')
  await evaluate(`document.getElementById('history-input-test').remove()`)
  console.log('PASS native input Ctrl+Z is not stolen by the source-menu accelerator')

  console.log('Checking image loading in Preview')
  const loaded = await until(() => preview.webContents.executeJavaScript(`(() => {
    const imgs = [...document.querySelectorAll('#preview-root img[alt]')].filter(i => ['absolute','relative','file','html','reference'].includes(i.alt));
    return imgs.length === 5 && imgs.every(i => i.complete && i.naturalWidth === 1) ? imgs.map(i => ({alt:i.alt, src:i.src})) : null;
  })()`), 'all local image variants load')
  assert.ok(loaded.every(image => image.src === pathToFileURL(spec.image).href))
  assert.equal(await preview.webContents.executeJavaScript(`!!window.__unsafe || !!document.querySelector('#preview-root [onerror], #preview-root [href^="javascript:"], #preview-root [src^="javascript:"]')`), false)
  const initialUrl = preview.webContents.getURL()
  for (const text of ['relative-link', 'absolute-link', 'file-link']) {
    await clickLink(text)
    assert.equal(opened.at(-1), spec.link)
  }
  await clickLink('file-link', 1)
  assert.equal(opened.at(-1), spec.link)
  await clickLink('folder')
  assert.equal(opened.at(-1), spec.assets)
  await clickLink('web')
  assert.equal(external.at(-1), 'https://example.test/')
  await clickLink('anchor')
  assert.equal(preview.webContents.getURL(), initialUrl)
  const openCount = opened.length
  for (const label of ['script', 'shortcut', 'python', 'python-windowed']) {
    await clickLink(label)
    assert.equal(opened.length, openCount, label + ' launch requires confirmation, default cancel')
    assert.equal(messages.at(-1).type, 'warning')
  }
  await clickLink('missing')
  assert.equal(messages.at(-1).type, 'error')
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'local documents not opened as editor windows')
  assert.equal(preview.webContents.getURL(), initialUrl, 'preview never navigates away')
  console.log('PASS local images (drive/relative/file/HTML/reference), default-app links and protocol safety')
  }

  assert.equal((await evaluate(`window.lightEditor.getConfig()`)).previewMaxWidth, 0, 'legacy config cap is retired')
  assert.equal((await evaluate(`window.lightEditor.setConfig({previewMaxWidth: 1000})`)).previewMaxWidth, 0)
  const layout = () => evaluate(`(() => {
    const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width} };
    return { workspace:rect('workspace'), editor:rect('editor-pane'), splitter:rect('splitter'),
      preview:rect('preview-pane'), host:rect('preview-host'), cm:document.querySelector('.cm-editor').getBoundingClientRect().width };
  })()`)
  for (const width of [1160, 2800, 1600]) {
    win.setContentSize(width, 900)
    for (const mode of ['split', 'preview', 'editor']) {
      win.webContents.send('menu:view-mode', mode)
      await until(async () => {
        const data = await layout()
        if (mode === 'editor') return Math.abs(data.editor.width - data.workspace.width) < 1 && !preview.getVisible()
        return Math.abs(preview.getBounds().width - data.host.width) < 2 && preview.getVisible()
      }, 'full-width native view after resize/mode change')
      const data = await layout()
      assert.ok(Math.abs(data.editor.width + data.splitter.width + data.preview.width - data.workspace.width) < 1)
      if (mode !== 'editor') {
        assert.ok(Math.abs(data.host.width - data.preview.width) < 1, 'host has no reading-width cap')
        assert.ok(Math.abs(preview.getBounds().x + preview.getBounds().width - data.workspace.right) < 2, 'native view reaches window edge')
        const rootWidth = await preview.webContents.executeJavaScript(`(() => {
          const root = document.getElementById('preview-root'), style = getComputedStyle(root);
          return {width:root.getBoundingClientRect().width,viewport:document.documentElement.clientWidth,max:style.maxWidth,ml:style.marginLeft,mr:style.marginRight};
        })()`)
        assert.ok(Math.abs(rootWidth.width - rootWidth.viewport) < 1, 'Preview body fills viewport')
        assert.equal(rootWidth.max, 'none')
        assert.equal(rootWidth.ml, '0px')
        assert.equal(rootWidth.mr, '0px')
      }
      if (mode !== 'preview') assert.ok(Math.abs(data.cm - data.editor.width) < 1, 'source editor fills its pane')
    }
  }
  win.webContents.send('menu:view-mode', 'split')
  await until(() => evaluate(`document.getElementById('workspace').dataset.viewMode === 'split'`), 'restore split')
  for (const theme of ['dark', 'light']) {
    win.webContents.send('menu:set-theme', theme)
    await until(() => preview.webContents.executeJavaScript(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`), 'theme sync')
    const data = await layout()
    assert.ok(Math.abs(data.host.width - data.preview.width) < 1)
  }
  for (const ratio of [0.3, 0.7, 0.5]) {
    await evaluate(`(() => {
      const workspace = document.getElementById('workspace'), r = workspace.getBoundingClientRect();
      document.getElementById('splitter').dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
      window.dispatchEvent(new MouseEvent('mousemove', {clientX:r.left + r.width * ${ratio}}));
      window.dispatchEvent(new MouseEvent('mouseup'));
    })()`)
    await until(async () => {
      const data = await layout()
      return Math.abs(data.editor.width - data.workspace.width * ratio) < 2 && Math.abs(preview.getBounds().width - data.host.width) < 2
    }, 'dragged split fills native Preview')
    const data = await layout()
    assert.ok(Math.abs(data.host.width - data.preview.width) < 1)
  }
  console.log('PASS 1000px legacy-config migration, wide/narrow native bounds, all view modes, split dragging and both themes')

  const htmlPath = path.join(spec.temp, 'export.html')
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: htmlPath })
  await evaluate(`window.lightEditor.exportHtml(${JSON.stringify(spec.source)}, ${JSON.stringify(spec.base)}, 'test')`)
  const html = readFileSync(htmlPath, 'utf8')
  assert.ok(html.includes(pathToFileURL(spec.image).href))
  assert.ok(html.includes(pathToFileURL(spec.link).href))
  assert.ok(!html.includes('max-width: 1000px'), 'HTML export has no old reading cap')
  const pdfPath = path.join(spec.temp, 'export.pdf')
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: pdfPath })
  await evaluate(`window.lightEditor.exportPdf(${JSON.stringify(spec.source)}, ${JSON.stringify(spec.base)}, 'test')`)
  assert.equal(readFileSync(pdfPath).subarray(0, 5).toString(), '%PDF-')
  assert.equal(readFileSync(spec.document, 'utf8'), spec.source, 'original Markdown remains unchanged')
  console.log('PASS real HTML/PDF export paths and untouched source file')

  const beforeModal = await doc()
  win.webContents.send('menu:settings')
  await until(() => evaluate(`!document.querySelector('.settings-overlay').hidden`), 'settings modal')
  assert.equal(await evaluate(`!!document.querySelector('[data-key="previewMaxWidth"]')`), false, 'retired width setting absent')
  await menu('edit-undo')
  assert.equal(await doc(), beforeModal, 'modal cannot silently undo the source')
  await evaluate(`document.querySelector('.settings-close').click()`)
  await evaluate(`window.lightEditor.newWindow()`)
  const second = await until(() => BrowserWindow.getAllWindows().find(w => w.id !== win.id), 'second window')
  await until(() => second.webContents.executeJavaScript(`!!document.querySelector('.cm-content')`), 'second editor')
  await second.webContents.executeJavaScript(readFileSync(spec.bundle, 'utf8'))
  const secondBefore = await second.webContents.executeJavaScript(`${view}.state.doc.toString()`)
  await second.webContents.executeJavaScript(`(() => { const v = ${view}; v.dispatch({changes: { from: 0, insert: 'SECOND-WINDOW' }, userEvent: 'input.type'}); })()`)
  await menu('edit-undo', second)
  assert.equal(await second.webContents.executeJavaScript(`${view}.state.doc.toString()`), secondBefore)
  assert.equal(await doc(), beforeModal)
  second.destroy()
  console.log('PASS settings guard and per-window history isolation')
})().then(() => {
  clearTimeout(watchdog)
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  clearTimeout(watchdog)
  app.exit(1)
})
