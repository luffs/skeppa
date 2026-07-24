const KEY = 'skeppa-theme'

export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
}

// Saved choice wins; otherwise follow the OS preference.
export function initTheme() {
  const saved = localStorage.getItem(KEY)
  if (saved === 'dark' || saved === 'light') applyTheme(saved)
  else applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark'
  localStorage.setItem(KEY, next)
  applyTheme(next)
  return next
}
