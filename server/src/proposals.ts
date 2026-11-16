// Checks proposed from what a host's agent says its machine is and runs
// (its inventory): a base every such host gets at once (its disks, memory,
// load or processor), and the services it runs, to take up or set aside.
//
// An inventory is the agent's word, and whoever holds the host's token
// could write anything in it. So nothing in it becomes a command: every
// check is one of nuthatch's own commands (catalogue.ts), and what the
// inventory gives (a mount point, a service's name) is used only when it
// is plainly one, as an argument.

import type { Inventory, ManagedService, Proposal } from '@nuthatch/api'

export interface Planned extends Proposal {
  check_command: string
  /** In the base set, added when the inventory first comes. */
  base: boolean
}

/** At most this many disks in the base set. */
const DISKS = 8
/** Smaller filesystems are not worth a check of their own. */
const SMALLEST = 64 * 1024 * 1024

/** What a service's description may be, as the config takes it. */
const DESCRIPTION = /^[A-Za-z0-9][A-Za-z0-9 _.:/+-]{0,62}$/
/** A mount point or drive that can go into a command as it is. */
const PATH = /^(\/[A-Za-z0-9._\/-]{0,120}|[A-Za-z]:\\?)$/
/** A service's name that can go into a command as it is. */
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,120}$/

/** Services worth watching where they run, by their unit's or Windows name. */
const KNOWN: [RegExp, string, boolean][] = [
  // Linux: systemd units, without `.service`.
  [/^nginx$/, 'nginx', true],
  [/^(apache2|httpd)$/, 'Apache', true],
  [/^caddy$/, 'Caddy', true],
  [/^haproxy$/, 'HAProxy', true],
  [/^traefik$/, 'Traefik', true],
  [/^postgresql(@[\w.-]+)?$/, 'PostgreSQL', true],
  [/^(mysql|mysqld|mariadb)$/, 'MySQL', true],
  [/^(redis|redis-server)(@[\w.-]+)?$/, 'Redis', true],
  [/^(mongod|mongodb)$/, 'MongoDB', true],
  [/^elasticsearch$/, 'Elasticsearch', true],
  [/^docker$/, 'Docker', true],
  [/^containerd$/, 'containerd', false],
  [/^podman$/, 'Podman', true],
  [/^k3s$/, 'k3s', true],
  [/^kubelet$/, 'kubelet', true],
  [/^(named|bind9)$/, 'DNS server', true],
  [/^unbound$/, 'Unbound', true],
  [/^pihole-FTL$/, 'Pi-hole', true],
  [/^(postfix|exim4|opensmtpd)$/, 'Mail server', true],
  [/^dovecot$/, 'Dovecot', true],
  [/^php[\d.]*-fpm$/, 'PHP-FPM', true],
  [/^(smbd|samba)$/, 'Samba', true],
  [/^nfs-server$/, 'NFS server', true],
  [/^(grafana-server|grafana)$/, 'Grafana', true],
  [/^prometheus$/, 'Prometheus', true],
  [/^(jellyfin|plexmediaserver)$/, 'Media server', true],
  [/^home-assistant(@[\w.-]+)?$/, 'Home Assistant', true],
  [/^fail2ban$/, 'fail2ban', false],
  [/^(ssh|sshd)$/, 'SSH server', false],
  [/^(cron|crond|cronie)$/, 'cron', false],
  [/^tailscaled$/, 'Tailscale', false],
  [/^(chronyd|chrony|ntpd|systemd-timesyncd)$/, 'Time sync', false],
  // Windows services.
  [/^W3SVC$/, 'IIS', true],
  [/^MSSQLSERVER$/, 'SQL Server', true],
  [/^SQLSERVERAGENT$/, 'SQL Server Agent', false],
  [/^NTDS$/, 'Active Directory', true],
  [/^DNS$/, 'DNS server', true],
  [/^DHCPServer$/, 'DHCP server', true],
  [/^MSExchangeIS$/, 'Exchange', true],
  [/^(vmms)$/, 'Hyper-V', true],
  [/^WinRM$/, 'WinRM', false],
  [/^TermService$/, 'Remote Desktop', false],
  [/^Spooler$/, 'Print spooler', false],
  [/^(sshd)$/, 'SSH server', false],
]

/** Services every machine of a kind runs, not worth a check: left out of "more". */
const PLUMBING = /^(systemd-|dbus|user@|getty@|serial-getty@|polkit|udisks|upower|accounts-daemon|rtkit|wpa_supplicant|NetworkManager|ModemManager|avahi|bluetooth|cups|snapd|packagekit|rsyslog|irqbalance|thermald|multipathd|lvm2|iscsid|networkd-dispatcher|unattended-upgrades|getty|console-|plymouth|power-profiles|switcheroo|colord|gdm|sddm|lightdm|kerneloops|whoopsie|apport|qemu-guest-agent|open-vm-tools|vgauth|haveged|atd|uuidd)/

/** Thresholds for the load average, by processor count. */
function loadLimits(cpus: number): [string, string] {
  const n = Math.max(1, Math.min(512, Math.floor(cpus) || 1))
  const at = (a: number, b: number, c: number) => [a * n, b * n, c * n].map((v) => String(Math.round(v * 10) / 10)).join(',')
  // Per processor; a machine busy most of the time is not a problem.
  return [at(3, 2.5, 2), at(6, 5, 4)]
}

/** Everything the inventory leads to, base and the rest. */
export function plan(inventory: Inventory): Planned[] {
  const out: Planned[] = []
  const windows = inventory.os?.family === 'windows'
  const add = (p: Planned) => {
    if (DESCRIPTION.test(p.description) && !out.some((o) => o.key === p.key || o.description === p.description)) out.push(p)
  }
  const gib = (n: number) => `${Math.round((n / 1024 ** 3) * 10) / 10} GiB`

  const disks = (Array.isArray(inventory.disks) ? inventory.disks : [])
    .filter((d) => typeof d?.path === 'string' && PATH.test(d.path) && Number(d.size) >= SMALLEST)
    .slice(0, DISKS)
  for (const d of disks) {
    const path = windows ? d.path.replace(/\\$/, '').toUpperCase() : d.path
    add({ key: `disk:${path}`, description: `Disk ${path}`, check_command: `nuthatch_disk!${path}!85!95`, why: `${String(d.fs ?? '').slice(0, 12)} ${gib(Number(d.size))}, ${Math.round(Number(d.used_pct) || 0)}% used`, checked: true, base: true })
  }
  if (Number(inventory.memory) > 0) add({ key: 'memory', description: 'Memory', check_command: 'nuthatch_memory!90!95', why: gib(Number(inventory.memory)), checked: true, base: true })
  const cpus = Number(inventory.cpus) || 1
  if (windows) {
    add({ key: 'cpu', description: 'CPU', check_command: 'nuthatch_cpu!90!98', why: `${cpus} processors`, checked: true, base: true })
  } else {
    const [w, c] = loadLimits(cpus)
    add({ key: 'load', description: 'Load', check_command: `nuthatch_load!${w}!${c}`, why: `${cpus} processors`, checked: true, base: true })
    add({ key: 'cpu', description: 'CPU', check_command: 'nuthatch_cpu!90!98', why: `${cpus} processors`, checked: false, base: false })
  }

  const services = (Array.isArray(inventory.services) ? inventory.services : []).filter((s) => typeof s?.name === 'string')
  const known: Planned[] = []
  const more: Planned[] = []
  for (const s of services) {
    const unit = windows ? s.name : s.name.replace(/\.service$/, '')
    if (!SERVICE.test(unit)) continue
    const what = String(s.description ?? '').replace(/[\x00-\x1f]/g, '').slice(0, 80)
    const match = KNOWN.find(([pattern]) => pattern.test(unit))
    if (match) {
      const instance = unit.includes('@') ? ` ${unit.split('@')[1]}` : ''
      known.push({ key: `service:${unit}`, description: `${match[1]}${instance}`.replace(/[^A-Za-z0-9 _.:/+-]/g, '-'), check_command: `nuthatch_service!${unit}`, why: what || unit, checked: match[2], base: false })
    } else if (!windows && !PLUMBING.test(unit)) {
      more.push({ key: `service:${unit}`, description: `Service ${unit}`.replace(/[^A-Za-z0-9 _.:/+-]/g, '-').slice(0, 63), check_command: `nuthatch_service!${unit}`, why: what || unit, checked: false, base: false })
    }
  }
  for (const p of known) add(p)
  for (const p of more.slice(0, 40)) add(p)
  return out
}

/** What is left to propose: not on the host already, and not set aside. */
export function open(planned: Planned[], services: ManagedService[], dismissed: string[]): Planned[] {
  const commands = new Set(services.map((s) => s.check_command))
  const names = new Set(services.map((s) => s.description))
  return planned.filter((p) => !commands.has(p.check_command) && !names.has(p.description) && !dismissed.includes(p.key))
}

/** Reads an inventory as the agent sent it, or nothing when it is not one. */
export function readInventory(text: string): Inventory | undefined {
  if (text.length > 1 << 20) return undefined
  try {
    const value = JSON.parse(text) as Partial<Inventory> & { version?: number }
    if (typeof value !== 'object' || value === null || typeof value.os !== 'object' || value.os === null) return undefined
    const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, '').slice(0, n) : '')
    const os = value.os as unknown as Record<string, unknown>
    const list = <T>(v: unknown, n: number) => (Array.isArray(v) ? (v.slice(0, n) as T[]) : [])
    return {
      os: { family: str(os.family, 20), name: str(os.name), id: str(os.id, 40), version: str(os.version, 40), kernel: str(os.kernel, 80), arch: str(os.arch, 20) },
      hostname: str(value.hostname, 100),
      cpus: Number(value.cpus) || 0,
      memory: Number(value.memory) || 0,
      disks: list<Record<string, unknown>>(value.disks, 64).map((d) => ({ path: str(d?.path, 200), fs: str(d?.fs, 20), size: Number(d?.size) || 0, used_pct: Number(d?.used_pct) || 0 })),
      services: list<Record<string, unknown>>(value.services, 1000).map((s) => ({ name: str(s?.name, 200), description: str(s?.description, 200) })),
      ports: list<Record<string, unknown>>(value.ports, 1000).map((p) => ({ port: Number(p?.port) || 0, address: str(p?.address, 60) })),
    }
  } catch {
    return undefined
  }
}
