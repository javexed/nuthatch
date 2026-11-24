// Dashboards: a title, a time range, what can be chosen at the top (the
// subjects), and panels on a grid, kept per user in nuthatch's store. A
// dashboard holds no data, only what its panels ask for; the asking is
// done by whoever looks, with their rights.
//
// Before subjects, a dashboard could have a host chosen at the top
// (`choose_host`) and panels about `$host`. Such a dashboard, stored or
// imported, is read as one with an "any host" subject and panels that
// follow it.

import type { CheckNumber, Dashboard, DashboardDraft, Layout, PanelSettings, Range, Scope, Series, Subject, Target, Widget } from '@nuthatch/api'
import { RANGES } from '@nuthatch/api'
import { Refused } from './policy.ts'
import type { DashboardRow } from './store.ts'

const MAX_WIDGETS = 40
const MAX_SERIES = 8
const MAX_SUBJECTS = 20

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

function number(given: unknown): CheckNumber {
  if (typeof given !== 'object' || given === null) throw new Refused('a number is an object')
  const n = given as Record<string, unknown>
  const service = name(n.service, 'a service', false)
  return { ...(service ? { service } : {}), label: name(n.label, 'a metric', true) ?? '' }
}

function scope(w: Record<string, unknown>): Scope {
  if (w.of !== undefined && w.of !== null) return { of: target(w.of) }
  const hostgroup = name(w.hostgroup, 'a host group', false)
  if (hostgroup) return { hostgroup }
  const servicegroup = name(w.servicegroup, 'a service group', false)
  return servicegroup ? { servicegroup } : {}
}

function subject(given: unknown): Subject {
  if (typeof given !== 'object' || given === null) throw new Refused('a subject is an object')
  const s = given as Record<string, unknown>
  switch (s.kind) {
    case 'host':
      return { kind: 'host', backend: name(s.backend, 'a backend', true) ?? '', host: name(s.host, 'a host', true) ?? '' }
    case 'hostgroup':
    case 'servicegroup':
      return { kind: s.kind, name: name(s.name, s.kind === 'hostgroup' ? 'a host group' : 'a service group', true) ?? '' }
    case 'any': {
      const hostgroup = name(s.hostgroup, 'a host group', false)
      return { kind: 'any', ...(hostgroup ? { hostgroup } : {}) }
    }
    default:
      throw new Refused(`no subject of the kind '${String(s.kind)}'`)
  }
}

const CHOSEN = '$host'
const chosen = (t: unknown) => typeof t === 'object' && t !== null && (t as Record<string, unknown>).host === CHOSEN

/** A panel as kept before subjects, as one now: about `$host` is following. */
function upgradePanel(w: Record<string, unknown>): Record<string, unknown> {
  if ((w.type === 'status' || w.type === 'availability') && chosen(w.of)) {
    const { of: _of, ...rest } = w
    return { ...rest, follows: true }
  }
  if (w.type === 'metric' && Array.isArray(w.series) && w.series.some(chosen)) {
    const mine = w.series.filter(chosen) as Record<string, unknown>[]
    return { ...w, follows: true, series: [], numbers: mine.map((s) => ({ ...(s.service ? { service: s.service } : {}), label: s.label })) }
  }
  return w
}

/** A dashboard's body as kept or given before subjects, as one now. */
export function upgrade<T extends Record<string, unknown>>(body: T): T {
  const old = body.choose_host
  const any = Array.isArray(body.widgets) && body.widgets.some((w) => typeof w === 'object' && w !== null && upgradePanel(w as Record<string, unknown>) !== w)
  if ((old === undefined || old === null) && !any) return body
  const { choose_host: _old, ...rest } = body
  const hostgroup = typeof old === 'object' && old !== null ? (old as Record<string, unknown>).hostgroup : undefined
  const subjects = Array.isArray(rest.subjects) ? rest.subjects : [{ kind: 'any', ...(typeof hostgroup === 'string' && hostgroup ? { hostgroup } : {}) }]
  const widgets = Array.isArray(rest.widgets) ? rest.widgets.map((w) => (typeof w === 'object' && w !== null ? upgradePanel(w as Record<string, unknown>) : w)) : rest.widgets
  return { ...rest, subjects, widgets } as unknown as T
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
  // A panel that follows names nothing of its own.
  const follows = w.follows === true
  const own = follows ? { follows: true as const } : undefined
  switch (w.type) {
    case 'status':
      return { type: 'status', ...titled, ...(own ?? scope(w)) }
    case 'availability':
      return { type: 'availability', ...titled, ...(own ?? scope(w)) }
    case 'problems': {
      const hostgroup = follows ? undefined : name(w.hostgroup, 'a host group', false)
      const servicegroup = follows || hostgroup ? undefined : name(w.servicegroup, 'a service group', false)
      return {
        type: 'problems',
        ...titled,
        of: oneOf(w.of, ['hosts', 'services'] as const, 'a list'),
        show: oneOf(w.show, ['problems', 'acknowledged', 'downtimes', 'recovered'] as const, 'what it shows'),
        ...(hostgroup ? { hostgroup } : {}),
        ...(servicegroup ? { servicegroup } : {}),
        ...own,
      }
    }
    case 'metric': {
      if (follows) {
        const numbers = w.numbers ?? []
        if (!Array.isArray(numbers) || numbers.length > MAX_SERIES) throw new Refused(`a metric panel has at most ${MAX_SERIES} numbers`)
        return { type: 'metric', ...titled, series: [], numbers: numbers.map(number), follows: true }
      }
      if (!Array.isArray(w.series) || w.series.length > MAX_SERIES) throw new Refused(`a metric panel has at most ${MAX_SERIES} lines`)
      return { type: 'metric', ...titled, series: w.series.map(series) }
    }
    case 'log':
      return { type: 'log', ...titled, lines: oneOf(w.lines, ['alerts', 'notifications'] as const, 'the lines'), ...own }
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
export function checkDraft(raw: Record<string, unknown>): DashboardDraft {
  if (raw.choose_host !== undefined && raw.choose_host !== null && typeof raw.choose_host !== 'object') throw new Refused('choose_host is an object')
  const given = upgrade(raw)
  const title = name(given.title, 'a title', true) ?? ''
  if (!Array.isArray(given.widgets) || given.widgets.length > MAX_WIDGETS) throw new Refused(`a dashboard has at most ${MAX_WIDGETS} panels`)
  const range = given.range === undefined ? '24h' : oneOf(given.range, Object.keys(RANGES) as Range[], 'the range')
  const subjects = given.subjects ?? []
  if (!Array.isArray(subjects) || subjects.length > MAX_SUBJECTS) throw new Refused(`a dashboard has at most ${MAX_SUBJECTS} subjects`)
  const checked = subjects.map(subject)
  return { title, shared: given.shared === true, range, ...(checked.length > 0 ? { subjects: checked } : {}), widgets: given.widgets.map(widget) }
}

/** What the store keeps beside the title and sharing. */
export function bodyOf(draft: DashboardDraft): string {
  return JSON.stringify({ range: draft.range, ...(draft.subjects ? { subjects: draft.subjects } : {}), widgets: draft.widgets })
}

export function fromRow(row: DashboardRow): Dashboard {
  const body = upgrade(JSON.parse(row.body) as Record<string, unknown>) as unknown as Pick<Dashboard, 'range' | 'subjects' | 'widgets'>
  return { id: row.id, owner: row.owner, title: row.title, shared: row.shared === 1, updated: row.updated, ...body }
}
