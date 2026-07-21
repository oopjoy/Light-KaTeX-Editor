import type { AppConfig } from './shared/types'
import {
  EDITOR_FONT_PRESETS,
  PREVIEW_FONT_PRESETS,
  matchPreset,
  clamp
} from './appearance'

export interface SettingsController {
  open: () => void
  close: () => void
  isOpen: () => boolean
  destroy: () => void
}

export function createSettingsPanel(options: {
  getConfig: () => AppConfig
  onChange: (partial: Partial<AppConfig>) => void | Promise<void>
}): SettingsController {
  const overlay = document.createElement('div')
  overlay.className = 'settings-overlay'
  overlay.hidden = true
  overlay.innerHTML = `
    <div class="settings-panel" role="dialog" aria-modal="true" aria-label="设置">
      <header class="settings-header">
        <h2>设置</h2>
        <button type="button" class="settings-close" data-action="close" title="关闭 (Esc)">×</button>
      </header>
      <div class="settings-body">
        <section class="settings-section">
          <h3>主题</h3>
          <div class="settings-row theme-choices" role="radiogroup" aria-label="颜色主题">
            <span>颜色主题</span>
            <div class="theme-toggle">
              <label class="theme-option">
                <input type="radio" name="theme" data-key="theme" value="light" />
                <span>浅色</span>
              </label>
              <label class="theme-option">
                <input type="radio" name="theme" data-key="theme" value="dark" />
                <span>深色</span>
              </label>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h3>源码外观</h3>
          <label class="settings-row">
            <span>字体</span>
            <select data-key="editorFontPreset">
              ${EDITOR_FONT_PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}
              <option value="custom">自定义…</option>
            </select>
          </label>
          <label class="settings-row settings-custom-font" data-for="editorFontFamily" hidden>
            <span>自定义字体</span>
            <input type="text" data-key="editorFontFamily" spellcheck="false" />
          </label>
          <label class="settings-row">
            <span>字号 <em data-val="editorFontSize"></em>px</span>
            <input type="range" min="11" max="24" step="1" data-key="editorFontSize" />
          </label>
          <label class="settings-row">
            <span>行距 <em data-val="editorLineHeight"></em></span>
            <input type="range" min="1.2" max="2.2" step="0.05" data-key="editorLineHeight" />
          </label>
        </section>

        <section class="settings-section">
          <h3>预览外观</h3>
          <label class="settings-row">
            <span>字体</span>
            <select data-key="previewFontPreset">
              ${PREVIEW_FONT_PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}
              <option value="custom">自定义…</option>
            </select>
          </label>
          <label class="settings-row settings-custom-font" data-for="previewFontFamily" hidden>
            <span>自定义字体</span>
            <input type="text" data-key="previewFontFamily" spellcheck="false" />
          </label>
          <label class="settings-row">
            <span>字号 <em data-val="previewFontSize"></em>px</span>
            <input type="range" min="12" max="24" step="1" data-key="previewFontSize" />
          </label>
          <label class="settings-row">
            <span>行距 <em data-val="previewLineHeight"></em></span>
            <input type="range" min="1.2" max="2.4" step="0.05" data-key="previewLineHeight" />
          </label>
          <label class="settings-row">
            <span>内容最大宽度 <em data-val="previewMaxWidthLabel"></em></span>
            <input type="range" min="0" max="1400" step="20" data-key="previewMaxWidth" />
          </label>
          <p class="settings-hint">宽度 0 = 铺满预览栏（推荐）。大于 0 时限制正文宽度，居中显示。</p>
        </section>

        <section class="settings-section">
          <h3>快捷键行为</h3>
          <label class="settings-row checkbox">
            <input type="checkbox" data-key="linkFontSizes" />
            <span>Ctrl+= / Ctrl+- 同时缩放源码与预览字号</span>
          </label>
          <p class="settings-hint">
            查找 <kbd>Ctrl+F</kbd> · 替换 <kbd>Ctrl+H</kbd> · 设置 <kbd>Ctrl+,</kbd> ·
            字号 <kbd>Ctrl+=</kbd> / <kbd>Ctrl+-</kbd> · 重置 <kbd>Ctrl+0</kbd>
          </p>
        </section>
      </div>
      <footer class="settings-footer">
        <button type="button" class="ghost" data-action="reset">恢复默认外观</button>
        <button type="button" class="primary" data-action="close">完成</button>
      </footer>
    </div>
  `
  document.body.appendChild(overlay)

  const panel = overlay.querySelector('.settings-panel') as HTMLElement

  function $(sel: string): HTMLElement | null {
    return overlay.querySelector(sel)
  }

  function fillFromConfig(): void {
    const c = options.getConfig()
    const light = overlay.querySelector<HTMLInputElement>('input[data-key="theme"][value="light"]')
    const dark = overlay.querySelector<HTMLInputElement>('input[data-key="theme"][value="dark"]')
    if (light) light.checked = c.theme === 'light'
    if (dark) dark.checked = c.theme === 'dark'

    const edPreset = overlay.querySelector<HTMLSelectElement>('[data-key="editorFontPreset"]')
    const edId = matchPreset(EDITOR_FONT_PRESETS, c.editorFontFamily)
    if (edPreset) edPreset.value = edId
    toggleCustom('editorFontFamily', edId === 'custom')
    const edCustom = overlay.querySelector<HTMLInputElement>('[data-key="editorFontFamily"]')
    if (edCustom) edCustom.value = c.editorFontFamily

    const pvPreset = overlay.querySelector<HTMLSelectElement>('[data-key="previewFontPreset"]')
    const pvId = matchPreset(PREVIEW_FONT_PRESETS, c.previewFontFamily)
    if (pvPreset) pvPreset.value = pvId
    toggleCustom('previewFontFamily', pvId === 'custom')
    const pvCustom = overlay.querySelector<HTMLInputElement>('[data-key="previewFontFamily"]')
    if (pvCustom) pvCustom.value = c.previewFontFamily

    setRange('editorFontSize', c.editorFontSize)
    setRange('previewFontSize', c.previewFontSize)
    setRange('editorLineHeight', c.editorLineHeight)
    setRange('previewLineHeight', c.previewLineHeight)
    setRange('previewMaxWidth', c.previewMaxWidth)

    const link = overlay.querySelector<HTMLInputElement>('[data-key="linkFontSizes"]')
    if (link) link.checked = c.linkFontSizes !== false

    refreshLabels()
  }

  function setRange(key: string, value: number): void {
    const el = overlay.querySelector<HTMLInputElement>(`[data-key="${key}"]`)
    if (el) el.value = String(value)
  }

  function toggleCustom(which: 'editorFontFamily' | 'previewFontFamily', show: boolean): void {
    const row = overlay.querySelector<HTMLElement>(`.settings-custom-font[data-for="${which}"]`)
    if (row) row.hidden = !show
  }

  function refreshLabels(): void {
    const c = options.getConfig()
    const set = (k: string, v: string) => {
      const el = overlay.querySelector(`[data-val="${k}"]`)
      if (el) el.textContent = v
    }
    set('editorFontSize', String(c.editorFontSize))
    set('previewFontSize', String(c.previewFontSize))
    set('editorLineHeight', c.editorLineHeight.toFixed(2))
    set('previewLineHeight', c.previewLineHeight.toFixed(2))
    set(
      'previewMaxWidthLabel',
      c.previewMaxWidth > 0 ? `${c.previewMaxWidth}px` : '不限制'
    )
  }

  async function patch(partial: Partial<AppConfig>): Promise<void> {
    await options.onChange(partial)
    refreshLabels()
  }

  overlay.addEventListener('click', (event) => {
    const t = event.target as HTMLElement
    if (t === overlay) {
      close()
      return
    }
    const action = t.closest<HTMLElement>('[data-action]')?.getAttribute('data-action')
    if (action === 'close') close()
    if (action === 'reset') {
      void patch({
        theme: 'light',
        fontSize: 15,
        editorFontSize: 15,
        previewFontSize: 16,
        editorFontFamily: EDITOR_FONT_PRESETS[0].value,
        previewFontFamily: PREVIEW_FONT_PRESETS[0].value,
        editorLineHeight: 1.55,
        previewLineHeight: 1.7,
        previewMaxWidth: 0,
        linkFontSizes: true
      }).then(() => fillFromConfig())
    }
  })

  panel.addEventListener('change', (event) => {
    const el = event.target as HTMLInputElement | HTMLSelectElement
    const key = el.getAttribute('data-key')
    if (!key) return

    if (key === 'theme') {
      const input = el as HTMLInputElement
      if (input.type === 'radio' && !input.checked) return
      void patch({ theme: input.value === 'dark' ? 'dark' : 'light' })
      return
    }
    if (key === 'editorFontPreset') {
      if (el.value === 'custom') {
        toggleCustom('editorFontFamily', true)
        return
      }
      toggleCustom('editorFontFamily', false)
      const preset = EDITOR_FONT_PRESETS.find((p) => p.id === el.value)
      if (preset) void patch({ editorFontFamily: preset.value })
      return
    }
    if (key === 'previewFontPreset') {
      if (el.value === 'custom') {
        toggleCustom('previewFontFamily', true)
        return
      }
      toggleCustom('previewFontFamily', false)
      const preset = PREVIEW_FONT_PRESETS.find((p) => p.id === el.value)
      if (preset) void patch({ previewFontFamily: preset.value })
      return
    }
    if (key === 'editorFontFamily') {
      void patch({ editorFontFamily: el.value })
      return
    }
    if (key === 'previewFontFamily') {
      void patch({ previewFontFamily: el.value })
      return
    }
    if (key === 'linkFontSizes') {
      void patch({ linkFontSizes: (el as HTMLInputElement).checked })
      return
    }
  })

  panel.addEventListener('input', (event) => {
    const el = event.target as HTMLInputElement
    const key = el.getAttribute('data-key')
    if (!key) return
    if (key === 'editorFontSize') {
      const n = clamp(Number(el.value), 11, 24)
      void patch({ editorFontSize: n, fontSize: n })
    } else if (key === 'previewFontSize') {
      void patch({ previewFontSize: clamp(Number(el.value), 12, 24) })
    } else if (key === 'editorLineHeight') {
      void patch({ editorLineHeight: clamp(Number(el.value), 1.2, 2.2) })
    } else if (key === 'previewLineHeight') {
      void patch({ previewLineHeight: clamp(Number(el.value), 1.2, 2.4) })
    } else if (key === 'previewMaxWidth') {
      void patch({ previewMaxWidth: Math.max(0, Number(el.value) || 0) })
    } else if (key === 'editorFontFamily') {
      void patch({ editorFontFamily: el.value })
    } else if (key === 'previewFontFamily') {
      void patch({ previewFontFamily: el.value })
    }
  })

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !overlay.hidden) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  function open(): void {
    fillFromConfig()
    overlay.hidden = false
    document.addEventListener('keydown', onKey, true)
    // focus first control
    const first = overlay.querySelector<HTMLElement>('select, input, button')
    first?.focus()
  }

  function close(): void {
    overlay.hidden = true
    document.removeEventListener('keydown', onKey, true)
  }

  function isOpen(): boolean {
    return !overlay.hidden
  }

  function destroy(): void {
    close()
    overlay.remove()
  }

  return { open, close, isOpen, destroy }
}
