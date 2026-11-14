// Dashboards: a title, a time range, maybe a host to choose, and panels on
// a grid, kept per user in nuthatch's store. A dashboard holds no data,
// only what its panels ask for; the asking is done by whoever looks, with
// their rights.

import type { Dashboard, DashboardDraft, Layout, PanelSettings, Range, Scope, Series, Target, Widget } from '@nuthatch/api'
import { RANGES } from '@nuthatch/api'
import { Refused } from './policy.ts'
import type { DashboardRow } from './store.ts'

const MAX_WIDGETS = 40
const MAX_SERIES = 8

function name(value: unknown, what: string, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Refused(`${what} is needed`)
    return undefined
  }
  if (typeof value !== 'string' || /[\n\r\0]/.test(value) || value.length > 200) throw new Refused(`${what} is one line of at most 200 letters`)
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) throw new Refused(`${what} is one of ${allowed.join(', ')}`)
  return value as T
}

function target(given: unknown): Target {
  if (typeof given !== 'object' || given === null) throw new Refused('a host or service is needed')
  const t = given as Record<string, unknown>
  const service = name(t.service, 'a service', false)
  return { backend: name(t.backend, 'a backend', true) ?? '', host: name(t.host, 'a host', true) ?? '', ...(service ? { service } : {}) }
}

function series(given: unknown): Series {
  return { ...target(given), label: name((given as Record<string, unknown>).label, 'a metric', true) ?? '' }
}

function scope(w: Record<string, unknown>): Scope {
  if (w.of !== undefined && w.of !== null) return { of: target(w.of) }
  const hostgroup = name(w.hostgroup, 'a host group', false)
  return hostgroup ? { hostgroup } : {}
}

function layout(given: unknown): Layout {
  if (typeof given !== 'object' || given === null) throw new Refused('each panel needs its place on the grid')
  const l = given as Record<string, unknown>
  const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined)
  const [x, y, w, h] = [int(l.x, 0, 11), int(l.y, 0, 500), int(l.w, 1, 12), int(l.h, 1, 20)]
  if (x === undefined || y === undefined || w === undefined || h === undefined || x + w > 12) throw new Refused('a panel sits within 12 columns')
  return { x, y, w, h }
}

/** A panel's settings as they may be kept: only what a panel of its kind has. */
function settings(w: Record<string, unknown>): PanelSettings {
  const title = name(w.title, 'a title', false)
  const titled = title ? { title } : {}
  switch (w.type) {
    case 'status':
      return { type: 'status', ...titled, ...scope(w) }
    case 'availability':
      return { type: 'availability', ...titled, ...scope(w) }
    case 'problems': {
      const hostgroup = name(w.hostgroup, 'a host group', false)
      return {
        type: 'problems',
        ...titled,
        of: oneOf(w.of, ['hosts', 'services'] as const, 'a list'),
        show: oneOf(w.show, ['problems', 'acknowledged', 'downtimes', 'recovered'] as const, 'what it shows'),
        ...(hostgroup ? { hostgroup } : {}),
      }
    }
    case 'metric':
      if (!Array.isArray(w.series) || w.series.length > MAX_SERIES) throw new Refused(`a metric panel has at most ${MAX_SERIES} lines`)
      return { type: 'metric', ...titled, series: w.series.map(series) }
    case 'log':
      return { type: 'log', ...titled, lines: oneOf(w.lines, ['alerts', 'notifications'] as const, 'the lines') }
    case 'note':
      if (typeof w.text !== 'string' || w.text.length > 4000 || w.text.includes('\0')) throw new Refused('a note is text of at most 4000 letters')
      return { type: 'note', ...titled, text: w.text }
    default:
      throw new Refused(`no panel of the kind '${String(w.type)}'`)
  }
}

function widget(given: unknown): Widget {
  if (typeof given !== 'object' || given === null) throw new Refused('a panel is an object')
  const w = given as Record<string, unknown>
  return { ...settings(w), layout: layout(w.layout) }
}

/** A dashboard as it may be kept, from what a browser sent. */
export function checkDraft(given: Record<string, unknown>): DashboardDraft {
  const title = name(given.title, 'a title', true) ?? ''
  if (!Array.isArray(given.widgets) || given.widgets.length > MAX_WIDGETS) throw new Refused(`a dashboard has at most ${MAX_WIDGETS} panels`)
  const range = given.range === undefined ? '24h' : oneOf(given.range, Object.keys(RANGES) as Range[], 'the range')
  let chooseHost: DashboardDraft['choose_host']
  if (given.choose_host !== undefined && given.choose_host !== null) {
    if (typeof given.choose_host !== 'object') throw new Refused('choose_host is an object')
    const hostgroup = name((given.choose_host as Record<string, unknown>).hostgroup, 'a host group', false)
    chooseHost = hostgroup ? { hostgroup } : {}
  }
  return { title, shared: given.shared === true, range, ...(chooseHost ? { choose_host: chooseHost } : {}), widgets: given.widgets.map(widget) }
}

/** What the store keeps beside the title and sharing. */
export function bodyOf(draft: DashboardDraft): string {
  return JSON.stringify({ range: draft.range, choose_host: draft.choose_host, widgets: draft.widgets })
}

export function fromRow(row: DashboardRow): Dashboard {
  const body = JSON.parse(row.body) as Pick<Dashboard, 'range' | 'choose_host' | 'widgets'>
  return { id: row.id, owner: row.owner, title: row.title, shared: row.shared === 1, updated: row.updated, ...body }
}
