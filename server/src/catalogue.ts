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
  // checkd only. A service that stands for others; and the command of a
  // service that takes pushes, which every service must have and this
  // one never runs.
  [AGGREGATE_COMMAND, 'checkd:aggregate $ARG1$'],
  [PUSHED_COMMAND, 'checkd:aggregate --never-run'],
]

export const CATALOGUE_NAMES = COMMANDS.map(([name]) => name)

/** The plugins' directory as a config may give it: `$USER1$`-like, or an absolute path. */
export function pluginsDir(value: unknown): string {
  if (value === undefined) return '$USER1$'
  if (typeof value !== 'string' || !(/^\$USER[0-9]{1,3}\$$/.test(value) || /^\/[A-Za-z0-9._\/-]*[A-Za-z0-9._-]$/.test(value))) {
    throw new Error('plugins is the plugins\' directory: an absolute path, or a macro such as "$USER1$"')
  }
  return value
}

export function catalogueFile(plugins: string): string {
  const definitions: Definition[] = COMMANDS.map(([name, line]) => ({
    type: 'command',
    attrs: [
      ['command_name', name],
      ['command_line', line.replace('{plugins}', plugins)],
    ],
  }))
  return writeObjects(definitions, 'Written by nuthatch: the check commands its suggested checks use.\nRewritten by nuthatch; changes made here are lost.')
}
