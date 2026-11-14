// Dashboards: a title and a list of boxes, kept per user in nuthatch's
// store. A dashboard holds no data, only what its boxes ask for; the
// asking is done by whoever looks, with their rights.

import type { Dashboard, DashboardDraft, Layout, Widget } from '@nuthatch/api'
import { Refused } from './policy.ts'
import type { DashboardRow } from './store.ts'

const MAX_WIDGETS = 40

function name(value: unknown, what: string, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Refused(`${what} is needed`)
    return undefined
  }
  if (typeof value !== 'string' || /[\n\r\0]/.test(value) || value.length > 200) throw new Refused(`${what} is one line of at most 200 letters`)
  return value
}

function count(value: unknown, what: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new Refused(`${what} is a whole number from 1 to ${max}`)
  return value
}

const of = (value: unknown): 'hosts' | 'services' => {
  if (value !== 'hosts' && value !== 'services') throw new Refused("a box is of 'hosts' or of 'services'")
  return value
}

function layout(given: unknown): Layout | undefined {
  if (given === undefined || given === null) return undefined
  const l = given as Record<string, unknown>
  const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined)
  const [x, y, w, h] = [int(l.x, 0, 11), int(l.y, 0, 500), int(l.w, 1, 12), int(l.h, 1, 20)]
  if (x === undefined || y === undefined || w === undefined || h === undefined || x + w > 12) throw new Refused('a panel sits within 12 columns')
  return { x, y, w, h }
}

/** A box as it may be kept: only what a box of its kind has. */
function widget(given: unknown): Widget {
  if (typeof given !== 'object' || given === null) throw new Refused('a box is an object')
  const w = given as Record<string, unknown>
  const placed = layout(w.layout)
  const kept = inner(w)
  return placed ? { ...kept, layout: placed } : kept
}

function inner(w: Record<string, unknown>): Widget {
  const title = name(w.title, 'a title', false)
  switch (w.type) {
    case 'stat':
    case 'graph':
      return {
        type: w.type,
        title,
        backend: name(w.backend, 'a backend', true) ?? '',
        host: name(w.host, 'a host', true) ?? '',
        service: name(w.service, 'a service', false),
        label: name(w.label, 'a label', false),
        hours: count(w.hours, 'the hours', 24 * 31),
      }
    case 'totals':
      return { type: 'totals', title, of: of(w.of), hostgroup: name(w.hostgroup, 'a host group', false) }
    case 'problems':
      return { type: 'problems', title, of: of(w.of), unhandled: w.unhandled === true, hostgroup: name(w.hostgroup, 'a host group', false), limit: count(w.limit, 'the number of rows', 100) }
    case 'object':
      return { type: 'object', title, backend: name(w.backend, 'a backend', true) ?? '', host: name(w.host, 'a host', true) ?? '', service: name(w.service, 'a service', false) }
    case 'log':
      if (w.lines !== 'alerts' && w.lines !== 'notifications') throw new Refused("a log box shows 'alerts' or 'notifications'")
      return { type: 'log', title, lines: w.lines, hours: count(w.hours, 'the hours', 24 * 31), limit: count(w.limit, 'the number of lines', 100) }
    default:
      throw new Refused(`no box of the kind '${String(w.type)}'`)
  }
}

/** A dashboard as it may be kept, from what a browser sent. */
export function checkDraft(given: Record<string, unknown>): DashboardDraft {
  const title = name(given.title, 'a title', true) ?? ''
  if (!Array.isArray(given.widgets) || given.widgets.length > MAX_WIDGETS) throw new Refused(`a dashboard has at most ${MAX_WIDGETS} boxes`)
  return { title, shared: given.shared === true, widgets: given.widgets.map(widget) }
}

export function fromRow(row: DashboardRow): Dashboard {
  let widgets: Widget[] = []
  try {
    widgets = JSON.parse(row.widgets) as Widget[]
  } catch {
    // Kept by an older nuthatch in a form this one does not read: empty.
  }
  return { id: row.id, owner: row.owner, title: row.title, shared: row.shared === 1, widgets, updated: row.updated }
}
