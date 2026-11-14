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
  /** The stream of events is open; or it broke, and is being opened again. */
  | { type: 'connected' }
  | { type: 'disconnected' }

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
  /** A timeperiod: the service is in a downtime whenever it holds (checkd). */
  downtime_period?: string
  /**
   * A service that is not checked but told its result (checkd): a job
   * elsewhere calls a URL with the token. An empty token asks for a new
   * one. With `every`, seconds, the service is CRITICAL when nothing
   * came for that long.
   */
  push?: { token: string; every?: number }
  /**
   * A service that stands for others (checkd): hosts (`web1`, `web*`,
   * `@group`) and services (`web1/http`). With `min`, a number or a
   * percentage, that many must be OK; without it, all.
   */
  aggregate?: { members: string[]; min?: string }
}

/** How a service takes pushes, for those who may see the config. */
export interface PushInfo {
  takes: boolean
  /** The path to call at the engine's HTTP API. */
  path?: string
  /** The whole address, where the server knows it (`push_url` of the backend). */
  url?: string
  /** Seconds within which a push is expected. */
  every?: number
  /** When the last result came, pushed or not; 0 for never. */
  last?: number
}

/** A downtime for every host, or service, whose name fits a pattern. */
export interface ManyDowntime {
  backend: string
  /** `web*`, or `@group` for a host group. */
  hosts: string
  /** Empty for the hosts themselves; otherwise the services on them that fit. */
  services: string
  start: number
  end: number
  comment: string
  dry_run?: boolean
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
  /** A timeperiod: the host is in a downtime whenever it holds (checkd). */
  downtime_period?: string
  services: ManagedService[]
}

/** A host group or a service group that nuthatch keeps the config of. */
export interface ManagedGroup {
  type: 'hostgroup' | 'servicegroup'
  name: string
  alias?: string
  /** Hosts by name; for a service group, `host/service`. */
  members: string[]
}

/** A contact that nuthatch keeps the config of. */
export interface ManagedContact {
  name: string
  alias?: string
  email?: string
  pager?: string
  host_notification_period: string
  service_notification_period: string
  /** Letters: d, u, r, f, s, n for hosts; w, u, c, r, f, s, n for services. */
  host_notification_options: string
  service_notification_options: string
  host_notification_commands: string[]
  service_notification_commands: string[]
  /** checkd: several notifications close together as one run of this command. */
  digest?: { command: string; wait?: number }
}

export interface ConfigState {
  backend: string
  /** The contacts nuthatch keeps. */
  contacts?: ManagedContact[]
  /** The groups nuthatch keeps. */
  groups?: ManagedGroup[]
  /** What the files are now; sent back with a change, which is refused when they changed in between. */
  revision: string
  hosts: ManagedHost[]
  /** Files in nuthatch's directory that it cannot edit, and why. */
  unreadable: { file: string; why: string }[]
  templates: { host: string[]; service: string[] }
  /** What the engine has, to choose from. */
  choices: { commands: string[]; contacts: string[]; contactgroups: string[]; hostgroups: string[]; servicegroups: string[]; timeperiods?: string[]; hosts?: string[] }
  /** The check commands nuthatch can add itself when a host uses one (its own, for suggested checks). */
  catalogue?: string[]
  /** Whether the engine is checkd, which has services that take pushes and services that stand for others. */
  extras?: boolean
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

export type ConfigChange =
  | { kind: 'put'; host: ManagedHost; /** Its name before, when it is not new. */ previous?: string }
  | { kind: 'delete'; name: string }
  | { kind: 'put-group'; group: ManagedGroup; previous?: string }
  | { kind: 'delete-group'; type: ManagedGroup['type']; name: string }
  | { kind: 'put-contact'; contact: ManagedContact; previous?: string }
  | { kind: 'delete-contact'; name: string }

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

/** Where a panel sits on the dashboard's grid of 12 columns. */
export interface Layout {
  x: number
  y: number
  w: number
  h: number
}

/** A panel on a dashboard. What it shows is asked as the one who looks. */
export type Widget = (
  | { type: 'totals'; title?: string; of: 'hosts' | 'services'; /** Of this host group only. */ hostgroup?: string }
  | { type: 'problems'; title?: string; of: 'hosts' | 'services'; unhandled?: boolean; hostgroup?: string; limit?: number }
  | { type: 'object'; title?: string; backend: string; host: string; service?: string }
  | { type: 'log'; title?: string; lines: 'alerts' | 'notifications'; hours?: number; limit?: number }
  /** A number of a check's performance data, now, with how it went. */
  | { type: 'stat'; title?: string; backend: string; host: string; service?: string; label?: string; hours?: number }
  /** A number of a check's performance data over time. */
  | { type: 'graph'; title?: string; backend: string; host: string; service?: string; label?: string; hours?: number }
) & { layout?: Layout }

export interface Dashboard {
  id: number
  owner: string
  title: string
  /** Shown to everyone who logs in, and changed by anyone; deleted by its owner only. */
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

/** A number of a check's performance data over time. */
export interface GraphSeries {
  label: string
  unit: string
  /** Time in seconds and value, oldest first. */
  points: [number, number][]
}

export interface GraphAnswer {
  /** Whether the server keeps a history for graphs at all. */
  enabled: boolean
  series: GraphSeries[]
}

/** A machine of the tailnet that the engine has no host for. */
export interface TailnetMachine {
  name: string
  address: string
  os: string
  online: boolean
  /** Someone else's, shared with this tailnet. */
  shared: boolean
}
