// The theme of this device: kept in its browser, set on <html> as
// data-theme before the page is drawn (index.html), none for System.
// The colours are in style.css.

export const THEMES = [
  { id: 'system', name: 'System' },
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
  { id: 'paper', name: 'Paper' },
  { id: 'night', name: 'Night' },
  { id: 'contrast', name: 'High contrast' },
] as const
export type Theme = (typeof THEMES)[number]['id']

const KEY = 'nuthatch.theme'

export function savedTheme(): Theme {
  try {
    const kept = localStorage.getItem(KEY)
    return THEMES.find((t) => t.id === kept)?.id ?? 'system'
  } catch {
    return 'system'
  }
}

/** The bar of a phone or an installed app takes the page's colour. */
function barColour(): void {
  const meta = document.querySelector('meta[name="theme-color"]')
  const card = getComputedStyle(document.documentElement).getPropertyValue('--card').trim()
  if (meta && card) meta.setAttribute('content', card)
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
  barColour()
}

export function setTheme(theme: Theme): void {
  try {
    if (theme === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, theme)
  } catch {
    // Kept for this page only.
  }
  applyTheme(theme)
}

/** At start: the bar's colour, again when the system goes light or dark. */
export function startTheme(): void {
  applyTheme(savedTheme())
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', barColour)
}
