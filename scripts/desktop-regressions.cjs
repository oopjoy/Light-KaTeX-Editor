const { app, BrowserWindow, Menu, shell, dialog } = require('electron')
const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const assert = require('node:assert/strict')
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
app.setPath('userData', path.join(spec.temp, 'user-data'))
app.setPath('sessionData', path.join(spec.temp, 'session-data'))
process.argv = [process.argv[0], spec.root, spec.document]
const opened = [], external = [], messages = []
// Verify default-app dispatch without actually launching unrelated programs.
shell.openPath = async file => { opened.push(file); return existsSync(file) ? '' : 'Test: file not found' }
shell.openExternal = async url => { external.push(url) }
let dialogResponse = 0
dialog.showMessageBox = async (_window, options) => { messages.push(options); return { response: dialogResponse } }
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
const evaluate = async code => {
  try { return await win.webContents.executeJavaScript(code, true) }
  catch (error) { console.error('MAIN EVAL FAILED:', code.slice(0, 220), error); throw error }
}
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
  win.show()
  win.focus()
  app.focus({ steal: true })
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
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => console.error('MAIN CONSOLE:', level, message, sourceId + ':' + line))
  win.webContents.on('render-process-gone', (_event, details) => console.error('MAIN RENDER GONE:', details))
  win.webContents.on('did-fail-load', (_event, code, description, url) => console.error('MAIN LOAD FAILED:', code, description, url))
  await until(() => win.webContents.executeJavaScript(`!!window.lightEditor && !!document.querySelector('.cm-content')`), 'editor ready')
  await evaluate(readFileSync(spec.bundle, 'utf8'))
  const expectedOpen = spec.crashStage ? spec.source + '\nCRASH-RECOVERED' : spec.recoveryOnly ? spec.source + '\\nRECOVERED' : spec.source
  await until(async () => (await doc()) === expectedOpen, 'source file opened')
  preview = win.contentView.children.find(child => child.webContents)
  assert.ok(preview)
  preview.webContents.on('console-message', (_event, level, message, line, sourceId) => console.error('PREVIEW CONSOLE:', level, message, sourceId + ':' + line))
  preview.webContents.on('render-process-gone', (_event, details) => console.error('PREVIEW RENDER GONE:', details))
  assert.equal(await evaluate('window.lightEditor.isSandboxed()'), true, 'main renderer is sandboxed')
  assert.equal(await preview.webContents.executeJavaScript('window.lightPreview.isSandboxed()'), true, 'preview renderer is sandboxed')
  await until(() => preview.webContents.executeJavaScript(`document.querySelectorAll('#preview-root img[alt]').length >= 5`), 'preview render')

  if (spec.recoveryOnly || spec.crashStage) {
    const recovered = expectedOpen
    assert.equal(await doc(), recovered, 'recovery snapshot is offered and restored')
    assert.equal(await evaluate('document.title.startsWith(\'●\')'), true)
    win.webContents.send('menu:save')
    await until(() => readFileSync(spec.document, 'utf8') === recovered, 'recovered content saved')
    await until(() => require('node:fs').readdirSync(path.join(spec.temp, 'user-data', 'recovery')).length === 0, 'snapshot cleanup after save')
    assert.ok(messages.some(message => message.title === '发现恢复快照'), 'actual recovery prompt was shown')
    console.log(spec.crashStage ? 'PASS crash-generated snapshot survives process exit, prompts on reopen and saves safely' : 'PASS recovery snapshot prompt, dirty state, save and cleanup')
    return
  }

  if (spec.lifecycleOnly) {
    const recovery = file => path.join(spec.temp, 'user-data', 'recovery', createHash('sha256').update(path.normalize(file).toLowerCase()).digest('hex') + '.json')
    const snapshot = file => JSON.parse(readFileSync(recovery(file), 'utf8'))
    let continuousSnapshot = false
    for (let i = 0; i < 10; i++) {
      await edit('T')
      await delay(400)
      continuousSnapshot ||= existsSync(recovery(spec.document))
    }
    assert.ok(continuousSnapshot, 'snapshots are written during continuous typing')
    await until(async () => snapshot(spec.document).content === await doc(), 'snapshot catches latest edits')
    for (let i = 0; i < 20 && await doc() !== spec.source; i++) await menu('edit-undo')
    assert.equal(await doc(), spec.source)
    await until(() => evaluate("!document.title.startsWith('●')"), 'undo is clean')
    await until(() => !existsSync(recovery(spec.document)), 'undo clears stale snapshot')
    console.log('PASS continuous typing snapshots and undo-to-disk cleanup')

    await edit('SAVE-AS-CONTENT')
    await until(() => existsSync(recovery(spec.document)), 'snapshot before Save As')
    const newPath = path.join(spec.base, 'saved-as.md')
    dialog.showSaveDialog = async () => ({ canceled:false, filePath:newPath })
    win.webContents.send('menu:save-as')
    await until(() => existsSync(newPath), 'Save As output')
    await until(() => evaluate("!document.title.startsWith('●')"), 'Save As finished')
    assert.equal(readFileSync(newPath, 'utf8'), spec.source + 'SAVE-AS-CONTENT')
    assert.equal(existsSync(recovery(spec.document)), false, 'old path snapshot removed')
    assert.equal(existsSync(recovery(newPath)), false)
    console.log('PASS real Save As cleans old and new recovery paths')

    function holdRename(target) {
      const original = fs.rename
      let release, entered = false
      const gate = new Promise(resolve => { release = resolve })
      fs.rename = async (from, to) => {
        if (to === target && !entered) { entered = true; await gate }
        return original(from, to)
      }
      return { entered: () => entered, release: () => { fs.rename = original; release() } }
    }
    let hold = holdRename(newPath)
    await edit('BEFORE-SAVE')
    win.webContents.send('menu:save')
    await until(hold.entered, 'held document replacement')
    await edit('DURING-SAVE')
    hold.release()
    await until(() => readFileSync(newPath, 'utf8').endsWith('BEFORE-SAVE'), 'held save finishes')
    await delay(250)
    assert.equal(await evaluate("document.title.startsWith('●')"), true, 'edits during save stay dirty')
    await until(async () => snapshot(newPath).content === await doc(), 'post-save edits remain recoverable')
    win.webContents.send('menu:save')
    await until(() => evaluate("!document.title.startsWith('●')"), 'save latest edits')

    hold = holdRename(recovery(newPath))
    await edit('SNAPSHOT-RACE')
    await until(hold.entered, 'held snapshot commit')
    const beforeSave = readFileSync(newPath, 'utf8')
    win.webContents.send('menu:save')
    await delay(150)
    assert.equal(readFileSync(newPath, 'utf8'), beforeSave, 'save waits for in-flight snapshot')
    hold.release()
    await until(() => evaluate("!document.title.startsWith('●')"), 'serialized save finishes')
    await until(() => !existsSync(recovery(newPath)), 'serialized save clears snapshot')
    assert.equal(readFileSync(newPath, 'utf8'), await doc())

    hold = holdRename(recovery(newPath))
    await edit('UNDO-IN-FLIGHT')
    await until(hold.entered, 'snapshot before undo')
    await menu('edit-undo')
    hold.release()
    await until(() => !existsSync(recovery(newPath)), 'undo clears in-flight snapshot')
    assert.equal(await evaluate("document.title.startsWith('●')"), false)
    console.log('PASS slow-disk snapshot/save/undo ordering and edits during save')

    // Exercise normal close with cancel, discard and save using a second document.
    const primary = win
    for (const response of [1, 0]) {
      await evaluate('window.lightEditor.newWindow()')
      win = await until(() => BrowserWindow.getAllWindows().find(w => w.id !== primary.id), 'close-test window')
      await until(() => win.webContents.executeJavaScript("!!document.querySelector('.cm-content')"), 'close editor ready')
      await evaluate(readFileSync(spec.bundle, 'utf8'))
      const closePath = path.join(spec.base, 'close-' + response + '.md')
      dialog.showSaveDialog = async () => ({ canceled:false, filePath:closePath })
      win.webContents.send('menu:save-as')
      await until(() => existsSync(closePath), 'close-test initial save')
      await until(() => evaluate("!document.title.startsWith('●')"), 'initial save done')
      const original = readFileSync(closePath, 'utf8')
      await edit('CLOSE-EDIT')
      await until(() => existsSync(recovery(closePath)), 'close-test snapshot')
      dialogResponse = 2
      win.close()
      await delay(200)
      assert.equal(win.isDestroyed(), false, 'cancel keeps window and snapshot')
      assert.equal(existsSync(recovery(closePath)), true)
      dialogResponse = response
      win.close()
      await until(() => win.isDestroyed(), 'normal close completes')
      assert.equal(existsSync(recovery(closePath)), false, 'close waits for recovery cleanup')
      assert.equal(readFileSync(closePath, 'utf8'), original + (response === 0 ? 'CLOSE-EDIT' : ''))
      win = primary
    }
    dialogResponse = 0
    console.log('PASS cancel/discard/save close gates and awaited snapshot cleanup')

    // Return to the original file, generate recovery through real editing, then crash.
    await evaluate(`(() => {const v=${view};v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(spec.source)}},userEvent:'input.type'});})()`)
    dialog.showSaveDialog = async () => ({canceled:false,filePath:spec.document})
    win.webContents.send('menu:save-as')
    await until(() => evaluate("!document.title.startsWith('●')"), 'bind crash document')
    await edit('\nCRASH-RECOVERED')
    await until(() => snapshot(spec.document).content === spec.source + '\nCRASH-RECOVERED', 'real crash snapshot')
    assert.equal(readFileSync(spec.document,'utf8'), spec.source, 'snapshot never overwrites Markdown')
    console.log('PASS real edited snapshot generated before abrupt process exit')
    app.exit(0)
    return
  }

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
  let loaded
  try {
    loaded = await until(() => preview.webContents.executeJavaScript(`(() => {
      const labels = ['absolute','relative','file','html','gallery-a','gallery-b','reference','centered','floating'];
      const imgs = labels.map(label => document.querySelector('#preview-root img[alt="' + label + '"]'));
      return imgs.every(i => i && i.complete && i.naturalWidth === 480 && i.naturalHeight === 240) ? imgs.map(i => ({alt:i.alt, src:i.src, complete:i.complete, naturalWidth:i.naturalWidth, naturalHeight:i.naturalHeight})) : null;
    })()`), 'all local image variants load')
  } catch (error) {
    console.error('IMAGE DIAGNOSTIC:', JSON.stringify(await preview.webContents.executeJavaScript(`([...document.querySelectorAll('#preview-root img')].map(i => ({alt:i.alt,src:i.src,complete:i.complete,naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight})))`)))
    throw error
  }
  assert.equal(loaded.length, 9)
  assert.ok(loaded.every(image => image.src === pathToFileURL(spec.image).href))
  const htmlLayout = await preview.webContents.executeJavaScript(`(() => {
    const gallery = document.querySelector('.gallery'), figure = gallery?.querySelector('figure'), caption = gallery?.querySelector('figcaption');
    return { display: gallery && getComputedStyle(gallery).display, figure: !!figure, caption: !!caption,
      width: figure?.getAttribute('style') || '', imageWidth: figure?.querySelector('img')?.getAttribute('style') || '' };
  })()`)
  assert.equal(htmlLayout.display, 'flex')
  assert.equal(htmlLayout.figure, true)
  assert.equal(htmlLayout.caption, true)
  assert.ok(htmlLayout.width.includes('width:48%'))
  assert.ok(htmlLayout.imageWidth.includes('width:100%'))
  const geometry = await preview.webContents.executeJavaScript(`(() => {
    const rect = selector => { const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
    return {gallery:rect('.gallery'),a:rect('.gallery figure:first-child'),b:rect('.gallery figure:last-child'),center:rect('.centered'),image:rect('img[alt="centered"]'),float:rect('img[alt="floating"]'),container:rect('.float-layout'),floating:getComputedStyle(document.querySelector('img[alt="floating"]')).cssFloat};
  })()`)
  assert.ok(Math.abs(geometry.a.top - geometry.b.top) < 1, 'images share a row')
  assert.ok(geometry.b.left >= geometry.a.right + 7, 'side-by-side images have a visible gap')
  assert.ok(Math.abs(geometry.a.width / geometry.gallery.width - 0.48) < 0.01, 'figure uses 48% width')
  assert.ok(Math.abs((geometry.image.left + geometry.image.right) - (geometry.center.left + geometry.center.right)) < 2, 'image is centered')
  assert.ok(Math.abs(geometry.image.width / geometry.center.width - 0.48) < 0.01, 'centered image uses 48% width')
  assert.equal(geometry.floating, 'right')
  assert.ok(Math.abs(geometry.float.right - geometry.container.right) < 1, 'float reaches right edge')
  assert.ok(geometry.float.height >= 79, 'visible image dimensions')
  assert.equal(await preview.webContents.executeJavaScript(`!!window.__unsafe || !!document.querySelector('#preview-root [onerror], #preview-root [onclick], #preview-root [href^="javascript:"], #preview-root [src^="javascript:"]')`), false)
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
