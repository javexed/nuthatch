// Who may see and do what. Decided here, on the server, for every
// request; the browser is never trusted with it.
//
// The model is the one Nagios' web interface and Thruk use, with their
// names: a user is the contact of the same name, sees the hosts and
// services that contact belongs to, and roles widen that.
//
// What the engines do with a query's `AuthUser` was measured on Naemon
// 1.5.2 (`docs/permissions.md`): hosts, services, host and service groups,
// comments, downtimes and the log's lines about objects are limited to
// the contact's; contacts, contact groups, commands, timeperiods and the
// status table are given to anyone, so those need a role here.

import type { Role } from '@nuthatch/api'

export const ROLES: Role[] = [
  'all_hosts',
  'all_services',
  'all_host_commands',
  'all_service_commands',
  'system_commands',
  'system_information',
  'configuration_information',
  'read_only',
  'config_edit',
]

export type Roles = ReadonlySet<Role>

/**
 * The `[roles]` table of the config: `authorized_for_<role>` lists users,
 * `authorized_contactgroup_for_<role>` contact groups; `*` is everyone.
 */
export class RolesConfig {
  private readonly users = new Map<Role, string[]>()
  private readonly groups = new Map<Role, string[]>()

  constructor(table: Record<string, unknown> = {}) {
    for (const [key, names] of Object.entries(table)) {
      const byGroup = key.startsWith('authorized_contactgroup_for_')
      if (!byGroup && !key.startsWith('authorized_for_')) throw new Error(`[roles]: '${key}' is not a role setting`)
      const name = key.slice(byGroup ? 'authorized_contactgroup_for_'.length : 'authorized_for_'.length)
      const role = ROLES.find((r) => r === name)
      if (!role) throw new Error(`[roles]: no role '${name}'`)
      if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) throw new Error(`[roles]: ${key} is a list of names`)
      const into = byGroup ? this.groups : this.users
      into.set(role, [...(into.get(role) ?? []), ...(names as string[])])
    }
  }

  /** The roles of a user who is in these contact groups. */
  resolve(user: string, groups: string[]): Roles {
    const held = new Set<Role>()
    for (const role of ROLES) {
      const byName = this.users.get(role)?.some((n) => n === '*' || n === user) ?? false
      const byGroup = this.groups.get(role)?.some((n) => n === '*' || groups.includes(n)) ?? false
      if (byName || byGroup) held.add(role)
    }
    return held
  }
}

export const TABLES = [
  'hosts',
  'services',
  'hostgroups',
  'servicegroups',
  'hostsbygroup',
  'servicesbygroup',
  'servicesbyhostgroup',
  'comments',
  'downtimes',
  'log',
  'statehist',
  'contacts',
  'contactgroups',
  'commands',
  'timeperiods',
  'status',
  'columns',
]

/**
 * How a query of a table is limited for a user: `all` is everything, no
 * `AuthUser`; `limited` is what the engine leaves in for `AuthUser` (a
 * backend that does not enforce it is not asked); or it is denied.
 */
export type Access = { kind: 'all' } | { kind: 'limited' } | { kind: 'denied'; why: string }

export function access(table: string, roles: Roles): Access {
  const needs = (role: Role): Access =>
    roles.has(role) ? { kind: 'all' } : { kind: 'denied', why: `the table ${table} needs the role ${role}` }
  const open = (...any: Role[]): Access => ({ kind: any.some((r) => roles.has(r)) ? 'all' : 'limited' })
  switch (table) {
    // Who may see all hosts may see all services too, as in Nagios.
    case 'hosts':
    case 'hostgroups':
    case 'hostsbygroup':
      return open('all_hosts')
    case 'services':
    case 'servicegroups':
    case 'servicesbygroup':
    case 'servicesbyhostgroup':
      return open('all_hosts', 'all_services')
    case 'comments':
    case 'downtimes':
    case 'log':
    case 'statehist':
      return open('all_hosts')
    case 'contacts':
    case 'contactgroups':
    case 'commands':
    case 'timeperiods':
      return needs('configuration_information')
    case 'status':
      return needs('system_information')
    case 'columns':
      return { kind: 'all' }
    default:
      return { kind: 'denied', why: `no table '${table}'` }
  }
}

/** A request the server will not pass on. */
export class Refused extends Error {}

/**
 * Columns that can carry secrets: command lines with their arguments and
 * custom variables. They need the role configuration_information.
 */
export function secretColumn(name: string): boolean {
  if (['custom_variable', 'check_command', 'event_handler', 'command_line'].some((part) => name.includes(part))) return true
  // What is a contact's own: its e-mail, pager and further addresses,
  // also where another table brings them along (the log's
  // `current_contact_email`). A host's `address` is not one of them.
  return /(^|_)(email|pager)$/.test(name) || /(^|_)address[1-6]$/.test(name) || /^current_contact_(?!name$|alias$)/.test(name)
}

export function columnName(name: string): boolean {
  return /^[a-z0-9_]{1,64}$/.test(name)
}

/** How the numbers of one `Stats:` line from several backends become one. */
export type Merge = 'add' | 'min' | 'max'

function checkColumn(column: string, roles: Roles): void {
  if (!columnName(column)) throw new Refused(`'${column}' is not a column name`)
  if (secretColumn(column) && !roles.has('configuration_information')) {
    throw new Refused(`the column ${column} needs the role configuration_information`)
  }
}

export function checkColumns(columns: string[], roles: Roles): void {
  for (const column of columns) checkColumn(column, roles)
}

/**
 * Checks the header lines of a query: one line each, filters only, or
 * filters and stats when `stats` is on, and no secret column without the
 * role. The answer is how each stats column is merged.
 */
export function checkHeaders(headers: string[], stats: boolean, roles: Roles): Merge[] {
  const merges: Merge[] = []
  for (const line of headers) {
    if (/[\n\r\0]/.test(line) || line.length > 4096) throw new Refused('a header must be one line')
    const colon = line.indexOf(':')
    if (colon < 0) throw new Refused(`not a header: '${line}'`)
    const name = line.slice(0, colon)
    const words = line.slice(colon + 1).trim().split(/\s+/).filter((w) => w !== '')
    const notAllowed = () => new Refused(`only filter${stats ? ' and stats' : ''} lines are allowed, not '${line}'`)
    switch (name) {
      case 'Filter':
        if (words[0] === undefined) throw new Refused(`not a header: '${line}'`)
        checkColumn(words[0], roles)
        break
      case 'And':
      case 'Or':
      case 'Negate':
        break
      case 'Stats': {
        if (!stats) throw notAllowed()
        const [first, second] = words
        if (first === undefined || second === undefined) throw new Refused(`not a stats line: '${line}'`)
        if (['avg', 'std', 'suminv', 'avginv'].includes(first) && words.length === 2) {
          throw new Refused(`Stats: ${first} cannot be merged over backends; use sum and a count`)
        }
        if (['sum', 'min', 'max'].includes(first) && words.length === 2) {
          checkColumn(second, roles)
          merges.push(first === 'sum' ? 'add' : (first as Merge))
        } else {
          checkColumn(first, roles)
          merges.push('add')
        }
        break
      }
      case 'StatsAnd':
      case 'StatsOr': {
        if (!stats) throw notAllowed()
        const n = Number(words[0])
        if (!Number.isInteger(n) || n <= 0 || n > merges.length) throw new Refused(`'${line}' combines more stats than there are`)
        merges.length -= n
        merges.push('add')
        break
      }
      case 'StatsNegate':
        if (!stats) throw notAllowed()
        break
      default:
        throw notAllowed()
    }
  }
  return merges
}
