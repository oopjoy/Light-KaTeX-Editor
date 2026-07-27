import type { AppConfig } from './shared/types'

/** Named font stacks shown in Settings. */
/** System mono first — avoid icon/Nerd-font families like Maple Mono NF. */
export const SYSTEM_MONO_FONT =
  'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace'

const OLD_PREVIEW_FONT =
  '"Segoe UI", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
export const DEFAULT_PREVIEW_FONT =
  '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif'

export const EDITOR_FONT_PRESETS: { id: string; label: string; value: string }[] = [
  {
    id: 'ui-mono',
    label: '系统等宽（默认）',
    value: SYSTEM_MONO_FONT
  },
  {
    id: 'cascadia',
    label: 'Cascadia Code + 中文回退',
    value:
      '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", "Microsoft YaHei UI", "Noto Sans SC", monospace'
  },
  {
    id: 'consolas',
    label: 'Consolas + 中文回退',
    value: 'Consolas, "Courier New", "Microsoft YaHei UI", "Noto Sans SC", monospace'
  }
]

export const PREVIEW_FONT_PRESETS: { id: string; label: string; value: string }[] = [
  {
    id: 'segoe',
    label: 'Segoe UI + 微软雅黑优先（接近 VS Code）',
    value: DEFAULT_PREVIEW_FONT
  },
  {
    id: 'noto',
    label: 'Noto Sans SC 优先',
    value: '"Noto Sans SC", "Segoe UI", "Microsoft YaHei UI", sans-serif'
  },
  {
    id: 'serif',
    label: '衬线（论文感）',
    value:
      '"Noto Serif SC", "Source Han Serif SC", "Times New Roman", "Songti SC", SimSun, serif'
  },
  {
    id: 'yahei',
    label: '微软雅黑',
    value: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
  }
]

export const DEFAULT_APPEARANCE: Pick<
  AppConfig,
  | 'theme'
  | 'fontSize'
  | 'editorFontSize'
  | 'previewFontSize'
  | 'editorFontFamily'
  | 'previewFontFamily'
  | 'editorLineHeight'
  | 'sourceColoring'
  | 'previewLineHeight'
  | 'previewMaxWidth'
  | 'linkFontSizes'
> = {
  theme: 'light',
  fontSize: 15,
  editorFontSize: 15,
  previewFontSize: 16,
  editorFontFamily: SYSTEM_MONO_FONT,
  previewFontFamily: PREVIEW_FONT_PRESETS[0].value,
  editorLineHeight: 1.55,
  sourceColoring: true,
  previewLineHeight: 1.7,
  previewMaxWidth: 0,
  linkFontSizes: true
}

/** Normalize older configs that only had `fontSize`. */
export function normalizeConfig(raw: Partial<AppConfig> | AppConfig): AppConfig {
  const r = raw as Partial<AppConfig> & Record<string, unknown>
  const base = {
    recentFiles: [] as string[],
    windowBounds: { width: 1160, height: 760 },
    splitRatio: 0.5,
    autoSave: false,
    liveMathCheck: false,
    ...DEFAULT_APPEARANCE,
    ...r
  } as AppConfig

  const editorSize =
    typeof r.editorFontSize === 'number'
      ? r.editorFontSize
      : typeof r.fontSize === 'number'
        ? r.fontSize
        : DEFAULT_APPEARANCE.editorFontSize

  const previewSize =
    typeof r.previewFontSize === 'number' ? r.previewFontSize : DEFAULT_APPEARANCE.previewFontSize

  return {
    ...base,
    fontSize: editorSize,
    editorFontSize: clamp(editorSize, 10, 28),
    previewFontSize: clamp(previewSize, 12, 28),
    editorLineHeight: clamp(Number(base.editorLineHeight) || 1.55, 1.2, 2.4),
    sourceColoring: base.sourceColoring !== false,
    previewLineHeight: clamp(Number(base.previewLineHeight) || 1.7, 1.2, 2.4),
    previewMaxWidth: Math.max(0, Number(base.previewMaxWidth) || 0),
    // Drop Maple Mono / Nerd Font stacks (icons/emoji loaders; not for code body).
    editorFontFamily: (() => {
      const fam = String(base.editorFontFamily || DEFAULT_APPEARANCE.editorFontFamily)
      if (/maple\s*mono/i.test(fam)) return SYSTEM_MONO_FONT
      return fam
    })(),
    previewFontFamily: (() => {
      const family = String(base.previewFontFamily || DEFAULT_APPEARANCE.previewFontFamily)
      // Migrate the former default so existing users actually receive the new
      // YaHei-first stack; preserve every genuinely custom font selection.
      return family === OLD_PREVIEW_FONT ? DEFAULT_PREVIEW_FONT : family
    })(),
    linkFontSizes: base.linkFontSizes !== false,
    liveMathCheck: base.liveMathCheck === true,
    theme: base.theme === 'dark' ? 'dark' : 'light',
    splitRatio: clamp(Number(base.splitRatio) || 0.5, 0.2, 0.8),
    recentFiles: Array.isArray(base.recentFiles) ? base.recentFiles : []
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Apply CSS variables used by preview + chrome (editor uses CodeMirror theme). */
export function applyAppearanceToDom(config: AppConfig): void {
  const root = document.documentElement
  root.dataset.theme = config.theme
  root.style.setProperty('--editor-font', config.editorFontFamily)
  root.style.setProperty('--preview-font', config.previewFontFamily)
  root.style.setProperty('--editor-font-size', `${config.editorFontSize}px`)
  root.style.setProperty('--preview-font-size', `${config.previewFontSize}px`)
  root.style.setProperty('--editor-line-height', String(config.editorLineHeight))
  root.style.setProperty('--preview-line-height', String(config.previewLineHeight))
  if (config.previewMaxWidth > 0) {
    root.style.setProperty('--preview-max-width', `${config.previewMaxWidth}px`)
  } else {
    root.style.setProperty('--preview-max-width', 'none')
  }
}

export function matchPreset(
  presets: { id: string; value: string }[],
  value: string
): string {
  const hit = presets.find((p) => p.value === value)
  return hit?.id ?? 'custom'
}
