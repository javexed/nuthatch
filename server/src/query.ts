// Queries from the browser: checked against the user's rights, sent to
// the backends, and their answers put together.
//
// - rows: the rows of a table as objects keyed by column, each with its
//   `backend`. With `sort`, all matching rows are fetched, sorted here
//   over all backends, and `offset` and `limit` cut the page; `total` is
//   how many there are. Without `sort`, `limit` goes to each engine and
//   `total` is not known.
// - stats: `Stats:` lines, optionally grouped by columns; counts and sums
//   of the backends are added, `min` and `max` taken.

import type { Group, Query, QueryAnswer, Stats, StatsAnswer } from '@nuthatch/api'
import type { Backend } from './backend.ts'
import { type Access, type Merge, Refused, type Roles, access, checkColumns, checkHeaders } from './policy.ts'

/** A request refused for want of a right, not for its form. */
export class Forbidden extends Error {}

export const CLOSED = 'this backend does not limit what a user sees (AuthUser); only users with the role all_hosts can use it'

export function chosen(backends: Backend[], names: string[] = []): Backend[] {
  const unknown = names.find((n) => !backends.some((b) => b.name === n))
  if (unknown !== undefined) throw new Refused(`no backend '${unknown}'`)
  return backends.filter((b) => names.length === 0 || names.includes(b.name))
}

const LOG_LINES = 'Filter: host_name != \nFilter: class = 1\nFilter: class = 3\nFilter: class = 4\nFilter: class = 6\nOr: 4\n'

/** The lines that limit a request to what the user may see. */
export function limits(table: string, how: Access, user: string): string {
  if (how.kind !== 'limited') return ''
  // The engine gives everyone the log's lines about no object, and takes
  // the first argument of any external command for a host: a line such as
  // DEL_HOST_COMMENT;9 names no host it knows, and is given to everyone
  // too. So a limited user gets the lines about objects only: alerts (1),
  // notifications (3), passive checks (4) and states (6).
  return `AuthUser: ${user}\n${table === 'log' ? LOG_LINES : ''}`
}

/**
 * Asks each backend. One that cannot limit what is shown is not asked for
 * a user who must be limited.
 */
async function ask(backends: Backend[], request: string, limited: boolean): Promise<{ name: string; rows?: unknown[][]; error?: string }[]> {
  return Promise.all(
    backends.map(async (backend) => {
      try {
        if (limited && !(await backend.enforcesAuth())) return { name: backend.name, error: CLOSED }
        return { name: backend.name, rows: await backend.query(request) }
      } catch (err) {
        return { name: backend.name, error: err instanceof Error ? err.message : String(err) }
      }
    }),
  )
}

export function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function strings(value: unknown, what: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Refused(`${what} is a list of texts`)
  return value as string[]
}

function count(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Refused(`${what} is a whole number`)
  return value
}

function allowed(table: unknown, roles: Roles): Access {
  if (typeof table !== 'string') throw new Refused('name the table')
  const how = access(table, roles)
  if (how.kind === 'denied') throw new Forbidden(how.why)
  return how
}

export async function rows(backends: Backend[], user: string, roles: Roles, body: Partial<Query>): Promise<QueryAnswer> {
  const how = allowed(body.table, roles)
  const table = body.table as string
  const columns = strings(body.columns, 'columns')
  if (columns.length === 0) throw new Refused('name the columns')
  const headers = strings(body.headers, 'headers')
  checkColumns(columns, roles)
  checkHeaders(headers, false, roles)
  const keys = (Array.isArray(body.sort) ? body.sort : []).map((sort) => {
    const at = columns.indexOf(sort?.column)
    if (at < 0) throw new Refused(`sort: '${sort?.column}' is not among the columns`)
    return { at, desc: sort.desc === true }
  })
  const offset = count(body.offset, 'offset') ?? 0
  const limit = count(body.limit, 'limit')
  const asked = chosen(backends, strings(body.backends, 'backends'))

  let request = `GET ${table}\nColumns: ${columns.join(' ')}\n${headers.map((h) => `${h}\n`).join('')}${limits(table, how, user)}`
  if (keys.length === 0 && limit !== undefined) request += `Limit: ${offset + limit}\n`

  const errors: Record<string, string> = {}
  let found: { backend: string; values: unknown[] }[] = []
  for (const answer of await ask(asked, request, how.kind === 'limited')) {
    if (answer.rows) found.push(...answer.rows.map((values) => ({ backend: answer.name, values })))
    else errors[answer.name] = answer.error ?? 'no answer'
  }
  const total = keys.length === 0 ? null : found.length
  if (keys.length > 0) {
    found.sort((a, b) => {
      for (const { at, desc } of keys) {
        const order = compare(a.values[at], b.values[at])
        if (order !== 0) return desc ? -order : order
      }
      return compare(a.backend, b.backend)
    })
  }
  found = found.slice(offset, limit === undefined ? undefined : offset + limit)
  return {
    rows: found.map(({ backend, values }) => ({ ...Object.fromEntries(columns.map((c, n) => [c, values[n]])), backend })),
    total,
    errors,
  }
}

/**
 * Puts the answers of several nuthatches together: each gave its first
 * `offset + limit` rows in the order asked for, so the first rows of all
 * are among them.
 */
export function combine(parts: QueryAnswer[], sort: { column: string; desc?: boolean }[], offset: number, limit: number | undefined): QueryAnswer {
  let rows = parts.flatMap((part) => part.rows)
  if (sort.length > 0) {
    rows.sort((a, b) => {
      for (const { column, desc } of sort) {
        const order = compare((a as Record<string, unknown>)[column], (b as Record<string, unknown>)[column])
        if (order !== 0) return desc ? -order : order
      }
      return compare(a.backend, b.backend)
    })
  }
  rows = rows.slice(offset, limit === undefined ? undefined : offset + limit)
  const totals = parts.map((part) => part.total)
  return {
    rows,
    total: sort.length > 0 && totals.every((t) => t !== null) ? totals.reduce<number>((sum, t) => sum + (t ?? 0), 0) : null,
    errors: Object.assign({}, ...parts.map((part) => part.errors)) as Record<string, string>,
  }
}

/** The same for stats: groups of the same key are merged. */
export function combineStats(parts: StatsAnswer[], merges: Merge[]): StatsAnswer {
  const groups = new Map<string, Group>()
  for (const part of parts) {
    for (const group of part.groups) {
      const id = JSON.stringify(group.key)
      groups.set(id, { key: group.key, values: merge(groups.get(id)?.values ?? [], group.values, merges) })
    }
  }
  return {
    groups: [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, group]) => group),
    by_backend: Object.assign({}, ...parts.map((part) => part.by_backend)) as Record<string, Group[]>,
    errors: Object.assign({}, ...parts.map((part) => part.errors)) as Record<string, string>,
  }
}

export function merge(into: number[], more: number[], merges: Merge[]): number[] {
  if (into.length === 0) return [...more]
  return into.map((value, n) => {
    const other = more[n] ?? 0
    const how = merges[n] ?? 'add'
    return how === 'add' ? value + other : how === 'min' ? Math.min(value, other) : Math.max(value, other)
  })
}

export async function stats(backends: Backend[], user: string, roles: Roles, body: Partial<Stats>): Promise<StatsAnswer> {
  const how = allowed(body.table, roles)
  const table = body.table as string
  const groupBy = strings(body.group_by, 'group_by')
  const headers = strings(body.headers, 'headers')
  checkColumns(groupBy, roles)
  const merges = checkHeaders(headers, true, roles)
  if (merges.length === 0) throw new Refused('no Stats: line')
  const asked = chosen(backends, strings(body.backends, 'backends'))

  const columns = groupBy.length > 0 ? `Columns: ${groupBy.join(' ')}\n` : ''
  const request = `GET ${table}\n${columns}${headers.map((h) => `${h}\n`).join('')}${limits(table, how, user)}`

  const errors: Record<string, string> = {}
  const byBackend: Record<string, Group[]> = {}
  const groups = new Map<string, Group>()
  for (const answer of await ask(asked, request, how.kind === 'limited')) {
    if (!answer.rows) {
      errors[answer.name] = answer.error ?? 'no answer'
      continue
    }
    byBackend[answer.name] = answer.rows
      .filter((row) => row.length >= groupBy.length)
      .map((row) => {
        const key = row.slice(0, groupBy.length)
        const values = row.slice(groupBy.length).map((v) => (typeof v === 'number' ? v : 0))
        const id = JSON.stringify(key)
        const group = groups.get(id)
        groups.set(id, { key, values: merge(group?.values ?? [], values, merges) })
        return { key, values }
      })
  }
  // Groups in the order of their keys.
  const sorted = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, group]) => group)
  return { groups: sorted, by_backend: byBackend, errors }
}
