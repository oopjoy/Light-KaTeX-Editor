import type { MathErrorItem } from './markdown/math-errors'

export interface MathErrorsPanel {
  update: (errors: MathErrorItem[]) => void
  destroy: () => void
  el: HTMLElement
}

export function createMathErrorsPanel(options: {
  onJump: (line: number) => void
}): MathErrorsPanel {
  const el = document.createElement('div')
  el.className = 'math-errors-panel'
  el.hidden = true
  el.innerHTML = `
    <div class="math-errors-header">
      <span class="math-errors-title">公式错误 <em data-count>0</em></span>
      <div class="math-errors-actions">
        <button type="button" class="ghost" data-action="toggle" title="折叠/展开">▾</button>
      </div>
    </div>
    <ul class="math-errors-list"></ul>
  `

  const list = el.querySelector('.math-errors-list') as HTMLUListElement
  const countEl = el.querySelector('[data-count]') as HTMLElement
  const toggleBtn = el.querySelector('[data-action="toggle"]') as HTMLButtonElement
  let collapsed = false

  toggleBtn.addEventListener('click', () => {
    collapsed = !collapsed
    list.hidden = collapsed
    toggleBtn.textContent = collapsed ? '▸' : '▾'
  })

  list.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-line]')
    if (!btn) return
    const line = Number(btn.getAttribute('data-line'))
    if (Number.isFinite(line) && line > 0) options.onJump(line)
  })

  function update(errors: MathErrorItem[]): void {
    countEl.textContent = String(errors.length)
    if (!errors.length) {
      el.hidden = true
      list.innerHTML = ''
      return
    }
    el.hidden = false
    list.innerHTML = errors
      .map((err, idx) => {
        const kind = err.displayMode ? '块' : '行内'
        const snip = err.source.length > 64 ? `${err.source.slice(0, 64)}…` : err.source
        const safeSnip = escapeHtml(snip)
        const safeMsg = escapeHtml(err.message)
        return `
          <li>
            <button type="button" data-line="${err.line}" title="${safeMsg}">
              <span class="err-idx">${idx + 1}</span>
              <span class="err-line">L${err.line}</span>
              <span class="err-kind">${kind}</span>
              <span class="err-msg">${safeMsg}</span>
              <span class="err-src">${safeSnip}</span>
            </button>
          </li>
        `
      })
      .join('')
  }

  function destroy(): void {
    el.remove()
  }

  return { update, destroy, el }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
