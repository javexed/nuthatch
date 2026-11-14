// Changing an engine's config: the hosts and services nuthatch keeps in a
// directory of its own, one file to a host.
//
// A change is first written to a copy of the directory and checked by the
// engine's own verifier, on a copy of the main config that reads the copy
// instead. Only what the engine takes is written to the directory itself,
// and then the engine is told to read its config again. If the change does
// not show in the engine within half a minute, the files are put back.
//
// Who can change a check command can make the engine run a program, so
// all of this is for one role, config_edit, and commands themselves are
// only chosen from those the engine has, or from the few nuthatch brings
// (catalogue.ts), which it writes into its directory when a host needs one.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ConfigChange, ConfigResult, ConfigState, ManagedContact, ManagedGroup, ManagedHost, ManagedService } from '@nuthatch/api'
import type { Backend } from './backend.ts'
import { type Definition, type PathMap, attr, mainWith, parseObjects, readMain, templates, writeObjects } from './nagioscfg.ts'
import { randomBytes } from 'node:crypto'
import { AGGREGATE_COMMAND, CATALOGUE_FILE, CATALOGUE_HOST, CATALOGUE_NAMES, FROM_OUTSIDE, ON_AGENT, PUSHED_COMMAND, catalogueFile, catalogueFor } from './catalogue.ts'
import { Refused } from './policy.ts'
import { now } from './store.ts'

export interface ConfigSettings {
  /** The directory nuthatch keeps its files in. */
  dir: string
  /** The engine's main config. */
  main: string
  /** The engine's verifier, `{main}` standing for the main config to check. */
  verify: string[]
  /** A command that makes the engine read its config again; without it, RESTART_PROGRAM is sent. */
  reload?: string[]
  paths: PathMap
  /** The plugins' directory for nuthatch's own commands: `$USER1$` unless given. */
  plugins?: string
}

/** The files changed since the revision the change was made from. */
export class Conflict extends Error {}
/** The engine's verifier did not take the config. */
export class Unverified extends Error {
  readonly output: string
  constructor(output: string) {
    super('the engine does not take this config')
    this.output = output
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
const DESCRIPTION = /^[A-Za-z0-9][A-Za-z0-9 _.:/+-]{0,62}$/
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,254}$/
const MEMBER = /^[A-Za-z0-9][A-Za-z0-9 _.@-]{0,62}$/
const HOST_KEYS = ['host_name', 'use', 'alias', 'address', 'check_command', 'hostgroups', 'contacts', 'contact_groups', 'notes', '_CHECKD_DOWNTIME_PERIOD']
const SERVICE_KEYS = ['host_name', 'service_description', 'use', 'check_command', 'servicegroups', 'contacts', 'contact_groups', 'notes', '_CHECKD_DOWNTIME_PERIOD', '_CHECKD_RUN_ON']
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/
/** A host, a pattern or `@group`; or the same, `/`, and a service or a pattern for one. */
const AGGREGATE_MEMBER = /^[A-Za-z0-9@*?][A-Za-z0-9._*?@-]{0,62}(\/[A-Za-z0-9*?][A-Za-z0-9 _.:+*?-]{0,62})?$/

/** The arguments of an aggregate's command: `--min 2 web1/http 'db1/disk space'`. */
export function aggregateArgs(aggregate: NonNullable<ManagedService['aggregate']>): string {
  const words = aggregate.members.map((member) => (member.includes(' ') ? `'${member}'` : member))
  return [...(aggregate.min ? ['--min', aggregate.min] : []), ...words].join(' ')
}

/** The other way round; undefined when it is not what nuthatch writes. */
export function aggregateOf(args: string): ManagedService['aggregate'] | undefined {
  const words = [...args.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '')
  const min = words[0] === '--min' ? words[1] : undefined
  const members = min === undefined ? words : words.slice(2)
  if (members.length === 0 || members.some((m) => !AGGREGATE_MEMBER.test(m)) || (min !== undefined && !/^\d{1,4}%?$/.test(min))) return undefined
  return min === undefined ? { members } : { members, min }
}

function pushOf(given: unknown, what: string): ManagedService['push'] {
  if (typeof given !== 'object' || given === null) throw new Refused(`${what}: what it takes pushes with is needed`)
  const p = given as Record<string, unknown>
  // A token is made here, never taken on trust from a form's default.
  const token = p.token === undefined || p.token === '' ? randomBytes(16).toString('hex') : p.token
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new Refused(`${what}: a token is 16 to 64 letters, digits, '-' and '_'`)
  if (p.every === undefined || p.every === null || p.every === '') return { token }
  const every = Number(p.every)
  if (!Number.isInteger(every) || every < 60 || every > 366 * 86400) throw new Refused(`${what}: the time within which a push is expected is 60 seconds to a year`)
  return { token, every }
}

function aggregateGiven(given: unknown, what: string): NonNullable<ManagedService['aggregate']> {
  const a = (typeof given === 'object' && given !== null ? given : {}) as Record<string, unknown>
  if (!Array.isArray(a.members) || a.members.length === 0 || a.members.length > 40) throw new Refused(`${what}: name 1 to 40 members`)
  const members = a.members.map((m) => (typeof m === 'string' ? m.trim() : ''))
  const bad = members.find((m) => !AGGREGATE_MEMBER.test(m))
  if (bad !== undefined) throw new Refused(`${what}: '${bad}' is not a member: a host (web1, web*, @group) or host/service`)
  if (a.min === undefined || a.min === null || a.min === '') return { members }
  if (typeof a.min !== 'string' || !/^\d{1,4}%?$/.test(a.min)) throw new Refused(`${what}: how many must be OK is a number or a percentage`)
  return { members, min: a.min }
}
const HEADER = 'Written by nuthatch. A file changed by hand is left alone when nuthatch\nno longer understands it.'

function text(value: unknown, what: string, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Refused(`${what} is needed`)
    return undefined
  }
  if (typeof value !== 'string') throw new Refused(`${what} is a text`)
  const trimmed = value.trim()
  // A `;` starts a comment in an object file, and a line ends a value.
  if (/[;\n\r\0]/.test(trimmed) || trimmed.length > 500) throw new Refused(`${what} is one line of at most 500 letters, without ';'`)
  if (trimmed === '' && required) throw new Refused(`${what} is needed`)
  return trimmed === '' ? undefined : trimmed
}

function names(value: unknown, what: string, known: string[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !MEMBER.test(v))) throw new Refused(`${what} is a list of names`)
  const unknown = (value as string[]).find((v) => !known.includes(v))
  if (unknown !== undefined) throw new Refused(`${what}: the engine has no '${unknown}'`)
  return [...new Set(value as string[])]
}

/** A timeperiod in which the object is in a downtime, of those the engine has. */
function period(value: unknown, what: string, known: string[] | undefined, extras: boolean): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!extras) throw new Refused(`${what}: only checkd has downtimes that come round`)
  if (typeof value !== 'string' || !(known ?? []).includes(value)) throw new Refused(`${what}: the engine has no timeperiod '${String(value)}'`)
  return value
}

function command(value: unknown, what: string, known: string[]): string | undefined {
  const line = text(value, what)
  if (line === undefined) return undefined
  const name = line.split('!')[0] ?? ''
  if (!known.includes(name)) throw new Refused(`${what}: the engine has no command '${name}'`)
  return line
}

type Choices = ConfigState['choices']
type Templates = ConfigState['templates']

/** A host as it may be written, or the reason it may not. */
export function checkHost(given: unknown, choices: Choices, known: Templates, extras = true): ManagedHost {
  if (typeof given !== 'object' || given === null) throw new Refused('a host is needed')
  const h = given as Record<string, unknown>
  if (typeof h.name !== 'string' || !NAME.test(h.name)) throw new Refused("a host's name is letters, digits, '.', '_' and '-', at most 63")
  if (h.name === CATALOGUE_HOST) throw new Refused(`'${CATALOGUE_HOST}' is the name of nuthatch's own file; choose another`)
  if (typeof h.address !== 'string' || !ADDRESS.test(h.address)) throw new Refused("a host's address is a name or an IP address")
  if (typeof h.use !== 'string' || !known.host.includes(h.use)) throw new Refused('choose one of the host templates')
  const services: ManagedService[] = []
  for (const given of Array.isArray(h.services) ? (h.services as Record<string, unknown>[]) : []) {
    if (typeof given !== 'object' || given === null) throw new Refused('a service is needed')
    if (typeof given.description !== 'string' || !DESCRIPTION.test(given.description)) {
      throw new Refused("a service's name is letters, digits, spaces and '_.:/+-', at most 63")
    }
    const what = `service ${given.description}`
    if (services.some((s) => s.description === given.description)) throw new Refused(`${what} is there twice`)
    if (typeof given.use !== 'string' || !known.service.includes(given.use)) throw new Refused(`${what}: choose one of the service templates`)
    const push = given.push === undefined || given.push === null ? undefined : pushOf(given.push, what)
    const aggregate = given.aggregate === undefined || given.aggregate === null ? undefined : aggregateGiven(given.aggregate, what)
    if ((push || aggregate) && !extras) throw new Refused(`${what}: only checkd has services that take pushes or stand for others`)
    if (push && aggregate) throw new Refused(`${what} takes pushes or stands for others, not both`)
    const checkCommand = push
      ? PUSHED_COMMAND
      : aggregate
        ? `${AGGREGATE_COMMAND}!${aggregateArgs(aggregate)}`
        : command(given.check_command, `${what}: the check command`, choices.commands)
    // A look from outside stays with the engine when the host has an agent;
    // a look at the machine itself goes to its agent only.
    const commandName = (checkCommand ?? '').split('!')[0] ?? ''
    const runOn = !extras ? undefined : FROM_OUTSIDE.includes(commandName) ? 'engine' : ON_AGENT.includes(commandName) ? 'agent' : undefined
    services.push({
      description: given.description,
      use: given.use,
      // What it is decides its command, whatever was sent.
      check_command: checkCommand,
      servicegroups: names(given.servicegroups, `${what}: service groups`, choices.servicegroups),
      contacts: names(given.contacts, `${what}: contacts`, choices.contacts),
      contact_groups: names(given.contact_groups, `${what}: contact groups`, choices.contactgroups),
      notes: text(given.notes, `${what}: notes`),
      downtime_period: period(given.downtime_period, `${what}: the downtime's timeperiod`, choices.timeperiods, extras),
      ...(push ? { push } : {}),
      ...(aggregate ? { aggregate } : {}),
      ...(runOn ? { run_on: runOn } : {}),
    })
  }
  return {
    name: h.name,
    alias: text(h.alias, 'the alias'),
    address: h.address,
    use: h.use,
    check_command: command(h.check_command, 'the check command', choices.commands),
    hostgroups: names(h.hostgroups, 'host groups', choices.hostgroups),
    contacts: names(h.contacts, 'contacts', choices.contacts),
    contact_groups: names(h.contact_groups, 'contact groups', choices.contactgroups),
    notes: text(h.notes, 'notes'),
    downtime_period: period(h.downtime_period, "the downtime's timeperiod", choices.timeperiods, extras),
    services,
  }
}

/** The file a group is kept in: a name no host's file can have (a host's begins with a letter or digit). */
export function groupFile(type: ManagedGroup['type'], name: string): string {
  return `_${type}-${name}.cfg`
}

const SERVICE_MEMBER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/[A-Za-z0-9][A-Za-z0-9 _.:\/+-]{0,62}$/

const CONTACT_FILE = (name: string) => `_contact-${name}.cfg`
const CONTACT_KEYS = ['contact_name', 'alias', 'email', 'pager', 'host_notification_period', 'service_notification_period', 'host_notification_options',
  'service_notification_options', 'host_notification_commands', 'service_notification_commands', '_CHECKD_DIGEST_COMMAND', '_CHECKD_DIGEST_WAIT']

/** A contact as it may be written, or the reason it may not. */
export function checkContact(given: unknown, choices: Choices, extras: boolean): ManagedContact {
  if (typeof given !== 'object' || given === null) throw new Refused('a contact is needed')
  const c = given as Record<string, unknown>
  if (typeof c.name !== 'string' || !NAME.test(c.name)) throw new Refused("a contact's name is letters, digits, '.', '_' and '-', at most 63")
  const period = (value: unknown, what: string) => {
    if (typeof value !== 'string' || !(choices.timeperiods ?? []).includes(value)) throw new Refused(`${what}: choose one of the engine's timeperiods`)
    return value
  }
  const letters = (value: unknown, what: string, allowed: string) => {
    const text = typeof value === 'string' ? value.replace(/[\s,]/g, '') : ''
    if (text === '' || [...text].some((l) => !allowed.includes(l))) throw new Refused(`${what}: letters of ${allowed}`)
    return [...new Set(text)].join(',')
  }
  const commands = (value: unknown, what: string) => {
    const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : []
    if (list.length === 0) throw new Refused(`${what}: choose at least one command`)
    for (const line of list) command(line, what, choices.commands)
    return list
  }
  const email = text(c.email, 'the e-mail')
  if (email !== undefined && !/^[^\s@,]+@[^\s@,]+$/.test(email)) throw new Refused('the e-mail is not an address')
  let digest: ManagedContact['digest']
  if (c.digest !== undefined && c.digest !== null) {
    if (!extras) throw new Refused('only checkd has digests')
    const d = c.digest as Record<string, unknown>
    const name = text(d.command, 'the digest command', true) as string
    if (!choices.commands.includes(name)) throw new Refused(`the digest command: the engine has no command '${name}'`)
    const wait = d.wait === undefined || d.wait === null || d.wait === '' ? undefined : Number(d.wait)
    if (wait !== undefined && (!Number.isInteger(wait) || wait < 1 || wait > 3600)) throw new Refused('the digest wait is 1 to 3600 seconds')
    digest = { command: name, ...(wait === undefined ? {} : { wait }) }
  }
  return {
    name: c.name,
    alias: text(c.alias, 'the alias'),
    email,
    pager: text(c.pager, 'the pager'),
    host_notification_period: period(c.host_notification_period, 'host notification period'),
    service_notification_period: period(c.service_notification_period, 'service notification period'),
    host_notification_options: letters(c.host_notification_options, 'host notification options', 'durfsn'),
    service_notification_options: letters(c.service_notification_options, 'service notification options', 'wucrfsn'),
    host_notification_commands: commands(c.host_notification_commands, 'host notification commands'),
    service_notification_commands: commands(c.service_notification_commands, 'service notification commands'),
    ...(digest ? { digest } : {}),
  }
}

export function contactText(contact: ManagedContact): string {
  const attrs: [string, string][] = [['contact_name', contact.name]]
  put(attrs, 'alias', contact.alias)
  put(attrs, 'email', contact.email)
  put(attrs, 'pager', contact.pager)
  put(attrs, 'host_notification_period', contact.host_notification_period)
  put(attrs, 'service_notification_period', contact.service_notification_period)
  put(attrs, 'host_notification_options', contact.host_notification_options)
  put(attrs, 'service_notification_options', contact.service_notification_options)
  put(attrs, 'host_notification_commands', contact.host_notification_commands)
  put(attrs, 'service_notification_commands', contact.service_notification_commands)
  if (contact.digest) {
    put(attrs, '_CHECKD_DIGEST_COMMAND', contact.digest.command)
    if (contact.digest.wait !== undefined) put(attrs, '_CHECKD_DIGEST_WAIT', String(contact.digest.wait))
  }
  return writeObjects([{ type: 'contact', attrs }], HEADER)
}

export function readContactFile(content: string): ManagedContact {
  const definitions = parseObjects(content)
  const [d] = definitions
  if (definitions.length !== 1 || d === undefined || d.type !== 'contact') throw new Error('it does not define exactly one contact')
  const strange = d.attrs.find(([key]) => !CONTACT_KEYS.includes(key))?.[0]
  if (strange !== undefined) throw new Error(`its contact has '${strange}', which nuthatch does not edit`)
  const command = attr(d, '_CHECKD_DIGEST_COMMAND')
  const wait = attr(d, '_CHECKD_DIGEST_WAIT')
  return {
    name: attr(d, 'contact_name') ?? '',
    alias: attr(d, 'alias'),
    email: attr(d, 'email'),
    pager: attr(d, 'pager'),
    host_notification_period: attr(d, 'host_notification_period') ?? '',
    service_notification_period: attr(d, 'service_notification_period') ?? '',
    host_notification_options: attr(d, 'host_notification_options') ?? '',
    service_notification_options: attr(d, 'service_notification_options') ?? '',
    host_notification_commands: list(attr(d, 'host_notification_commands')),
    service_notification_commands: list(attr(d, 'service_notification_commands')),
    ...(command ? { digest: { command, ...(wait ? { wait: Number(wait) } : {}) } } : {}),
  }
}

/** A group as it may be written, or the reason it may not. Whether its members exist is the engine's verifier's to say. */
export function checkGroup(given: unknown): ManagedGroup {
  if (typeof given !== 'object' || given === null) throw new Refused('a group is needed')
  const g = given as Record<string, unknown>
  if (g.type !== 'hostgroup' && g.type !== 'servicegroup') throw new Refused('a group is a hostgroup or a servicegroup')
  if (typeof g.name !== 'string' || !NAME.test(g.name)) throw new Refused("a group's name is letters, digits, '.', '_' and '-', at most 63")
  const members = Array.isArray(g.members) ? g.members.map((m) => (typeof m === 'string' ? m.trim() : '')).filter((m) => m !== '') : []
  if (members.length > 1000) throw new Refused('a group has at most 1000 members here')
  const bad = members.find((m) => !(g.type === 'hostgroup' ? NAME.test(m) : SERVICE_MEMBER.test(m)))
  if (bad !== undefined) throw new Refused(g.type === 'hostgroup' ? `'${bad}' is not a host's name` : `'${bad}' is not host/service`)
  return { type: g.type, name: g.name, alias: text(g.alias, 'the alias'), members: [...new Set(members)] }
}

/** A group as an object file's text. */
export function groupText(group: ManagedGroup): string {
  const attrs: [string, string][] = [[`${group.type}_name`, group.name]]
  put(attrs, 'alias', group.alias ?? group.name)
  const members = group.type === 'hostgroup' ? group.members : group.members.map((m) => m.replace('/', ','))
  put(attrs, 'members', members)
  return writeObjects([{ type: group.type, attrs }], HEADER)
}

/** Reads a group's file nuthatch wrote. */
export function readGroupFile(content: string): ManagedGroup {
  const definitions = parseObjects(content)
  const [d] = definitions
  if (definitions.length !== 1 || d === undefined || (d.type !== 'hostgroup' && d.type !== 'servicegroup')) throw new Error('it does not define exactly one group')
  const type = d.type
  const name = attr(d, `${type}_name`)
  if (name === undefined) throw new Error(`its group has no ${type}_name`)
  const strange = d.attrs.find(([key]) => ![`${type}_name`, 'alias', 'members'].includes(key))?.[0]
  if (strange !== undefined) throw new Error(`its group has '${strange}', which nuthatch does not edit`)
  const raw = list(attr(d, 'members'))
  const members: string[] = []
  if (type === 'hostgroup') members.push(...raw)
  else {
    if (raw.length % 2 !== 0) throw new Error('its members are not pairs of host and service')
    for (let n = 0; n < raw.length; n += 2) members.push(`${raw[n]}/${raw[n + 1]}`)
  }
  const alias = attr(d, 'alias')
  return { type, name, alias: alias === name ? undefined : alias, members }
}

function put(attrs: [string, string][], key: string, value: string | string[] | undefined): void {
  const text = Array.isArray(value) ? value.join(',') : value
  if (text !== undefined && text !== '') attrs.push([key, text])
}

/** A host and its services as an object file's text. */
export function hostFile(host: ManagedHost): string {
  const definitions: Definition[] = []
  const attrs: [string, string][] = [['host_name', host.name], ['use', host.use]]
  put(attrs, 'alias', host.alias)
  put(attrs, 'address', host.address)
  put(attrs, 'check_command', host.check_command)
  put(attrs, 'hostgroups', host.hostgroups)
  put(attrs, 'contacts', host.contacts)
  put(attrs, 'contact_groups', host.contact_groups)
  put(attrs, 'notes', host.notes)
  put(attrs, '_CHECKD_DOWNTIME_PERIOD', host.downtime_period)
  definitions.push({ type: 'host', attrs })
  for (const service of host.services) {
    const attrs: [string, string][] = [['host_name', host.name], ['service_description', service.description], ['use', service.use]]
    put(attrs, 'check_command', service.check_command)
    put(attrs, 'servicegroups', service.servicegroups)
    put(attrs, 'contacts', service.contacts)
    put(attrs, 'contact_groups', service.contact_groups)
    put(attrs, 'notes', service.notes)
    put(attrs, '_CHECKD_DOWNTIME_PERIOD', service.downtime_period)
    if (service.run_on) attrs.push(['_CHECKD_RUN_ON', service.run_on])
    if (service.push) {
      // Told its result, never checked.
      // Told its result, never checked but when freshness finds nothing
      // came in time (checkd and Naemon alike), which the command answers
      // CRITICAL.
      attrs.push(['active_checks_enabled', '0'])
      if (service.push.every !== undefined) attrs.push(['check_freshness', '1'], ['freshness_threshold', String(service.push.every)])
      attrs.push(['_CHECKD_PUSH_TOKEN', service.push.token])
    }
    // Worked out by the engine, which costs nothing: every minute.
    if (service.aggregate) attrs.push(['check_interval', '1'])
    definitions.push({ type: 'service', attrs })
  }
  return writeObjects(definitions, HEADER)
}

const list = (value: string | undefined) => (value === undefined ? [] : value.split(',').map((v) => v.trim()).filter((v) => v !== ''))

/** Reads a file nuthatch wrote. Throws the reason when it is not one it can edit. */
export function readHostFile(content: string): ManagedHost {
  const definitions = parseObjects(content)
  const hosts = definitions.filter((d) => d.type === 'host')
  const [first] = hosts
  if (hosts.length !== 1 || first === undefined) throw new Error('it does not define exactly one host')
  const name = attr(first, 'host_name')
  if (name === undefined) throw new Error('its host has no host_name')
  const strange = (d: Definition, keys: string[]) => d.attrs.find(([key]) => !keys.includes(key))?.[0]
  if (strange(first, HOST_KEYS) !== undefined) throw new Error(`its host has '${strange(first, HOST_KEYS)}', which nuthatch does not edit`)
  const services: ManagedService[] = []
  for (const d of definitions) {
    if (d === first) continue
    if (d.type !== 'service') throw new Error(`it defines a ${d.type}`)
    if (attr(d, 'host_name') !== name) throw new Error('it has a service of another host')
    const command = attr(d, 'check_command')
    const token = attr(d, '_CHECKD_PUSH_TOKEN')
    const every = attr(d, 'check_freshness') === '1' ? attr(d, 'freshness_threshold') : undefined
    const aggregate = command?.startsWith(`${AGGREGATE_COMMAND}!`) ? aggregateOf(command.slice(AGGREGATE_COMMAND.length + 1)) : undefined
    const push = token !== undefined && command === PUSHED_COMMAND ? { token, ...(every !== undefined ? { every: Number(every) } : {}) } : undefined
    // The further settings are nuthatch's only on a service of those two kinds, as it writes them.
    const extra = push ? ['_CHECKD_PUSH_TOKEN', 'check_freshness', 'freshness_threshold', 'active_checks_enabled'] : aggregate ? ['check_interval'] : []
    if (strange(d, [...SERVICE_KEYS, ...extra]) !== undefined) {
      throw new Error(`a service has '${strange(d, [...SERVICE_KEYS, ...extra])}', which nuthatch does not edit`)
    }
    if (command?.startsWith(`${AGGREGATE_COMMAND}!`) && !aggregate) throw new Error('a service stands for others in a way nuthatch does not write')
    services.push({
      ...(push ? { push } : {}),
      ...(aggregate ? { aggregate } : {}),
      description: attr(d, 'service_description') ?? '',
      use: attr(d, 'use') ?? '',
      check_command: attr(d, 'check_command'),
      servicegroups: list(attr(d, 'servicegroups')),
      contacts: list(attr(d, 'contacts')),
      contact_groups: list(attr(d, 'contact_groups')),
      notes: attr(d, 'notes'),
      downtime_period: attr(d, '_CHECKD_DOWNTIME_PERIOD'),
      ...(attr(d, '_CHECKD_RUN_ON') === 'engine' || attr(d, '_CHECKD_RUN_ON') === 'agent' ? { run_on: attr(d, '_CHECKD_RUN_ON') as 'engine' | 'agent' } : {}),
    })
  }
  return {
    name,
    alias: attr(first, 'alias'),
    address: attr(first, 'address') ?? '',
    use: attr(first, 'use') ?? '',
    check_command: attr(first, 'check_command'),
    hostgroups: list(attr(first, 'hostgroups')),
    contacts: list(attr(first, 'contacts')),
    contact_groups: list(attr(first, 'contact_groups')),
    notes: attr(first, 'notes'),
    downtime_period: attr(first, '_CHECKD_DOWNTIME_PERIOD'),
    services,
  }
}

function run(command: string[], limit: number): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const [program = '', ...args] = command
    execFile(program, args, { timeout: limit, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.slice(0, 64 * 1024)
      if (err === null) done({ code: 0, output })
      else done({ code: typeof err.code === 'number' ? err.code : 1, output: output || err.message })
    })
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class ConfigAdmin {
  private readonly backend: Backend
  private readonly settings: ConfigSettings
  /** One change at a time. */
  private busy: Promise<unknown> = Promise.resolve()

  constructor(backend: Backend, settings: ConfigSettings) {
    this.backend = backend
    this.settings = { ...settings, dir: resolve(settings.dir), main: resolve(settings.main) }
    mkdirSync(this.settings.dir, { recursive: true })
  }

  private files(): Map<string, string> {
    const out = new Map<string, string>()
    for (const name of readdirSync(this.settings.dir).sort()) {
      if (name.endsWith('.cfg')) out.set(name, readFileSync(join(this.settings.dir, name), 'utf8'))
    }
    return out
  }

  private revision(files: Map<string, string>): string {
    const hash = createHash('sha256')
    for (const [name, content] of files) hash.update(`${name}\0${content.length}\0${content}`)
    return hash.digest('hex').slice(0, 24)
  }

  private async names(table: string): Promise<string[]> {
    return (await this.backend.query(`GET ${table}\nColumns: name`)).map((row) => String(row[0])).sort()
  }

  async state(): Promise<ConfigState> {
    const files = this.files()
    const hosts: ManagedHost[] = []
    const unreadable: ConfigState['unreadable'] = []
    const groups: ManagedGroup[] = []
    const keptContacts: ManagedContact[] = []
    for (const [file, content] of files) {
      if (file === CATALOGUE_FILE) continue
      try {
        if (file.startsWith('_contact-')) keptContacts.push(readContactFile(content))
        else if (file.startsWith('_')) groups.push(readGroupFile(content))
        else hosts.push(readHostFile(content))
      } catch (err) {
        unreadable.push({ file, why: err instanceof Error ? err.message : String(err) })
      }
    }
    const main = readMain(this.settings.main, this.settings.paths)
    const [commands, contacts, contactgroups, hostgroups, servicegroups, timeperiods, allHosts] = await Promise.all(
      ['commands', 'contacts', 'contactgroups', 'hostgroups', 'servicegroups', 'timeperiods', 'hosts'].map((table) => this.names(table)),
    )
    // checkd says who it is beside the version it answers as.
    const version = await this.backend.query('GET status\nColumns: program_version').catch(() => [])
    const extras = String(version[0]?.[0] ?? '').includes('checkd')
    return {
      backend: this.backend.name,
      revision: this.revision(files),
      hosts: hosts.sort((a, b) => a.name.localeCompare(b.name)),
      groups: groups.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
      contacts: keptContacts.sort((a, b) => a.name.localeCompare(b.name)),
      unreadable,
      templates: { host: templates(main.files, 'host'), service: templates(main.files, 'service') },
      catalogue: catalogueFor(extras),
      extras,
      // nuthatch's own commands may be chosen too: written when needed.
      choices: { commands: [...new Set([...(commands ?? []), ...catalogueFor(extras)])].sort(), contacts: contacts ?? [], contactgroups: contactgroups ?? [], hostgroups: hostgroups ?? [], servicegroups: servicegroups ?? [], timeperiods: timeperiods ?? [], hosts: allHosts ?? [] },
    }
  }

  /** Makes a change, or with `dryRun` only has the engine check it. */
  change(revision: unknown, change: ConfigChange, dryRun: boolean): Promise<ConfigResult> {
    const next = this.busy.then(() => this.changeNow(revision, change, dryRun))
    this.busy = next.catch(() => undefined)
    return next
  }

  /** Whether the engine has a host or a group of that name. */
  private async there(table: string, name: string): Promise<boolean> {
    const rows = await this.backend.query(`GET ${table}\nColumns: name\nFilter: name = ${name}`)
    return rows.length === 1
  }

  async reload(): Promise<void> {
    if (this.settings.reload) {
      const { code, output } = await run(this.settings.reload, 60_000)
      if (code !== 0) throw new Error(`the reload command failed: ${output.trim()}`)
    } else {
      await this.backend.command(`[${now()}] RESTART_PROGRAM`)
    }
  }

  private async changeNow(revision: unknown, change: ConfigChange, dryRun: boolean): Promise<ConfigResult> {
    const { dir, paths } = this.settings
    const state = await this.state()
    if (revision !== state.revision) throw new Conflict('the config was changed in the meantime; read it again')
    const main = readMain(this.settings.main, paths)
    const engineDir = paths.toEngine(dir)
    if (!main.dirs.some((d) => d.replace(/\/+$/, '') === engineDir)) {
      throw new Refused(`the engine's main config does not read ${engineDir} with a cfg_dir line of its own`)
    }

    // What the directory will hold.
    const writes = new Map<string, string>()
    const removes: string[] = []
    let name: string
    /** What the engine shows when it has taken the change up: a host, or a group. */
    let kept = { table: 'hosts', name: '' }
    let file: string | undefined
    if (change.kind === 'put') {
      const host = checkHost(change.host, state.choices, state.templates, state.extras === true)
      name = host.name
      const before = typeof change.previous === 'string' ? change.previous : undefined
      const taken = state.hosts.some((h) => h.name === host.name) || state.unreadable.some((u) => u.file === `${host.name}.cfg`)
      if (before === undefined && taken) throw new Refused(`nuthatch already keeps a host '${host.name}'`)
      if (before !== undefined && !state.hosts.some((h) => h.name === before)) throw new Refused(`nuthatch keeps no host '${before}'`)
      if (before !== undefined && before !== host.name) {
        if (taken) throw new Refused(`nuthatch already keeps a host '${host.name}'`)
        removes.push(`${before}.cfg`)
      }
      writes.set(`${host.name}.cfg`, hostFile(host))
      // nuthatch's own commands, when the host uses one: written, or
      // written anew when this version of nuthatch has them otherwise.
      const used = [host.check_command, ...host.services.map((s) => s.check_command)].map((line) => line?.split('!')[0])
      const catalogue = catalogueFile(this.settings.plugins ?? '$USER1$', state.extras === true)
      const current = this.files().get(CATALOGUE_FILE)
      if (used.some((name) => name !== undefined && CATALOGUE_NAMES.includes(name)) && current !== catalogue) writes.set(CATALOGUE_FILE, catalogue)
    } else if (change.kind === 'delete' && typeof change.name === 'string' && state.hosts.some((h) => h.name === change.name)) {
      name = change.name
      removes.push(`${change.name}.cfg`)
    } else if (change.kind === 'put-group') {
      const group = checkGroup(change.group)
      kept = { table: `${group.type}s`, name: group.name }
      name = group.name
      const kept_ = (state.groups ?? []).filter((g) => g.type === group.type)
      const before = typeof change.previous === 'string' ? change.previous : undefined
      const taken = kept_.some((g) => g.name === group.name)
      if (before === undefined && taken) throw new Refused(`nuthatch already keeps a ${group.type} '${group.name}'`)
      if (before !== undefined && !kept_.some((g) => g.name === before)) throw new Refused(`nuthatch keeps no ${group.type} '${before}'`)
      if (before !== undefined && before !== group.name) {
        if (taken) throw new Refused(`nuthatch already keeps a ${group.type} '${group.name}'`)
        removes.push(groupFile(group.type, before))
      }
      file = groupFile(group.type, group.name)
      writes.set(file, groupText(group))
    } else if (
      change.kind === 'delete-group' &&
      (change.type === 'hostgroup' || change.type === 'servicegroup') &&
      (state.groups ?? []).some((g) => g.type === change.type && g.name === change.name)
    ) {
      kept = { table: `${change.type}s`, name: change.name }
      name = change.name
      removes.push(groupFile(change.type, change.name))
    } else if (change.kind === 'put-contact') {
      const contact = checkContact(change.contact, state.choices, state.extras === true)
      kept = { table: 'contacts', name: contact.name }
      name = contact.name
      const kept_ = state.contacts ?? []
      const before = typeof change.previous === 'string' ? change.previous : undefined
      const taken = kept_.some((k) => k.name === contact.name)
      if (before === undefined && taken) throw new Refused(`nuthatch already keeps a contact '${contact.name}'`)
      if (before !== undefined && !kept_.some((k) => k.name === before)) throw new Refused(`nuthatch keeps no contact '${before}'`)
      if (before !== undefined && before !== contact.name) {
        if (taken) throw new Refused(`nuthatch already keeps a contact '${contact.name}'`)
        removes.push(CONTACT_FILE(before))
      }
      file = CONTACT_FILE(contact.name)
      writes.set(file, contactText(contact))
    } else if (change.kind === 'delete-contact' && (state.contacts ?? []).some((k) => k.name === change.name)) {
      kept = { table: 'contacts', name: change.name }
      name = change.name
      removes.push(CONTACT_FILE(change.name))
    } else {
      throw new Refused('nuthatch keeps no such host, group or contact')
    }
    const text = writes.get(file ?? `${name}.cfg`) ?? ''

    // The engine's verifier, on a copy.
    const before = this.files()
    const staging = mkdtempSync(join(dirname(dir), '.nuthatch-staging-'))
    let verified: { code: number; output: string }
    try {
      const copy = join(staging, 'objects')
      mkdirSync(copy)
      for (const [file, content] of before) if (!removes.includes(file)) writeFileSync(join(copy, file), content)
      for (const [file, content] of writes) writeFileSync(join(copy, file), content)
      const stagedMain = join(staging, 'main.cfg')
      writeFileSync(stagedMain, mainWith(main, engineDir, paths.toEngine(copy)))
      verified = await run(this.settings.verify.map((part) => part.replace('{main}', paths.toEngine(stagedMain))), 60_000)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
    const output = verified.output.trim()
    if (verified.code !== 0) throw new Unverified(output)
    if (dryRun) return { verified: true, applied: false, revision: state.revision, text, output }

    // Taken: written, and the engine told.
    const write = (files: Map<string, string>, gone: string[]) => {
      for (const [file, content] of files) {
        writeFileSync(join(dir, `.${file}.new`), content)
        renameSync(join(dir, `.${file}.new`), join(dir, file))
      }
      for (const file of gone) unlinkSync(join(dir, file))
    }
    write(writes, removes)
    if (kept.name === '') kept = { table: 'hosts', name }
    const wanted = change.kind === 'put' || change.kind === 'put-group' || change.kind === 'put-contact'
    let shown = false
    let problem = ''
    try {
      // Taken up: the engine started anew, and has the host or has it no more.
      const started = () => this.backend.query('GET status\nColumns: program_start').then((rows) => rows[0]?.[0])
      const startedBefore = await started()
      // The start is known to the second: a restart within the second of
      // the last one could not be told from none.
      while (typeof startedBefore === 'number' && Date.now() / 1000 < startedBefore + 1.1) await sleep(100)
      await this.reload()
      for (let tries = 0; tries < 60 && !shown; tries++) {
        await sleep(500)
        const anew = await started().then((at) => at !== undefined && at !== startedBefore, () => false)
        shown = anew && (await this.there(kept.table, kept.name).catch(() => !wanted)) === wanted
      }
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err)
    }
    if (!shown) {
      // Put back as it was, and the engine told again.
      const restore = new Map([...before].filter(([file]) => writes.has(file) || removes.includes(file)))
      write(restore, [...writes.keys()].filter((file) => !before.has(file)))
      await this.reload().catch(() => undefined)
      throw new Error(`the engine did not take up the change within 30 seconds${problem ? ` (${problem})` : ''}; the files are as they were`)
    }
    return { verified: true, applied: true, revision: this.revision(this.files()), text, output }
  }
}
