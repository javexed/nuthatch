// Whether a monitored host can reach this machine, for an agent: which of
// nuthatch's addresses is on the host's own network, whether this
// machine's firewall lets the agent ports in, and a check run on the host
// itself (over SSH) before an agent is installed there.

import { lookup } from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'

const toNumber = (ip: string) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0

/** Whether an IPv4 address is in a network written `a.b.c.d/n`. */
export function inside(ip: string, cidr: string): boolean {
  const [net = '', bits = '32'] = cidr.split('/')
  if (!isIPv4(ip) || !isIPv4(net)) return false
  const n = Number(bits)
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0
  return (toNumber(ip) & mask) === (toNumber(net) & mask)
}

/** The network each of this machine's addresses is on, as `a.b.c.0/n`. */
export function networksOf(addresses: string[], interfaces = networkInterfaces()): Map<string, string> {
  const out = new Map<string, string>()
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || !addresses.includes(i.address) || !i.cidr) continue
      const bits = Number(i.cidr.split('/')[1])
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      const n = toNumber(i.address) & mask
      out.set(i.address, `${[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')}/${bits}`)
    }
  }
  return out
}

/** nuthatch's addresses, the one on the same network as the host first. */
export function bySubnet(addresses: string[], hostIps: string[], networks: Map<string, string>): string[] {
  const near = (a: string) => hostIps.some((ip) => inside(ip, networks.get(a) ?? '255.255.255.255/32'))
  return [...addresses.filter(near), ...addresses.filter((a) => !near(a))]
}

/** The same, the host's address looked up. */
export async function nearestFirst(addresses: string[], hostAddress: string | undefined): Promise<string[]> {
  if (!hostAddress || addresses.length < 2) return addresses
  let ips: string[] = []
  try {
    ips = isIPv4(hostAddress) ? [hostAddress] : (await lookup(hostAddress, { all: true, family: 4 })).map((a) => a.address)
  } catch {
    return addresses
  }
  return bySubnet(addresses, ips, networksOf(addresses))
}

export interface FirewallGap {
  port: number
  /** The network that cannot come in; empty for any. */
  from: string
  command: string
}

/**
 * What ufw on this machine keeps out of the agent ports: for each port
 * and each network nuthatch's addresses are on, unless a rule lets it in.
 * Read from ufw's files, which need no root to read; nothing is changed.
 */
export function ufwGaps(ports: number[], networks: string[], etc = '/etc'): FirewallGap[] {
  let conf: string
  try {
    conf = readFileSync(`${etc}/ufw/ufw.conf`, 'utf8')
  } catch {
    return []
  }
  if (!/^\s*ENABLED\s*=\s*yes\s*$/m.test(conf)) return []
  try {
    if (/^\s*DEFAULT_INPUT_POLICY\s*=\s*"?ACCEPT"?\s*$/m.test(readFileSync(`${etc}/default/ufw`, 'utf8'))) return []
  } catch {
    // ufw's default: drop.
  }
  let rules = ''
  try {
    rules = readFileSync(`${etc}/ufw/user.rules`, 'utf8')
  } catch {
    // No rules of the user's: nothing is let in.
  }
  const allowed: { ports: (p: number) => boolean; from: string }[] = []
  for (const line of rules.split('\n')) {
    if (!line.startsWith('-A ufw-user-input') || !/-j ACCEPT\b/.test(line) || /-p udp\b/.test(line)) continue
    const one = /--dport (\d+)(?::(\d+))?/.exec(line)
    const many = /--dports ([\d,:]+)/.exec(line)
    const from = /-s (\S+)/.exec(line)?.[1] ?? ''
    if (one) {
      const low = Number(one[1])
      const high = Number(one[2] ?? one[1])
      allowed.push({ ports: (p) => p >= low && p <= high, from })
    } else if (many) {
      const parts = (many[1] ?? '').split(',').map((r) => r.split(':').map(Number))
      allowed.push({ ports: (p) => parts.some(([a = 0, b]) => p >= a && p <= (b ?? a)), from })
    } else if (!/--dport/.test(line) && from) {
      // All ports from a network.
      allowed.push({ ports: () => true, from })
    }
  }
  const covers = (from: string, network: string) => from === '' || from === '0.0.0.0/0' || inside(network.split('/')[0] ?? '', from.includes('/') ? from : `${from}/32`) && Number(network.split('/')[1]) >= Number(from.split('/')[1] ?? 32)
  const gaps: FirewallGap[] = []
  for (const network of networks.length ? networks : ['']) {
    const missing = ports.filter((port) => !allowed.some((a) => a.ports(port) && (network === '' ? a.from === '' : covers(a.from, network))))
    if (missing.length === 0) continue
    // Ports next to each other (4730 and 4731) are let in by one rule.
    const sorted = [...missing].sort((a, b) => a - b)
    const together = sorted.length > 1 && sorted.every((p, i) => i === 0 || p === (sorted[i - 1] ?? 0) + 1)
    const ranges = together ? [`${sorted[0]}:${sorted[sorted.length - 1]}`] : sorted.map(String)
    for (const port of missing) {
      const range = together ? ranges[0]! : String(port)
      gaps.push({ port, from: network, command: network ? `sudo ufw allow from ${network} to any port ${range} proto tcp` : `sudo ufw allow ${range}/tcp` })
    }
  }
  return gaps
}

const shq = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
const psq = (text: string) => `'${text.replace(/'/g, "''")}'`

/**
 * A command that, run on the host, says for each address whether it
 * reaches every port there: lines `reach <address>` or `miss <address>
 * <port>...`. Needs no root and changes nothing.
 */
export function probeCommand(os: 'linux' | 'windows', addresses: string[], ports: number[]): string {
  if (os === 'linux') {
    const script = [
      'p() {',
      '  if command -v nc >/dev/null 2>&1; then nc -z -w 5 "$1" "$2" >/dev/null 2>&1',
      '  elif command -v bash >/dev/null 2>&1; then timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1',
      '  else curl -s -o /dev/null --connect-timeout 5 "http://$1:$2/"; r=$?; [ $r -ne 7 ] && [ $r -ne 28 ]; fi',
      '}',
      `for a in ${addresses.map(shq).join(' ')}; do`,
      '  miss=""',
      `  for port in ${ports.join(' ')}; do p "$a" "$port" || miss="$miss $port"; done`,
      '  if [ -z "$miss" ]; then echo "reach $a"; else echo "miss $a$miss"; fi',
      'done',
    ].join('\n')
    return `sh -c ${shq(script)}`
  }
  const script = [
    'function P($h,$p){$c=New-Object Net.Sockets.TcpClient;try{$c.ConnectAsync($h,$p).Wait(5000) -and $c.Connected}catch{$false}finally{$c.Close()}}',
    `foreach($a in @(${addresses.map(psq).join(',')})){$m=@(${ports.join(',')}|?{-not (P $a $_)});if($m.Count -eq 0){"reach $a"}else{"miss $a $($m -join ' ')"}}`,
  ].join('\n')
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

/** What the probe said: the addresses reached, and the ports each other one missed. */
export function readProbe(output: string): { reached: string[]; missed: Map<string, number[]> } {
  const reached: string[] = []
  const missed = new Map<string, number[]>()
  for (const line of output.split(/\r?\n/)) {
    const words = line.trim().split(/\s+/)
    if (words[0] === 'reach' && words[1]) reached.push(words[1])
    else if (words[0] === 'miss' && words[1]) missed.set(words[1], words.slice(2).map(Number).filter(Number.isInteger))
  }
  return { reached, missed }
}
