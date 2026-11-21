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
  /** Backends whose agents this user may add here. */
  agent_backends?: string[]
  /** The assistant, where it is set up and this user may use it or set its key. */
  assistant?: AssistantState
}

export interface AssistantState {
  /** This user can ask it now. */
  ready: boolean
  /** An API key is kept. */
  key: boolean
  /** This user may set the key (config_edit). */
  set_key: boolean
}

/** Which model service the assistant asks. */
export type AssistantService = 'anthropic' | 'ollama' | 'openai'

/** The assistant's settings, as the Config page is told them (config_edit). */
export interface AssistantSettings {
  service: AssistantService
  /** The service's address. */
  url: string
  model: string
  /** Anthropic only. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Ollama only: how many tokens the model may hold. */
  context: number
  /** A key is kept. */
  key: boolean
}

/** New settings: `key` left out keeps the kept one while service and address stay; '' takes it away. */
export type AssistantSettingsChange = Omit<AssistantSettings, 'key'> & { key?: string }

/** A turn of a conversation with the assistant. */
export interface AssistantTurn {
  role: 'user' | 'assistant'
  text: string
}

/** What the assistant sends while it answers. */
export type AssistantEvent = { kind: 'text'; text: string } | { kind: 'tool'; text: string } | { kind: 'done'; steps: number } | { kind: 'error'; error: string }

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
  passive?: { token: string; every?: number }
  /**
   * A service that stands for others (checkd): hosts (`web1`, `web*`,
   * `@group`) and services (`web1/http`). With `min`, a number or a
   * percentage, that many must be OK; without it, all.
   */
  aggregate?: { members: string[]; min?: string }
  /** Where it is checked on a checkd with agents: by the engine, a look
   * from outside; or only by the host's agent, a look at the machine
   * itself. Set by nuthatch for its own commands of those kinds. */
  run_on?: 'engine' | 'agent'
}

/** How a service takes passive results, for those who may see the config. */
export interface PassiveInfo {
  takes: boolean
  /** The path to call at the engine's HTTP API. */
  path?: string
  /** The whole address, where the server knows it (`http_url` of the backend). */
  url?: string
  /** Seconds within which a result is expected. */
  every?: number
  /** When the last result came, by HTTP or not; 0 for never. */
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
  /** How nuthatch reaches them besides the browsers they installed it in. */
  reach?: Reach
}

/** A contact's ways: e-mail to their address, a chat link by its name, an ntfy topic. */
export interface Reach {
  email?: boolean
  chat?: string
  ntfy?: string
}

export type ChatKind = 'slack' | 'discord' | 'teams' | 'google-chat' | 'mattermost'

/** How nuthatch sends, for config_edit; the mail password is never shown. */
export interface DeliverySettings {
  email?: { host: string; port: number; user: string; from: string; has_password: boolean; password?: string }
  chats: { name: string; kind: ChatKind; url: string }[]
  ntfy: { server: string }
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
  /** Whether the engine is checkd, which has services that take passive results and services that stand for others. */
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
/** A guess at a host's system, from outside. */
export interface SystemGuess {
  family: 'linux' | 'windows' | 'unix'
  /** What it was told by. */
  why: string
}

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
  system?: SystemGuess
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
/** The time a dashboard's graphs, numbers and availability span. */
export type Range = '15m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d' | '90d' | 'today' | 'yesterday' | 'week' | 'last-month'
/** Each range: its name, and how long it is when it ends now (the
 * others follow the calendar, in the looker's time zone). */
export const RANGES: Record<Range, { label: string; seconds?: number }> = {
  '15m': { label: '15m', seconds: 900 },
  '1h': { label: '1h', seconds: 3600 },
  '6h': { label: '6h', seconds: 6 * 3600 },
  '12h': { label: '12h', seconds: 12 * 3600 },
  '24h': { label: '24h', seconds: 86400 },
  '7d': { label: '7d', seconds: 7 * 86400 },
  '30d': { label: '30d', seconds: 30 * 86400 },
  '90d': { label: '90d', seconds: 90 * 86400 },
  today: { label: 'Today' },
  yesterday: { label: 'Yesterday' },
  week: { label: 'This week' },
  'last-month': { label: 'Last month' },
}

/** A host or service a panel is about. The host `$host` is the one chosen
 * at the top of a dashboard that lets a host be chosen. */
export interface Target {
  backend: string
  host: string
  service?: string
}

/** One number of a check's performance data. */
export interface Series extends Target {
  label: string
}

/** What a status or availability panel covers: one host or service, a
 * host group, or (neither) everything. */
export interface Scope {
  of?: Target
  hostgroup?: string
}

export type ProblemsShow = 'problems' | 'acknowledged' | 'downtimes' | 'recovered'

/** A panel's settings, without its place on the grid. */
export type PanelSettings =
  /** One host or service as a card; a group or everything as counts and tiles. */
  | ({ type: 'status'; title?: string } & Scope)
  /** Hosts or services: problems nobody has taken care of, those acknowledged, in a downtime, or recovered within the range. */
  | { type: 'problems'; title?: string; of: 'hosts' | 'services'; show: ProblemsShow; hostgroup?: string }
  /** Numbers over time: small, the first as a number; larger, a graph. */
  | { type: 'metric'; title?: string; series: Series[] }
  | { type: 'log'; title?: string; lines: 'alerts' | 'notifications' }
  /** The share of time up or OK over the range. */
  | ({ type: 'availability'; title?: string } & Scope)
  /** Text, with its web addresses as links. */
  | { type: 'note'; title?: string; text: string }

export type Widget = PanelSettings & { layout: Layout }

export interface DashboardBody {
  title: string
  /** Shown to everyone who logs in, and changed by anyone; deleted by its owner only. */
  shared: boolean
  range: Range
  /** A host is chosen at the top (of this host group, if given), for panels about `$host`. */
  choose_host?: { hostgroup?: string }
  widgets: Widget[]
}

export interface Dashboard extends DashboardBody {
  id: number
  owner: string
  updated: number
}

/** A dashboard to make or to change. */
export type DashboardDraft = DashboardBody

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

/** A host's checkd-agent. */
export interface AgentRow {
  host: string
  /** Connected now; absent when it cannot be told. */
  connected?: boolean
  /** Its install command is made, and its agent has not connected yet: the
   * host's checks stay where they were. */
  waiting?: boolean
  /** Its system, from its inventory. */
  os?: string
  /** Checks proposed from its inventory, not taken up or set aside yet. */
  proposals?: number
  /** The version the agent says it is, and that of the agents nuthatch serves. */
  version?: string
  current?: string
  /** It asks for updates (Linux, installed since updates came), and asked lately. */
  updater?: boolean
  /** An update is asked for and not done yet. */
  updating?: boolean
  /** While waiting: when its command was made, when the host fetched the
   * installer (ms), and where the host fetches it from and finds the
   * engine (`address:port`); unknown after nuthatch restarted. */
  made?: number
  fetched?: number
  from?: string
  engine?: string
}

/** What this machine's firewall keeps out of the agent ports, and what lets it in. */
export interface FirewallGap {
  port: number
  from: string
  command: string
}

/** What an agent says its machine is and runs. Its word only: shown and
 * proposed from, never run. */
export interface Inventory {
  os: { family: string; name: string; id: string; version: string; kernel: string; arch: string }
  hostname: string
  cpus: number
  memory: number
  disks: { path: string; fs: string; size: number; used_pct: number }[]
  services: { name: string; description: string }[]
  ports: { port: number; address: string }[]
}

/** A check proposed from an inventory. */
export interface Proposal {
  /** Stands for it when it is taken up or set aside. */
  key: string
  description: string
  /** What led to it. */
  why: string
  /** Ticked to begin with. */
  checked: boolean
}

export interface HostInventory {
  inventory: Inventory
  /** When it came, s since 1970. */
  received: number
  /** Whether nuthatch keeps the host's config, so that checks can be added. */
  managed: boolean
  /** The base checks were added when the inventory first came. */
  base: string[]
  proposals: Proposal[]
}

/** A login for one install over SSH: sent once, kept nowhere. */
export interface SshLogin {
  address: string
  port: number
  user: string
  password?: string
  key?: string
  passphrase?: string
  /** For sudo, when it is not the password. */
  sudo_password?: string
  /** The host key the user was shown. */
  fingerprint: string
}

export interface AgentInstall {
  /** When the code in the command stops working, ms since 1970. */
  until: number
  command: string
}
