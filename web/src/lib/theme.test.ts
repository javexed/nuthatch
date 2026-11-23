// Every theme in style.css, checked for contrast (WCAG 2): text and the
// states as text on cards, button and badge text on their colours, and
// graph lines against cards.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEMES } from './theme'

type Vars = Record<string, string>

/** The custom properties of each rule, by selector, and whether it is for a dark system. */
function rules(css: string): { selector: string; dark: boolean; vars: Vars }[] {
  const out: { selector: string; dark: boolean; vars: Vars }[] = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const walk = (part: string, dark: boolean) => {
    const re = /([^{}]+)\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(part))) {
      let depth = 1
      let i = re.lastIndex
      while (depth > 0 && i < part.length) depth += part[i] === '{' ? 1 : part[i] === '}' ? -1 : 0, i++
      const head = m[1]!.trim()
      const body = part.slice(re.lastIndex, i - 1)
      if (head.startsWith('@media')) walk(body, dark || head.includes('prefers-color-scheme: dark'))
      else {
        const vars: Vars = {}
        for (const v of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[v[1]!] = v[2]!.trim()
        out.push({ selector: head, dark, vars })
      }
      re.lastIndex = i
    }
  }
  walk(text, false)
  return out
}

function luminance(hex: string): number {
  const n = hex.replace('#', '')
  const full = n.length === 3 ? [...n].map((c) => c + c).join('') : n
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

const all = rules(readFileSync(join(__dirname, '..', 'style.css'), 'utf8'))
const base = all.find((r) => r.selector.startsWith(':root,') && !r.dark)!.vars
function theme(id: string, dark: boolean): Vars {
  const own = (r: { selector: string; dark: boolean }) =>
    id === 'light' ? r.selector.startsWith(':root,') && !r.dark : id === 'system-dark' ? r.selector === ':root:not([data-theme])' : r.selector.includes(`[data-theme='${id}']`) && r.dark === dark
  const found = all.filter(own)
  expect(found.length, `${id}${dark ? ' (dark system)' : ''} in style.css`).toBeGreaterThan(0)
  return Object.assign({}, base, ...found.map((r) => r.vars))
}

const looks: [string, Vars][] = [
  ['light', theme('light', false)],
  ['system on a dark system', theme('system-dark', true)],
  ...THEMES.filter((t) => !['system', 'light'].includes(t.id)).map((t) => [t.name, theme(t.id, false)] as [string, Vars]),
  ['High contrast on a dark system', theme('contrast', true)],
]

describe.each(looks)('%s', (_, v) => {
  it('has every colour', () => {
    for (const name of ['--bg', '--card', '--text', '--muted', '--line', '--accent', '--ok', '--warning', '--critical', '--unknown', '--pending', '--series'])
      expect(v[name], name).toMatch(/^#[0-9a-f]{6}$/i)
  })
  it('reads: text, muted text and links on cards and the page', () => {
    for (const fg of ['--text', '--muted', '--accent']) for (const bg of ['--card', '--bg']) expect(contrast(v[fg]!, v[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
  })
  it('reads: states as text, and button and badge text on its colour', () => {
    for (const state of ['--ok', '--warning', '--critical', '--unknown', '--pending', '--accent']) {
      expect(contrast(v[state]!, v['--card']!), `${state} on --card`).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('shows graph lines against cards', () => {
    expect(contrast(v['--series']!, v['--card']!)).toBeGreaterThanOrEqual(3)
  })
})
