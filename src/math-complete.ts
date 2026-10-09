import {
  autocompletion,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import { keymap, type EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { isInsideMath } from './markdown/math-context'
export { isInsideMath } from './markdown/math-context'

/** Common math commands — labels only, no side explanations. */
const MATH_LABELS: string[] = [
  '\\frac',
  '\\dfrac',
  '\\tfrac',
  '\\sqrt',
  '\\sum',
  '\\prod',
  '\\int',
  '\\iint',
  '\\iiint',
  '\\oint',
  '\\lim',
  '\\infty',
  '\\partial',
  '\\nabla',
  '\\cdot',
  '\\times',
  '\\div',
  '\\pm',
  '\\mp',
  '\\leq',
  '\\geq',
  '\\neq',
  '\\approx',
  '\\equiv',
  '\\sim',
  '\\propto',
  '\\in',
  '\\notin',
  '\\subset',
  '\\subseteq',
  '\\cup',
  '\\cap',
  '\\emptyset',
  '\\forall',
  '\\exists',
  '\\rightarrow',
  '\\leftarrow',
  '\\Rightarrow',
  '\\Leftrightarrow',
  '\\mapsto',
  '\\to',
  '\\hat',
  '\\bar',
  '\\vec',
  '\\dot',
  '\\ddot',
  '\\tilde',
  '\\overline',
  '\\underline',
  '\\left',
  '\\right',
  '\\big',
  '\\Big',
  '\\bigg',
  '\\Bigg',
  '\\begin{aligned}',
  '\\end{aligned}',
  '\\begin{cases}',
  '\\end{cases}',
  '\\begin{matrix}',
  '\\end{matrix}',
  '\\begin{pmatrix}',
  '\\end{pmatrix}',
  '\\text',
  '\\mathrm',
  '\\mathbf',
  '\\boldsymbol',
  '\\mathbb',
  '\\mathcal',
  '\\operatorname',
  ...[
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'varepsilon',
    'zeta',
    'eta',
    'theta',
    'vartheta',
    'iota',
    'kappa',
    'lambda',
    'mu',
    'nu',
    'xi',
    'pi',
    'varpi',
    'rho',
    'sigma',
    'varsigma',
    'tau',
    'upsilon',
    'phi',
    'varphi',
    'chi',
    'psi',
    'omega'
  ].map((name) => `\\${name}`),
  ...['Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega'].map(
    (name) => `\\${name}`
  ),
  '\\quad',
  '\\qquad',
  '\\,',
  '\\;',
  '\\!',
  '\\dots',
  '\\cdots',
  '\\ldots',
  '\\vdots',
  '\\ddots',
  '\\binom',
  '\\overset',
  '\\underset',
  '\\substack',
  '\\tag',
  '\\label'
]

function applyCommand(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number
): void {
  const label = completion.label
  let insert = label
  let cursorBack = 0

  if (label === '\\frac' || label === '\\dfrac' || label === '\\tfrac' || label === '\\binom') {
    insert = `${label}{}{}`
    cursorBack = 3
  } else if (
    label === '\\sqrt' ||
    label === '\\hat' ||
    label === '\\bar' ||
    label === '\\vec' ||
    label === '\\dot' ||
    label === '\\ddot' ||
    label === '\\tilde' ||
    label === '\\overline' ||
    label === '\\underline' ||
    label === '\\text' ||
    label === '\\mathrm' ||
    label === '\\mathbf' ||
    label === '\\boldsymbol' ||
    label === '\\mathbb' ||
    label === '\\mathcal' ||
    label === '\\operatorname' ||
    label === '\\tag' ||
    label === '\\label'
  ) {
    insert = `${label}{}`
    cursorBack = 1
  } else if (label === '\\begin{aligned}') {
    insert = '\\begin{aligned}\n\n\\end{aligned}'
    cursorBack = '\\end{aligned}'.length + 1
  } else if (label === '\\begin{cases}') {
    insert = '\\begin{cases}\n\n\\end{cases}'
    cursorBack = '\\end{cases}'.length + 1
  } else if (label === '\\begin{matrix}') {
    insert = '\\begin{matrix}\n\n\\end{matrix}'
    cursorBack = '\\end{matrix}'.length + 1
  } else if (label === '\\begin{pmatrix}') {
    insert = '\\begin{pmatrix}\n\n\\end{pmatrix}'
    cursorBack = '\\end{pmatrix}'.length + 1
  }

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length - cursorBack },
    userEvent: 'input.complete'
  })
}

const COMPLETIONS: Completion[] = MATH_LABELS.map((label) => ({
  label,
  apply: applyCommand
}))

function mathCompletions(context: CompletionContext): CompletionResult | null {
  const pos = context.pos
  const match = context.matchBefore(/\\[A-Za-z]*|\\begin\{[A-Za-z]*|\\end\{[A-Za-z]*/)

  // Critical hot path: activateOnTyping calls this source after every keystroke.
  // Reject ordinary text before allocating/scanning the entire document.
  if (!match && !context.explicit) return null
  if (match && match.from === match.to && !context.explicit) return null

  const doc = context.state.doc.toString()
  if (!isInsideMath(doc, pos)) return null

  const from = match ? match.from : pos
  const typed = match ? match.text : ''

  const options = COMPLETIONS.filter((c) => {
    if (!typed) return true
    return c.label.toLowerCase().startsWith(typed.toLowerCase())
  }).slice(0, 60)

  if (!options.length) return null
  return {
    from,
    options,
    validFor: /^\\[A-Za-z]*$|^\\begin\{[A-Za-z]*$|^\\end\{[A-Za-z]*$/
  }
}

export function mathAutocompleteExtension(): Extension {
  return [
    autocompletion({
      override: [mathCompletions],
      activateOnTyping: true,
      maxRenderedOptions: 40,
      defaultKeymap: true,
      icons: false,
      optionClass: () => 'cm-math-completion'
    }),
    keymap.of(completionKeymap)
  ]
}
