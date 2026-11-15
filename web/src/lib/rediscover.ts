// A host looked at again: what answers there now, beside what is checked.
import type { Discovery, ManagedHost, Suggestion } from '@nuthatch/api'

export interface Changes {
  /** Checks that would be suggested for a new host and that this one does not have. */
  gained: Suggestion[]
  /** Checks of a port, among those nuthatch suggests, where nothing answers now. */
  lost: { description: string; port: number }[]
}

/** The ports a host's checks are of: to be tried too when it is looked at again. */
export function portsOf(host: ManagedHost): number[] {
  return [...new Set(host.services.flatMap((s) => portOf(s.check_command) ?? []))]
}

/** The port a check of nuthatch's own is of: `nuthatch_tcp!5432`. Only
 * those that look at a port: `nuthatch_memory!90!95` is a level, not one. */
function portOf(command: string | undefined): number | undefined {
  const found = /^nuthatch_(?:tcp|http|https|cert|ssh|smtp|imap|imaps)!(\d{1,5})(!|$)/.exec(command ?? '')
  return found ? Number(found[1]) : undefined
}

export function compare(host: ManagedHost, seen: Discovery): Changes {
  const commands = new Set(host.services.map((s) => s.check_command))
  const names = new Set(host.services.map((s) => s.description))
  const open = new Set(seen.found.map((f) => f.port))
  const checked = new Set(portsOf(host))
  return {
    // Not what is checked already, by its command, its name or its port.
    gained: seen.suggestions.filter((s) => !commands.has(s.check_command) && !names.has(s.description) && !checked.has(portOf(s.check_command) ?? -1)),
    lost: host.services.flatMap((s) => {
      const port = portOf(s.check_command)
      return port !== undefined && !open.has(port) ? [{ description: s.description, port }] : []
    }),
  }
}

/** The host with the gained checks added, for the form. */
export function withGained(host: ManagedHost, gained: Suggestion[], template: string): ManagedHost {
  return {
    ...host,
    services: [
      ...host.services,
      ...gained.map((s) => ({ description: s.description, use: template, check_command: s.check_command, servicegroups: [], contacts: [], contact_groups: [] })),
    ],
  }
}
