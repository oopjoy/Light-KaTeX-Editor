/**
 * Custom Find/Replace panel (layout A):
 *   [查找……] 下一个  上一个  全选匹配          ×
 *   [替换……] 替换    全部替换
 *   □ 区分大小写   □ 正则   □ 全词匹配
 */
import {
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext,
  findPrevious,
  selectMatches,
  replaceNext,
  replaceAll,
  closeSearchPanel
} from '@codemirror/search'
import {
  EditorView,
  runScopeHandlers,
  type Panel,
  type ViewUpdate
} from '@codemirror/view'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null,
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue
      if (key === 'class') node.className = String(value)
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
      } else if (key === 'checked' && 'checked' in node) {
        ;(node as HTMLInputElement).checked = Boolean(value)
      } else if (value === true) {
        node.setAttribute(key, '')
      } else {
        node.setAttribute(key, String(value))
      }
    }
  }
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

function phrase(view: EditorView, text: string): string {
  return view.state.phrase(text)
}

function button(
  name: string,
  onclick: () => void,
  label: string
): HTMLButtonElement {
  return el(
    'button',
    { class: 'cm-button', name, type: 'button', onclick },
    label
  ) as HTMLButtonElement
}

class LightSearchPanel implements Panel {
  readonly view: EditorView
  readonly dom: HTMLElement
  readonly top = true
  readonly pos = 80

  private query: SearchQuery
  private readonly searchField: HTMLInputElement
  private readonly replaceField: HTMLInputElement
  private readonly caseField: HTMLInputElement
  private readonly reField: HTMLInputElement
  private readonly wordField: HTMLInputElement
  private readonly commit: () => void

  constructor(view: EditorView) {
    this.view = view
    this.query = getSearchQuery(view.state)
    this.commit = () => this.commitQuery()

    this.searchField = el('input', {
      value: this.query.search,
      placeholder: phrase(view, 'Find'),
      'aria-label': phrase(view, 'Find'),
      class: 'cm-textfield',
      name: 'search',
      form: '',
      'main-field': 'true',
      onchange: this.commit,
      onkeyup: this.commit
    }) as HTMLInputElement

    this.replaceField = el('input', {
      value: this.query.replace,
      placeholder: phrase(view, 'Replace'),
      'aria-label': phrase(view, 'Replace'),
      class: 'cm-textfield',
      name: 'replace',
      form: '',
      onchange: this.commit,
      onkeyup: this.commit
    }) as HTMLInputElement

    this.caseField = el('input', {
      type: 'checkbox',
      name: 'case',
      form: '',
      checked: this.query.caseSensitive,
      onchange: this.commit
    }) as HTMLInputElement

    this.reField = el('input', {
      type: 'checkbox',
      name: 're',
      form: '',
      checked: this.query.regexp,
      onchange: this.commit
    }) as HTMLInputElement

    this.wordField = el('input', {
      type: 'checkbox',
      name: 'word',
      form: '',
      checked: this.query.wholeWord,
      onchange: this.commit
    }) as HTMLInputElement

    const findRow = el(
      'div',
      { class: 'cm-search-row cm-search-row-find' },
      this.searchField,
      button('next', () => findNext(view), phrase(view, 'next')),
      button('prev', () => findPrevious(view), phrase(view, 'previous')),
      button('select', () => selectMatches(view), phrase(view, 'all'))
    )

    const replaceRow = el(
      'div',
      { class: 'cm-search-row cm-search-row-replace' },
      this.replaceField,
      button('replace', () => replaceNext(view), phrase(view, 'replace')),
      button('replaceAll', () => replaceAll(view), phrase(view, 'replace all'))
    )

    const optionsRow = el(
      'div',
      { class: 'cm-search-row cm-search-row-options' },
      el('label', null, this.caseField, phrase(view, 'match case')),
      el('label', null, this.reField, phrase(view, 'regexp')),
      el('label', null, this.wordField, phrase(view, 'by word'))
    )

    const closeBtn = el(
      'button',
      {
        name: 'close',
        type: 'button',
        'aria-label': phrase(view, 'close'),
        onclick: () => closeSearchPanel(view)
      },
      '×'
    )

    this.dom = el(
      'div',
      {
        class: 'cm-search',
        onkeydown: (e: KeyboardEvent) => this.keydown(e)
      },
      findRow,
      replaceRow,
      optionsRow,
      closeBtn
    )

    if (view.state.readOnly) {
      replaceRow.hidden = true
    }
  }

  private commitQuery(): void {
    const next = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.reField.checked,
      wholeWord: this.wordField.checked,
      replace: this.replaceField.value
    })
    if (!next.eq(this.query)) {
      this.query = next
      this.view.dispatch({ effects: setSearchQuery.of(next) })
    }
  }

  private keydown(e: KeyboardEvent): void {
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault()
      return
    }
    if (e.key === 'Enter' && e.target === this.searchField) {
      e.preventDefault()
      ;(e.shiftKey ? findPrevious : findNext)(this.view)
    } else if (e.key === 'Enter' && e.target === this.replaceField) {
      e.preventDefault()
      replaceNext(this.view)
    }
  }

  mount(): void {
    this.searchField.select()
  }

  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.setQuery(effect.value)
        }
      }
    }
  }

  private setQuery(query: SearchQuery): void {
    this.query = query
    this.searchField.value = query.search
    this.replaceField.value = query.replace
    this.caseField.checked = query.caseSensitive
    this.reField.checked = query.regexp
    this.wordField.checked = query.wholeWord
  }
}

export function createLightSearchPanel(view: EditorView): Panel {
  return new LightSearchPanel(view)
}
