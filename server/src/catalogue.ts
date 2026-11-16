// The check commands nuthatch brings, for the checks it suggests when a
// host is looked at (discover.ts). They are fixed here, never made from
// what anyone types, and written into nuthatch's own directory of the
// engine's config only when a host needs one the engine does not have.

import type { Definition } from './nagioscfg.ts'
import { writeObjects } from './nagioscfg.ts'

/** The file in nuthatch's directory that holds them; no host may be called so. */
export const CATALOGUE_FILE = 'nuthatch-commands.cfg'
export const CATALOGUE_HOST = 'nuthatch-commands'

export const AGGREGATE_COMMAND = 'nuthatch_aggregate'
export const PUSHED_COMMAND = 'nuthatch_pushed'
/** A contact's notification command when nuthatch reaches them (delivery.ts):
 * it does nothing, but the engine logs each notification, which nuthatch reads. */
export const NOTIFY_COMMAND = 'nuthatch_notify'

/** Name, then the plugin and its arguments; `{plugins}` is the plugins' directory. */
const COMMANDS: [string, string][] = [
  ['nuthatch_tcp', '{plugins}/check_tcp -H $HOSTADDRESS$ -p $ARG1$'],
  ['nuthatch_http', '{plugins}/check_http -H $HOSTADDRESS$ -p $ARG1$ -u $ARG2$ -t 10'],
  ['nuthatch_https', '{plugins}/check_http -H $HOSTADDRESS$ -p $ARG1$ -u $ARG2$ -S --sni -t 10'],
  ['nuthatch_cert', '{plugins}/check_http -H $HOSTADDRESS$ -p $ARG1$ -S --sni -C 21,7 -t 10'],
  ['nuthatch_ssh', '{plugins}/check_ssh -H $HOSTADDRESS$ -p $ARG1$'],
  ['nuthatch_smtp', '{plugins}/check_smtp -H $HOSTADDRESS$ -p $ARG1$'],
  ['nuthatch_imap', '{plugins}/check_imap -H $HOSTADDRESS$ -p $ARG1$'],
  ['nuthatch_imaps', '{plugins}/check_imap -H $HOSTADDRESS$ -p $ARG1$ -S'],
  // checkd only. A service that stands for others; and the check of a
  // service that takes pushes, run when freshness finds nothing came.
  [AGGREGATE_COMMAND, 'checkd:aggregate $ARG1$'],
  [PUSHED_COMMAND, 'checkd:dummy 2 "nothing was pushed in time"'],
  // checkd only: the machine itself, made by its agent (agent.md). A
  // state ends only when the value is clearly back under its limit (-C),
  // so one that wavers at a limit does not notify each time it crosses.
  ['nuthatch_disk', 'checkd:disk -p $ARG1$ -w $ARG2$ -c $ARG3$ -C 2 -P $SERVICESTATEID$'],
  ['nuthatch_memory', 'checkd:memory -w $ARG1$ -c $ARG2$ -C 5 -P $SERVICESTATEID$'],
  ['nuthatch_load', 'checkd:load -w $ARG1$ -c $ARG2$ -C 10% -P $SERVICESTATEID$'],
  ['nuthatch_cpu', 'checkd:cpu -w $ARG1$ -c $ARG2$ -C 10% -P $SERVICESTATEID$'],
  ['nuthatch_service', 'checkd:service -s $ARG1$'],
  [NOTIFY_COMMAND, '{nothing}'],
]

/** nuthatch's commands that only checkd can run. */
export const CHECKD_ONLY = [AGGREGATE_COMMAND, PUSHED_COMMAND, 'nuthatch_disk', 'nuthatch_memory', 'nuthatch_load', 'nuthatch_cpu', 'nuthatch_service']

/** nuthatch's commands that look at a host from outside: on a host with an
 * agent, the engine makes them, not the agent. */
export const FROM_OUTSIDE = ['nuthatch_tcp', 'nuthatch_http', 'nuthatch_https', 'nuthatch_cert', 'nuthatch_ssh', 'nuthatch_smtp', 'nuthatch_imap', 'nuthatch_imaps']

/** nuthatch's commands that look at the machine itself: only its agent
 * makes them, never the engine of its own machine. */
export const ON_AGENT = ['nuthatch_disk', 'nuthatch_memory', 'nuthatch_load', 'nuthatch_cpu', 'nuthatch_service']

export const CATALOGUE_NAMES = COMMANDS.map(([name]) => name)

/** The catalogue's commands an engine can run: checkd's only for checkd. */
export function catalogueFor(checkd: boolean): string[] {
  return CATALOGUE_NAMES.filter((name) => checkd || !CHECKD_ONLY.includes(name))
}

/** The plugins' directory as a config may give it: `$USER1$`-like, or an absolute path. */
export function pluginsDir(value: unknown): string {
  if (value === undefined) return '$USER1$'
  if (typeof value !== 'string' || !(/^\$USER[0-9]{1,3}\$$/.test(value) || /^\/[A-Za-z0-9._\/-]*[A-Za-z0-9._-]$/.test(value))) {
    throw new Error('plugins is the plugins\' directory: an absolute path, or a macro such as "$USER1$"')
  }
  return value
}

export function catalogueFile(plugins: string, checkd = true): string {
  const definitions: Definition[] = COMMANDS.filter(([name]) => checkd || !CHECKD_ONLY.includes(name)).map(([name, line]) => ({
    type: 'command',
    attrs: [
      ['command_name', name],
      ['command_line', line.replace('{plugins}', plugins).replace('{nothing}', checkd ? 'checkd:dummy 0' : '/bin/true')],
    ],
  }))
  return writeObjects(definitions, 'Written by nuthatch: the check commands its suggested checks use.\nRewritten by nuthatch; changes made here are lost.')
}
