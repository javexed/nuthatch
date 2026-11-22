// Agents: checkd-agent on a monitored host, which connects out to the
// engine and runs that host's service checks there. nuthatch keeps the
// engine's agents directory (a `<host>.token` file per agent in use; a
// `<host>.new` for one not connected yet) and hands out the commands that
// install one.
//
// An install command carries a short-lived code, not the token: the code
// fetches a script with the token in it, once, within a quarter of an hour.

import { X509Certificate, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Backend } from './backend.ts'
import { Refused } from './policy.ts'

/** `[backend.agents]`: the engine's agents directory and how hosts reach it. */
export interface AgentSettings {
  /** checkd's `agents=` directory, which nuthatch writes token files into. */
  dir: string
  /** The engine's worker listener as hosts reach it, `host:port`; `:port` is
   * the address the host was given for nuthatch. */
  engine: string
  /** The CA of the engine's worker certificate, given to every agent. */
  ca: string
  /** The name in the engine's certificate, when it is not the host of `engine`. */
  serverName?: string
  /** checkd's HTTP API, for `/metrics`: which agents are connected. */
  metrics?: string
  /** checkd's CHECKD_HTTP_TOKEN, when it has one. */
  metricsToken?: string
}

export interface AgentRow {
  host: string
  /** Connected now; absent when it cannot be told. */
  connected?: boolean
  /** Made, not connected yet: the host's checks stay where they were. */
  waiting?: boolean
  /** While waiting: when made and when fetched (ms); where from, and the engine (`address:port`). */
  made?: number
  fetched?: number
  from?: string
  engine?: string
  /** The version the agent says it is, from its inventory. */
  version?: string
  /** The version of the agents nuthatch serves (their VERSION file). */
  current?: string
  /** It asks for updates, and asked lately (Linux, installed since updates came). */
  updater?: boolean
  /** An update is asked for, and not done yet. */
  updating?: boolean
  /** While nuthatch has a signing key: whether the agent takes only
   * binaries signed by it (installed since). */
  signs?: boolean
  /** It went back from the binary served, which did not connect. */
  refused?: boolean
}

/** What an agent says when it asks for updates. */
export interface Asking {
  /** SHA-256 of the binary it has. */
  have: string
  /** The key it takes signatures of, as nuthatch's signing.ts names it. */
  signer?: string
  /** The binary it went back from. */
  refused?: string
}

/** A binary to put in place, and its signature when nuthatch signs them. */
export interface Served {
  file: string
  sum: string
  signed?: { time: number; signature: string }
}

/** How often an agent asks for updates (checkd's update.rs), and how long
 * after its last asking it still counts as asking. */
export const ASKS_EVERY = 5 * 60_000
const ASKS_GONE = 3 * ASKS_EVERY

/** A new token not used within this long is taken back. */
const WAIT_FOR = 60 * 60_000

/** What an install script needs. */
export interface Install {
  backend: string
  host: string
  token: string
  os: 'linux' | 'windows'
  nrpe: boolean
  plugins: boolean
  /** nuthatch as this host reaches it, `https://address:port`. */
  base: string
  /** The address in `base`, for an engine given as `:port`. */
  address: string
  /** nuthatch's own certificate, when the host checks it by these. */
  pin?: Pin
}

/** A certificate as a host checks it without a CA: curl by its public key,
 * Windows PowerShell by the whole certificate. */
export interface Pin {
  /** base64 SHA-256 of the public key (curl's --pinnedpubkey). */
  key: string
  /** Hex SHA-256 of the certificate, upper case. */
  cert: string
}

export function pinOf(pem: string): Pin {
  const cert = new X509Certificate(pem)
  return {
    key: createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'),
    cert: cert.fingerprint256.replace(/:/g, '').toUpperCase(),
  }
}

/** The curl that fetches a Linux host's script. */
function fetchScript(pin: Pin | undefined, url: string): string {
  const tls = url.startsWith('https://') ? ` --proto '=https'${pin ? ` -k --pinnedpubkey 'sha256//${pin.key}'` : ''}` : ''
  // Unreachable (a firewall, a wrong address): curl says so within seconds.
  return `curl -fsSL --connect-timeout 10${tls} '${url}'`
}

/** The command a host runs, as root or Administrator. */
export function installCommand(install: Pick<Install, 'os' | 'pin'>, url: string): string {
  const { os, pin } = install
  if (os === 'linux') return `${fetchScript(pin, url)} | sudo sh`
  // Windows PowerShell 5.1 may offer only TLS 1.0 unless told.
  const tls12 = "[Net.ServicePointManager]::SecurityProtocol='Tls12';"
  if (!pin) return `${url.startsWith('https://') ? tls12 : ''}irm -TimeoutSec 15 '${url}' | iex`
  return (
    tls12 +
    `[Net.ServicePointManager]::ServerCertificateValidationCallback={param($s,$c)-join([Security.Cryptography.SHA256]::Create().ComputeHash($c.GetRawCertData())|%{$_.ToString('X2')}) -eq '${pin.cert}'};` +
    `irm -TimeoutSec 15 '${url}' | iex`
  )
}

/** A host name that can be an agent's, as checkd takes it. */
export function agentName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 200 && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)
}

export class Agents {
  readonly backend: Backend
  readonly settings: AgentSettings
  private readonly reload: () => Promise<void>

  /** Told of each inventory an agent in use sends (`<host>.inventory.json`). */
  onInventory?: (host: string, text: string, received: number) => Promise<void>
  /** Each inventory file's time when last told of. */
  private told = new Map<string, number>()
  /** Installs on their way, by host: where the host fetches from and finds
   * the engine, and when it fetched the installer. In memory. */
  private issued = new Map<string, { from: string; engine: string; fetched?: number }>()
  /** checkd refused /metrics: said once, until it answers again. */
  private refused = false
  // Kept beside the tokens, so that a restart of nuthatch forgets neither:
  // `<host>.update` while an update is asked for and not done, and
  // `<host>.asked`, whose time is when its agent last asked for updates.
  private mark(host: string, suffix: '.update' | '.asked'): string {
    return join(this.settings.dir, `${host}${suffix}`)
  }
  private wanted(host: string): boolean {
    return existsSync(this.mark(host, '.update'))
  }
  private askedAt(host: string): number | undefined {
    try {
      return statSync(this.mark(host, '.asked')).mtimeMs
    } catch {
      return undefined
    }
  }

  /** An install command was made: where the host is to fetch and connect. */
  noteIssued(host: string, from: string, engine: string): void {
    this.issued.set(host, { from, engine })
  }

  /** The host fetched its installer. */
  noteFetched(host: string, at = Date.now()): void {
    const held = this.issued.get(host)
    if (held) held.fetched = at
  }

  constructor(backend: Backend, settings: AgentSettings, reload: () => Promise<void>) {
    this.backend = backend
    this.settings = settings
    this.reload = reload
  }

  /** What a host's agent last said its machine is, as checkd wrote it. */
  inventoryFile(host: string): { text: string; received: number } | undefined {
    if (!agentName(host)) return undefined
    const file = join(this.settings.dir, `${host}.inventory.json`)
    try {
      const received = Math.floor(statSync(file).mtimeMs / 1000)
      return { text: readFileSync(file, 'utf8'), received }
    } catch {
      return undefined
    }
  }

  /** The version a host's agent says it is, from its inventory; absent
   * from agents older than that. */
  version(host: string): string | undefined {
    const found = this.inventoryFile(host)
    if (!found) return undefined
    try {
      const agent: unknown = (JSON.parse(found.text) as Record<string, unknown>).agent
      return typeof agent === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(agent) ? agent : undefined
    } catch {
      return undefined
    }
  }

  /** Whether `given` is the token of the host's agent in use. */
  tokenOf(host: string, given: string): boolean {
    if (!agentName(host) || !this.hosts().includes(host)) return false
    let token: string
    try {
      token = readFileSync(join(this.settings.dir, `${host}.token`), 'utf8').trim()
    } catch {
      return false
    }
    const [a, b] = [Buffer.from(token), Buffer.from(given)]
    return token !== '' && a.length === b.length && timingSafeEqual(a, b)
  }

  /** Asks for a host's agent to be updated, at its next asking for updates. */
  askUpdate(host: string): void {
    if (!this.hosts().includes(host)) throw new Refused(`no agent of '${host}'`)
    writeFileSync(this.mark(host, '.update'), '', { mode: 0o640 })
  }

  /** What the agent said when it last asked. */
  private said(host: string): { signer?: string; refused?: boolean } {
    try {
      const found = JSON.parse(readFileSync(this.mark(host, '.asked'), 'utf8')) as Record<string, unknown>
      return { ...(typeof found.signer === 'string' ? { signer: found.signer } : {}), ...(found.refused === true ? { refused: true } : {}) }
    } catch {
      return {}
    }
  }

  /** A host's agent asks, with its token checked already: the binary to
   * put in place, if it is to be replaced. It is when the binary served
   * differs from what it has and it has not gone back from it, and one
   * was asked for or updates are automatic. Automatic only for an agent
   * that takes signed binaries alone, by nuthatch's key (`signer`). */
  update(host: string, served: Served | undefined, asking: Asking, auto: boolean, signer?: string, now = Date.now()): Served | undefined {
    const refused = !!served && asking.refused === served.sum
    const signs = asking.signer !== undefined
    try {
      const file = this.mark(host, '.asked')
      writeFileSync(file, JSON.stringify({ ...(signs ? { signer: asking.signer } : {}), ...(refused ? { refused: true } : {}) }), { mode: 0o640 })
      utimesSync(file, now / 1000, now / 1000)
    } catch {
      // Not kept: shown as not asking until the next time.
    }
    if (!served) return undefined
    if (served.sum === asking.have || refused) {
      rmSync(this.mark(host, '.update'), { force: true })
      return undefined
    }
    // An agent of another key refuses what this one signs.
    if (signs && (asking.signer !== signer || !served.signed)) return undefined
    return (auto && signs) || this.wanted(host) ? served : undefined
  }

  /** Tells of inventories new since the last look, of agents in use only:
   * checks added for a host whose agent still waits would be made by the
   * engine of its own machine until the agent is in use. */
  private async inventories(): Promise<void> {
    if (!this.onInventory) return
    for (const host of this.hosts()) {
      const file = join(this.settings.dir, `${host}.inventory.json`)
      let at: number
      try {
        at = statSync(file).mtimeMs
      } catch {
        continue
      }
      if (this.told.get(host) === at) continue
      const found = this.inventoryFile(host)
      if (!found) continue
      this.told.set(host, at)
      await this.onInventory(host, found.text, found.received).catch((err: unknown) => console.error(`agents: inventory of ${host}: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  private files(suffix: '.token' | '.new'): string[] {
    if (!existsSync(this.settings.dir)) return []
    return readdirSync(this.settings.dir)
      .filter((f) => f.endsWith(suffix))
      .map((f) => f.slice(0, -suffix.length))
      .filter(agentName)
      .sort()
  }

  /** Hosts whose agent is in use, with a `.token`. */
  hosts(): string[] {
    return this.files('.token')
  }

  /** `signer`: the id of nuthatch's signing key, when it has one. */
  async list(signer?: string): Promise<AgentRow[]> {
    const pools = await this.pools()
    const known = this.hosts()
    const waiting = this.files('.new').filter((h) => !known.includes(h))
    const now = Date.now()
    const rows: AgentRow[] = [
      ...known.map((host) => {
        const version = this.version(host)
        const asked = this.askedAt(host)
        const asking = asked !== undefined && now - asked < ASKS_GONE
        const said = asking ? this.said(host) : {}
        return {
          host,
          ...(version ? { version } : {}),
          ...(asking ? { updater: true } : {}),
          ...(this.wanted(host) ? { updating: true } : {}),
          ...(asking && signer ? { signs: said.signer === signer } : {}),
          ...(said.refused ? { refused: true } : {}),
        }
      }),
      ...waiting.map((host) => ({ host, waiting: true, ...this.progress(host) })),
    ]
    rows.sort((a, b) => a.host.localeCompare(b.host))
    return rows.map((row) => (pools ? { ...row, connected: (pools.get(`host_${row.host}`) ?? 0) + (pools.get(`waiting_${row.host}`) ?? 0) > 0 } : row))
  }

  /** How far a waiting install has come. */
  private progress(host: string): Pick<AgentRow, 'made' | 'fetched' | 'from' | 'engine'> {
    let made: number | undefined
    try {
      made = Math.floor(statSync(join(this.settings.dir, `${host}.new`)).mtimeMs)
    } catch {
      // Gone just now.
    }
    const held = this.issued.get(host)
    return { ...(made ? { made } : {}), ...(held ? { from: held.from, engine: held.engine, ...(held.fetched ? { fetched: held.fetched } : {}) } : {}) }
  }

  /** Workers per pool, from checkd's `/metrics`. */
  private async pools(): Promise<Map<string, number> | undefined> {
    if (!this.settings.metrics) return undefined
    try {
      const answer = await fetch(`${this.settings.metrics.replace(/\/+$/, '')}/metrics`, {
        signal: AbortSignal.timeout(3000),
        ...(this.settings.metricsToken ? { headers: { authorization: `Bearer ${this.settings.metricsToken}` } } : {}),
      })
      if (!answer.ok) {
        // Said once: without /metrics no new agent is ever taken on.
        if (!this.refused) console.error(`agents: ${this.backend.name}: checkd's /metrics answered ${answer.status}${answer.status === 401 ? '; give the backend http_token_file' : ''}`)
        this.refused = true
        return undefined
      }
      this.refused = false
      const found = new Map<string, number>()
      for (const m of (await answer.text()).matchAll(/^checkd_pool_workers\{pool="([^"]+)"\} (\d+)$/gm)) {
        if (m[1] !== undefined) found.set(m[1], Number(m[2]))
      }
      return found
    } catch {
      return undefined
    }
  }

  /** A new token for a host's agent, as `<host>.new`: checkd lets the agent
   * in with it but sends it nothing, and the host's checks stay where they
   * were, until `settle` sees it connected. An agent the host has goes on
   * until then. */
  async add(host: string): Promise<string> {
    if (!agentName(host)) throw new Refused('a host name of letters, digits, ., - and _')
    const rows = await this.backend.query(`GET hosts\nColumns: name\nFilter: name = ${host}`)
    if (rows.length !== 1) throw new Refused(`no host '${host}'`)
    const token = randomBytes(24).toString('base64url')
    const file = join(this.settings.dir, `${host}.new`)
    const fresh = join(this.settings.dir, `.${host}.new.tmp`)
    // Readable by the group too: checkd may run as another user of it.
    writeFileSync(fresh, `${token}\n`, { mode: 0o640 })
    chmodSync(fresh, 0o640)
    renameSync(fresh, file)
    return token
  }

  /** A new token whose agent has connected becomes the host's, and checkd
   * reloads to send it the host's checks; one not used within the hour is
   * taken back. Run every few seconds. */
  async settle(now = Date.now()): Promise<void> {
    const waiting = this.files('.new')
    if (waiting.length === 0) return this.inventories()
    const pools = await this.pools()
    let joined = false
    for (const host of waiting) {
      const file = join(this.settings.dir, `${host}.new`)
      if ((pools?.get(`waiting_${host}`) ?? 0) > 0) {
        renameSync(file, join(this.settings.dir, `${host}.token`))
        this.issued.delete(host)
        joined = true
      } else if (now - statSync(file).mtimeMs > WAIT_FOR) {
        unlinkSync(file)
      }
    }
    if (joined) await this.reload()
    await this.inventories()
  }

  async remove(host: string): Promise<boolean> {
    if (!agentName(host)) return false
    let found = false
    let inUse = false
    for (const suffix of ['.new', '.token', '.inventory.json', '.update', '.asked']) {
      const file = join(this.settings.dir, `${host}${suffix}`)
      if (!existsSync(file)) continue
      unlinkSync(file)
      found = true
      inUse ||= suffix === '.token'
    }
    this.told.delete(host)
    this.issued.delete(host)
    if (inUse) await this.reload()
    return found
  }

  ca(): string {
    return readFileSync(this.settings.ca, 'utf8')
  }
}

const CODE_FOR = 15 * 60_000

/** One-use install codes, kept in memory. */
export class InstallCodes {
  private codes = new Map<string, { install: Install; until: number }>()

  make(install: Install): { code: string; until: number } {
    const now = Date.now()
    for (const [code, held] of this.codes) if (held.until < now) this.codes.delete(code)
    const code = randomBytes(18).toString('base64url')
    const until = now + CODE_FOR
    this.codes.set(code, { install, until })
    return { code, until }
  }

  take(code: string): Install | undefined {
    const held = this.codes.get(code)
    this.codes.delete(code)
    return held && held.until >= Date.now() ? held.install : undefined
  }
}

/** The agent binaries nuthatch serves, and their SHA-256 from SHA256SUMS. */
export function binaries(dir: string): Map<string, string> {
  const sums = new Map<string, string>()
  try {
    for (const line of readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n')) {
      const m = /^([0-9a-f]{64}) [ *]?(checkd-agent-[a-z0-9_.-]+)$/.exec(line.trim())
      if (m?.[1] !== undefined && m[2] !== undefined && existsSync(join(dir, m[2]))) sums.set(m[2], m[1])
    }
  } catch {
    // None.
  }
  return sums
}

/** The version of the agent binaries nuthatch serves: their VERSION file
 * (checkd's scripts/build-agents.sh). */
export function binariesVersion(dir: string): string | undefined {
  try {
    const text = readFileSync(join(dir, 'VERSION'), 'utf8').trim()
    return /^[A-Za-z0-9._+-]{1,64}$/.test(text) ? text : undefined
  } catch {
    return undefined
  }
}

/** The binary for a machine as the agent names it: Rust's OS (Linux when
 * it does not say) and ARCH. */
export function binaryFor(os: string, arch: string): string | undefined {
  if (os === 'windows') return arch === 'x86_64' ? 'checkd-agent-windows-x86_64.exe' : undefined
  if (os !== 'linux') return undefined
  return arch === 'x86_64' ? 'checkd-agent-linux-x86_64' : arch === 'aarch64' ? 'checkd-agent-linux-aarch64' : undefined
}

interface ScriptFacts {
  install: Install
  settings: AgentSettings
  ca: string
  sums: Map<string, string>
  /** While nuthatch signs the binaries: the certificate agents take
   * signatures by, and when each binary in `sums` was signed. */
  signer?: { cert: string; times: Map<string, number> }
}

/** The engine as this host reaches it. */
export const engineOf = (install: Pick<Install, 'address'>, settings: Pick<AgentSettings, 'engine'>) =>
  settings.engine.startsWith(':') ? `${install.address.includes(':') ? `[${install.address}]` : install.address}${settings.engine}` : settings.engine

const sh = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
// PowerShell ends a quoted string at any of these quotes, not only '.
const ps = (text: string) => `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'`
const engineHost = (engine: string) => engine.replace(/^\[([^\]]+)\](:\d+)?$/, '$1').replace(/:\d+$/, '')

/** The same, run over SSH as `user`: on Linux through sudo, its password
 * (if it asks) the first line of standard input, which nothing else reads;
 * on Windows by Windows PowerShell, the command encoded so that the shell
 * of the SSH server leaves it alone. */
export function sshCommand(install: Pick<Install, 'os' | 'pin'>, url: string, user: string): string {
  if (install.os === 'linux') {
    const both = `${fetchScript(install.pin, url)} | sh`
    return user === 'root' ? `sh -c ${sh(both)}` : `sudo -S -p '' sh -c ${sh(both)}`
  }
  const encoded = Buffer.from(installCommand(install, url), 'utf16le').toString('base64')
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
}

/** The install script for Linux: run as root, `curl ... | sudo sh`. */
export function linuxScript({ install, settings, ca, sums, signer }: ScriptFacts): string {
  const { base, pin } = install
  const engine = engineOf(install, settings)
  const arch = (name: string) => `${base}/agent/bin/${name}`
  const x86 = 'checkd-agent-linux-x86_64'
  const arm = 'checkd-agent-linux-aarch64'
  const args = [
    '--engine', engine,
    '--name', install.host,
    '--token-file', '/etc/checkd-agent/token',
    '--ca', '/etc/checkd-agent/ca.crt',
    ...(settings.serverName ? ['--server-name', settings.serverName] : []),
    // checkd's own checks need no program; plugins only from these places.
    ...(install.plugins ? ['--restrict-path', '/usr/lib/nagios/plugins', '--restrict-path', '/usr/lib64/nagios/plugins'] : []),
    '--restrict-path', '/usr/local/lib/checkd-agent',
    // It asks nuthatch for updates, and replaces itself (docs/agents.md).
    '--update-from', `${base}/agent/update/${encodeURIComponent(install.backend)}/${install.host}`,
    ...(pin ? ['--update-pin', Buffer.from(pin.key, 'base64').toString('hex')] : []),
    ...(signer ? ['--update-signer', '/etc/checkd-agent/signer.crt'] : []),
  ]
  const signed = (name: string) => String(signer?.times.get(name) ?? '')
  return `#!/bin/sh
# checkd-agent for ${install.host}, from nuthatch.
# All in one function, called on the last line: a download cut short runs nothing.
set -eu
main() {
[ "$(id -u)" = 0 ] || { echo "Run this as root: curl ... | sudo sh" >&2; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) file=${x86}; url=${sh(arch(x86))}; sum=${sh(sums.get(x86) ?? '')}; signed=${sh(signed(x86))} ;;
  aarch64|arm64) file=${arm}; url=${sh(arch(arm))}; sum=${sh(sums.get(arm) ?? '')}; signed=${sh(signed(arm))} ;;
  *) echo "No checkd-agent for $(uname -m)" >&2; exit 1 ;;
esac
[ -n "$sum" ] || { echo "nuthatch has no ${signer ? 'signed ' : ''}$file" >&2; exit 1; }

packages() {
  if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q "$@" >/dev/null
  elif command -v yum >/dev/null; then yum install -y -q "$@" >/dev/null
  elif command -v zypper >/dev/null; then zypper -q install -y "$@" >/dev/null
  elif command -v apk >/dev/null; then apk add -q "$@" >/dev/null
  else echo "No package manager found for: $*" >&2; return 1
  fi
}
fetch() {
${pin ? `  curl -fsSL --proto '=https' -k --pinnedpubkey ${sh(`sha256//${pin.key}`)} "$1" -o "$2"` : `  if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"; else wget -q "$1" -O "$2"; fi`}
}
${install.plugins || install.nrpe ? `
if command -v apt-get >/dev/null; then apt-get update -q >/dev/null; packages monitoring-plugins
elif command -v apk >/dev/null; then packages monitoring-plugins
else packages nagios-plugins-all || packages monitoring-plugins
fi
` : ''}
mkdir -p -m 755 /usr/local/lib/checkd-agent
id checkd-agent >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin checkd-agent 2>/dev/null || adduser -S -H -s /sbin/nologin checkd-agent
# The binary, in a directory of the agent's own user, which replaces it
# with what nuthatch gives when it is updated: no root needed then.
# Root writes nothing inside it but by a rename, which replaces a link left
# there instead of following it.
bin=/var/lib/checkd-agent/bin
mkdir -p -m 755 /var/lib/checkd-agent
chown root:root /var/lib/checkd-agent
chmod 755 /var/lib/checkd-agent
[ -L "$bin" ] && rm -f "$bin"
mkdir -p -m 755 "$bin"
chown checkd-agent "$bin"
chmod 755 "$bin"
umask 077
mkdir -p /etc/checkd-agent
new=$(mktemp -d /var/lib/checkd-agent/.install.XXXXXX)
fetch "$url" "$new/checkd-agent"
echo "$sum  $new/checkd-agent" | sha256sum -c - >/dev/null || { echo "The download does not match its checksum" >&2; rm -rf "$new"; exit 1; }
chmod 755 "$new/checkd-agent"
chown checkd-agent "$new/checkd-agent"
# What an earlier agent left: a binary on trial, one refused, and the rest.
rm -f "$bin/checkd-agent.new" "$bin/checkd-agent.old" "$bin/checkd-agent.trial" "$bin/checkd-agent.refused" "$bin/checkd-agent.signed"
${signer ? `printf '%s\\n' "$signed" > "$new/checkd-agent.signed"
chown checkd-agent "$new/checkd-agent.signed"
mv -f "$new/checkd-agent.signed" "$bin/checkd-agent.signed"
` : ''}mv -f "$new/checkd-agent" "$bin/checkd-agent"
rmdir "$new"
printf '%s\\n' ${sh(install.token)} > /etc/checkd-agent/token
cat > /etc/checkd-agent/ca.crt <<'CHECKD_AGENT_CA'
${ca.trim()}
CHECKD_AGENT_CA
${signer ? `cat > /etc/checkd-agent/signer.crt <<'CHECKD_AGENT_SIGNER'
${signer.cert.trim()}
CHECKD_AGENT_SIGNER
chmod 644 /etc/checkd-agent/signer.crt
` : 'rm -f /etc/checkd-agent/signer.crt\n'}chgrp checkd-agent /etc/checkd-agent/token
chmod 640 /etc/checkd-agent/token
chmod 644 /etc/checkd-agent/ca.crt
chmod 755 /etc/checkd-agent

cat > /etc/systemd/system/checkd-agent.service <<'CHECKD_AGENT_UNIT'
[Unit]
Description=checkd-agent: this host's checks for checkd
After=network-online.target
Wants=network-online.target

[Service]
User=checkd-agent
ExecStart=/var/lib/checkd-agent/bin/checkd-agent ${args.map((a) => (/^[A-Za-z0-9_./:@=-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, '\\$1')}"`)).join(' ')}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
CHECKD_AGENT_UNIT
systemctl daemon-reload
systemctl enable checkd-agent >/dev/null 2>&1
systemctl restart checkd-agent
# Where the agent was before it could replace itself.
rm -f /usr/local/bin/checkd-agent
echo "checkd-agent runs for ${install.host}"
${install.nrpe ? nrpeLinux(engineHost(engine)) : ''}
}
main "$@"
`
}

function nrpeLinux(engine: string): string {
  return `
# NRPE, for check_nrpe from the engine.
if command -v apt-get >/dev/null; then packages nagios-nrpe-server; unit=nagios-nrpe-server
elif command -v apk >/dev/null; then packages nrpe; unit=nrpe
else packages nrpe; unit=nrpe
fi
for cfg in /etc/nagios/nrpe.cfg /etc/nrpe.cfg; do
  [ -f "$cfg" ] || continue
  if grep -q '^allowed_hosts=' "$cfg"; then
    grep '^allowed_hosts=' "$cfg" | tail -n 1 | cut -d= -f2- | tr ',' '\\n' | tr -d ' ' | grep -qxF ${sh(engine)} || sed -i 's/^allowed_hosts=.*/&,'${sh(engine)}'/' "$cfg"
  else
    echo 'allowed_hosts=127.0.0.1,'${sh(engine)} >> "$cfg"
  fi
  break
done
systemctl enable "$unit" >/dev/null 2>&1 || true
systemctl restart "$unit"
echo "NRPE runs, open to ${engine.replace(/[^A-Za-z0-9._:-]/g, '')}"
`
}

/** The install script for Windows: an Administrator PowerShell, `irm ... | iex`.
 * The binary is in a directory of its own that LOCAL SERVICE, which runs
 * it, may write, so that it replaces itself as on Linux; the task starts
 * it anew within a minute of its ending. */
export function windowsScript({ install, settings, ca, sums, signer }: ScriptFacts): string {
  const { base, pin } = install
  const file = 'checkd-agent-windows-x86_64.exe'
  const args = [
    '--engine', engineOf(install, settings),
    '--name', install.host,
    '--token-file', '$data\\token',
    '--ca', '$data\\ca.crt',
    ...(settings.serverName ? ['--server-name', settings.serverName] : []),
    '--restrict-path', '$dir\\plugins',
    '--update-from', `${base}/agent/update/${encodeURIComponent(install.backend)}/${install.host}`,
    ...(pin ? ['--update-pin', Buffer.from(pin.key, 'base64').toString('hex')] : []),
    ...(signer ? ['--update-signer', '$data\\signer.crt'] : []),
  ]
  // Inside a PowerShell string in double quotes: a quote is `".
  const argLine = args.map((a) => (/\s/.test(a) || a.startsWith('$') ? `\`"${a}\`"` : a)).join(' ')
  const signed = signer?.times.get(file)
  return `# checkd-agent for ${install.host}, from nuthatch.
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run this in PowerShell as Administrator' }
$sum = ${ps(sums.get(file) ?? '')}
if ($sum -eq '') { throw 'nuthatch has no ${signer ? 'signed ' : ''}${file}' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dir = Join-Path $env:ProgramFiles 'checkd-agent'
$data = Join-Path $env:ProgramData 'checkd-agent'
$bin = Join-Path $data 'bin'
New-Item -ItemType Directory -Force -Path $dir, (Join-Path $dir 'plugins') | Out-Null
Get-ScheduledTask -TaskName 'checkd-agent' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
Get-Process -Name 'checkd-agent' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# Made anew, so that nobody who made it first keeps a hold on it.
# By cmd's rmdir, which takes a link (junction) away itself, there or
# inside, and never what it points to, as Remove-Item may.
if (Test-Path $data) { cmd /c rmdir /s /q "$data" | Out-Null }
if (Test-Path $data) { throw "$data cannot be removed" }
New-Item -ItemType Directory -Path $data | Out-Null
icacls $data /setowner '*S-1-5-32-544' | Out-Null
icacls $data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)R' | Out-Null
# The binary's own directory: LOCAL SERVICE replaces what is in it.
New-Item -ItemType Directory -Path $bin | Out-Null
icacls $bin /grant '*S-1-5-19:(OI)(CI)M' | Out-Null
$exe = Join-Path $bin 'checkd-agent.exe'
Invoke-WebRequest -UseBasicParsing -Uri ${ps(`${base}/agent/bin/${file}`)} -OutFile "$exe.download"
if ((Get-FileHash -Algorithm SHA256 "$exe.download").Hash.ToLower() -ne $sum) { Remove-Item "$exe.download"; throw 'The download does not match its checksum' }
Move-Item -Force "$exe.download" $exe
# Where the agent was before it could replace itself.
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $dir 'checkd-agent.exe')
Set-Content -NoNewline -Encoding ascii -Path (Join-Path $data 'token') -Value ${ps(install.token)}
Set-Content -Encoding ascii -Path (Join-Path $data 'ca.crt') -Value @'
${ca.trim()}
'@
${signer ? `Set-Content -Encoding ascii -Path (Join-Path $data 'signer.crt') -Value @'
${signer.cert.trim()}
'@
Set-Content -Encoding ascii -Path (Join-Path $bin 'checkd-agent.signed') -Value '${signed ?? ''}'
` : ''}$action = New-ScheduledTaskAction -Execute $exe -Argument "${argLine}"
# At startup, and every minute: a start while it runs is ignored, so it
# comes back within a minute of ending, as it does when it is updated.
$atStartup = New-ScheduledTaskTrigger -AtStartup
$again = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\\LOCALSERVICE' -LogonType ServiceAccount
Register-ScheduledTask -TaskName 'checkd-agent' -Action $action -Trigger $atStartup, $again -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'checkd-agent'
${pin ? '[Net.ServicePointManager]::ServerCertificateValidationCallback = $null\n' : ''}Write-Host 'checkd-agent runs for ${install.host}'
`
}
