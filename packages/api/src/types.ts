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
  version: string
  commands: string[]
  tables: string[]
  backends: BackendStatus[]
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
