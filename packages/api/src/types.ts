// What the nuthatch server sends and takes. No framework here: this
// directory is used as it is by the web interface and by the phone app.

export type Role =
  | 'all_hosts'
  | 'all_services'
  | 'all_host_commands'
  | 'all_service_commands'
  | 'system_commands'
  | 'system_information'
  | 'configuration_information'
  | 'read_only'
  | 'config_edit'

export interface BackendStatus {
  name: string
  ok: boolean
  /** Whether the engine limits what a user sees. One that does not is
   * open only to users with the role all_hosts. */
  limits_users?: boolean
  error?: string
  program_version?: string
  livestatus_version?: string
  program_start?: number
}

export interface Session {
  user: string
  roles: Role[]
  /** Per backend: whether this user, as a contact, may send commands. */
  can_submit_commands: Record<string, boolean>
  /** Sent back in a header with every request that changes something. */
  csrf: string | null
  /** Known by the tailnet identity, through tailscale serve: logging out would only log in again. */
  by_tailnet?: boolean
  version: string
  commands: string[]
  tables: string[]
  backends: BackendStatus[]
  /** The backends whose config can be changed here, by those with the role config_edit. */
  config_backends: string[]
}

export interface Sort {
  column: string
  desc?: boolean
}

export interface Query<C extends string = string> {
  table: string
  columns: C[]
  /** Livestatus `Filter:`, `And:`, `Or:` and `Negate:` lines. */
  headers?: string[]
  sort?: Sort[]
  offset?: number
  limit?: number
  /** The backends to ask; all of them when left out. */
  backends?: string[]
}

export type Row<C extends string = string> = Record<C, unknown> & { backend: string }

export interface QueryAnswer<C extends string = string> {
  rows: Row<C>[]
  /** How many rows there are before `offset` and `limit`; known when the
   * query sorts. */
  total: number | null
  /** Backends that gave no answer, and why. */
  errors: Record<string, string>
}

export interface Stats {
  table: string
  /** Filter lines and `Stats:` lines. */
  headers: string[]
  group_by?: string[]
  backends?: string[]
}

export interface Group {
  key: unknown[]
  values: number[]
}

export interface StatsAnswer {
  groups: Group[]
  by_backend: Record<string, Group[]>
  errors: Record<string, string>
}

export interface Command {
  backend: string
  command: string
  args: (string | number)[]
}

export interface Token {
  id: number
  name: string
  created: number
  last_used: number | null
}

export type ServerEvent =
  | { type: 'changed'; backend?: string }
  | { type: 'backend'; name: string; ok: boolean }

/** A service of a host that nuthatch keeps the config of. */
export interface ManagedService {
  description: string
  /** The template it takes its settings from. */
  use: string
  /** A command's name, with its arguments after `!`. */
  check_command?: string
  servicegroups: string[]
  contacts: string[]
  contact_groups: string[]
  notes?: string
}

/** A host that nuthatch keeps the config of, with its services. */
export interface ManagedHost {
  name: string
  alias?: string
  address: string
  use: string
  check_command?: string
  hostgroups: string[]
  contacts: string[]
  contact_groups: string[]
  notes?: string
  services: ManagedService[]
}

export interface ConfigState {
  backend: string
  /** What the files are now; sent back with a change, which is refused when they changed in between. */
  revision: string
  hosts: ManagedHost[]
  /** Files in nuthatch's directory that it cannot edit, and why. */
  unreadable: { file: string; why: string }[]
  templates: { host: string[]; service: string[] }
  /** What the engine has, to choose from. */
  choices: { commands: string[]; contacts: string[]; contactgroups: string[]; hostgroups: string[]; servicegroups: string[] }
  /** The check commands nuthatch can add itself when a host uses one (its own, for suggested checks). */
  catalogue?: string[]
}

/** A port found open when a host was looked at, and what answered there. */
export interface FoundPort {
  port: number
  /** What usually answers on this port. */
  service: string
  kind: 'banner' | 'web' | 'tls' | 'open'
  /** The first line the service said, for SSH, SMTP and the like. */
  banner?: string
  http?: { status: number; title?: string; location?: string }
  tls?: { subject?: string; issuer?: string; expires: string; days: number; trusted: boolean }
}

/** A check suggested for a host that was looked at. */
export interface Suggestion {
  description: string
  check_command: string
  /** Whether it is ticked to begin with. */
  checked: boolean
  /** What was found that led to it. */
  why: string
}

/** What looking at a host before adding it found. */
export interface Discovery {
  /** What was typed. */
  input: string
  /** A name for the host. */
  name: string
  /** Its address as it will be written: the name or address typed. */
  address: string
  /** What the name stands for. */
  addresses: string[]
  /** Whether it answered ping; null when ping could not be tried. */
  ping: { ok: boolean; ms?: number } | null
  found: FoundPort[]
  /** A check for the host itself, when it does not answer ping. */
  host_check?: string
  suggestions: Suggestion[]
}

export type ConfigChange = { kind: 'put'; host: ManagedHost; /** Its name before, when it is not new. */ previous?: string } | { kind: 'delete'; name: string }

export interface ConfigResult {
  /** Whether the engine's own check took the config. */
  verified: boolean
  applied: boolean
  revision: string
  /** The file as it is written, for a `put`. */
  text: string
  /** What the engine's check said. */
  output: string
}

/** A box on a dashboard. What it shows is asked as the one who looks. */
export type Widget =
  | { type: 'totals'; title?: string; of: 'hosts' | 'services'; /** Of this host group only. */ hostgroup?: string }
  | { type: 'problems'; title?: string; of: 'hosts' | 'services'; unhandled?: boolean; hostgroup?: string; limit?: number }
  | { type: 'object'; title?: string; backend: string; host: string; service?: string }
  | { type: 'log'; title?: string; lines: 'alerts' | 'notifications'; hours?: number; limit?: number }

export interface Dashboard {
  id: number
  owner: string
  title: string
  /** Shown to everyone who logs in; changed by its owner only. */
  shared: boolean
  widgets: Widget[]
  updated: number
}

/** A dashboard to make or to change. */
export type DashboardDraft = Pick<Dashboard, 'title' | 'shared' | 'widgets'>

/** Notifications pushed to this user's browsers. */
export interface PushState {
  /** Whether the server is set up to push at all. */
  enabled: boolean
  /** The server's public key, which a browser subscribes with. */
  key?: string
  devices: { name: string; created: number; endpoint: string }[]
}
