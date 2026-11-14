// Agents: checkd-agent on a monitored host, which connects out to the
// engine and runs that host's service checks there. nuthatch keeps the
// engine's agents directory (a `<host>.token` file per agent in use; a
// `<host>.new` for one not connected yet) and hands out the commands that
// install one.
//
// An install command carries a short-lived code, not the token: the code
// fetches a script with the token in it, once, within a quarter of an hour.

import { X509Certificate, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
}

export interface AgentRow {
  host: string
  /** Connected now; absent when it cannot be told. */
  connected?: boolean
  /** Made, not connected yet: the host's checks stay where they were. */
  waiting?: boolean
}

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

/** The command a host runs, as root or Administrator. */
export function installCommand(install: Pick<Install, 'os' | 'pin'>, url: string): string {
  const { os, pin } = install
  if (os === 'linux') {
    const tls = url.startsWith('https://') ? ` --proto '=https'${pin ? ` -k --pinnedpubkey 'sha256//${pin.key}'` : ''}` : ''
    return `curl -fsSL${tls} '${url}' | sudo sh`
  }
  // Windows PowerShell 5.1 may offer only TLS 1.0 unless told.
  const tls12 = "[Net.ServicePointManager]::SecurityProtocol='Tls12';"
  if (!pin) return `${url.startsWith('https://') ? tls12 : ''}irm '${url}' | iex`
  return (
    tls12 +
    `[Net.ServicePointManager]::ServerCertificateValidationCallback={param($s,$c)-join([Security.Cryptography.SHA256]::Create().ComputeHash($c.GetRawCertData())|%{$_.ToString('X2')}) -eq '${pin.cert}'};` +
    `irm '${url}' | iex`
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

  constructor(backend: Backend, settings: AgentSettings, reload: () => Promise<void>) {
    this.backend = backend
    this.settings = settings
    this.reload = reload
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

  async list(): Promise<AgentRow[]> {
    const pools = await this.pools()
    const known = this.hosts()
    const waiting = this.files('.new').filter((h) => !known.includes(h))
    const rows = [...known.map((host) => ({ host })), ...waiting.map((host) => ({ host, waiting: true }))]
    rows.sort((a, b) => a.host.localeCompare(b.host))
    return rows.map((row) => (pools ? { ...row, connected: (pools.get(`host_${row.host}`) ?? 0) + (pools.get(`waiting_${row.host}`) ?? 0) > 0 } : row))
  }

  /** Workers per pool, from checkd's `/metrics`. */
  private async pools(): Promise<Map<string, number> | undefined> {
    if (!this.settings.metrics) return undefined
    try {
      const answer = await fetch(`${this.settings.metrics.replace(/\/+$/, '')}/metrics`, { signal: AbortSignal.timeout(3000) })
      if (!answer.ok) return undefined
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
    if (waiting.length === 0) return
    const pools = await this.pools()
    let joined = false
    for (const host of waiting) {
      const file = join(this.settings.dir, `${host}.new`)
      if ((pools?.get(`waiting_${host}`) ?? 0) > 0) {
        renameSync(file, join(this.settings.dir, `${host}.token`))
        joined = true
      } else if (now - statSync(file).mtimeMs > WAIT_FOR) {
        unlinkSync(file)
      }
    }
    if (joined) await this.reload()
  }

  async remove(host: string): Promise<boolean> {
    if (!agentName(host)) return false
    let found = false
    let inUse = false
    for (const suffix of ['.new', '.token']) {
      const file = join(this.settings.dir, `${host}${suffix}`)
      if (!existsSync(file)) continue
      unlinkSync(file)
      found = true
      inUse ||= suffix === '.token'
    }
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

interface ScriptFacts {
  install: Install
  settings: AgentSettings
  ca: string
  sums: Map<string, string>
}

/** The engine as this host reaches it. */
const engineOf = (install: Install, settings: AgentSettings) =>
  settings.engine.startsWith(':') ? `${install.address.includes(':') ? `[${install.address}]` : install.address}${settings.engine}` : settings.engine

const sh = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
// PowerShell ends a quoted string at any of these quotes, not only '.
const ps = (text: string) => `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'`
const engineHost = (engine: string) => engine.replace(/^\[([^\]]+)\](:\d+)?$/, '$1').replace(/:\d+$/, '')

/** The install script for Linux: run as root, `curl ... | sudo sh`. */
export function linuxScript({ install, settings, ca, sums }: ScriptFacts): string {
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
    ...(install.plugins ? ['--restrict-path', '/usr/lib/nagios/plugins', '--restrict-path', '/usr/lib64/nagios/plugins', '--restrict-path', '/usr/local/lib/checkd-agent'] : []),
  ]
  return `#!/bin/sh
# checkd-agent for ${install.host}, from nuthatch.
# All in one function, called on the last line: a download cut short runs nothing.
set -eu
main() {
[ "$(id -u)" = 0 ] || { echo "Run this as root: curl ... | sudo sh" >&2; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) file=${x86}; url=${sh(arch(x86))}; sum=${sh(sums.get(x86) ?? '')} ;;
  aarch64|arm64) file=${arm}; url=${sh(arch(arm))}; sum=${sh(sums.get(arm) ?? '')} ;;
  *) echo "No checkd-agent for $(uname -m)" >&2; exit 1 ;;
esac
[ -n "$sum" ] || { echo "nuthatch has no $file" >&2; exit 1; }

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
umask 077
mkdir -p /etc/checkd-agent
fetch "$url" /usr/local/bin/checkd-agent.new
echo "$sum  /usr/local/bin/checkd-agent.new" | sha256sum -c - >/dev/null || { echo "The download does not match its checksum" >&2; rm -f /usr/local/bin/checkd-agent.new; exit 1; }
chmod 755 /usr/local/bin/checkd-agent.new
mv /usr/local/bin/checkd-agent.new /usr/local/bin/checkd-agent
id checkd-agent >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin checkd-agent 2>/dev/null || adduser -S -H -s /sbin/nologin checkd-agent
printf '%s\\n' ${sh(install.token)} > /etc/checkd-agent/token
cat > /etc/checkd-agent/ca.crt <<'CHECKD_AGENT_CA'
${ca.trim()}
CHECKD_AGENT_CA
chgrp checkd-agent /etc/checkd-agent/token
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
ExecStart=/usr/local/bin/checkd-agent ${args.map((a) => (/^[A-Za-z0-9_./:@=-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, '\\$1')}"`)).join(' ')}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
CHECKD_AGENT_UNIT
systemctl daemon-reload
systemctl enable checkd-agent >/dev/null 2>&1
systemctl restart checkd-agent
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

/** The install script for Windows: an Administrator PowerShell, `irm ... | iex`. */
export function windowsScript({ install, settings, ca, sums }: ScriptFacts): string {
  const { base, pin } = install
  const file = 'checkd-agent-windows-x86_64.exe'
  const args = [
    '--engine', engineOf(install, settings),
    '--name', install.host,
    '--token-file', '$data\\token',
    '--ca', '$data\\ca.crt',
    ...(settings.serverName ? ['--server-name', settings.serverName] : []),
    ...(install.plugins ? ['--restrict-path', '$dir\\plugins'] : []),
  ]
  // Inside a PowerShell string in double quotes: a quote is `".
  const argLine = args.map((a) => (/\s/.test(a) || a.startsWith('$') ? `\`"${a}\`"` : a)).join(' ')
  return `# checkd-agent for ${install.host}, from nuthatch.
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run this in PowerShell as Administrator' }
$sum = ${ps(sums.get(file) ?? '')}
if ($sum -eq '') { throw 'nuthatch has no ${file}' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dir = Join-Path $env:ProgramFiles 'checkd-agent'
$data = Join-Path $env:ProgramData 'checkd-agent'
New-Item -ItemType Directory -Force -Path $dir, (Join-Path $dir 'plugins') | Out-Null
# Made anew, so that nobody who made it first keeps a hold on it.
if (Test-Path $data) { Remove-Item -Recurse -Force $data }
New-Item -ItemType Directory -Path $data | Out-Null
icacls $data /setowner '*S-1-5-32-544' | Out-Null
icacls $data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)R' | Out-Null
$exe = Join-Path $dir 'checkd-agent.exe'
Get-ScheduledTask -TaskName 'checkd-agent' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
Invoke-WebRequest -UseBasicParsing -Uri ${ps(`${base}/agent/bin/${file}`)} -OutFile "$exe.new"
if ((Get-FileHash -Algorithm SHA256 "$exe.new").Hash.ToLower() -ne $sum) { Remove-Item "$exe.new"; throw 'The download does not match its checksum' }
Move-Item -Force "$exe.new" $exe
Set-Content -NoNewline -Encoding ascii -Path (Join-Path $data 'token') -Value ${ps(install.token)}
Set-Content -Encoding ascii -Path (Join-Path $data 'ca.crt') -Value @'
${ca.trim()}
'@
$action = New-ScheduledTaskAction -Execute $exe -Argument "${argLine}"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\\LOCALSERVICE' -LogonType ServiceAccount
Register-ScheduledTask -TaskName 'checkd-agent' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'checkd-agent'
${pin ? '[Net.ServicePointManager]::ServerCertificateValidationCallback = $null\n' : ''}Write-Host 'checkd-agent runs for ${install.host}'
`
}
