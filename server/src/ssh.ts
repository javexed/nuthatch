// Running one command on a host over SSH, with a login given for that run
// alone: a password, or a private key (with its passphrase, if it has one).
// Nothing of it is written anywhere: a password reaches ssh through
// SSH_ASKPASS from the environment of ssh's own process; a key is loaded
// into an ssh-agent of this run, from a pipe, and the agent ends with it.
//
// The host's key is checked against the fingerprint the user was shown
// (`hostKeys`), so a login goes only to the machine they saw.

import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface SshLogin {
  address: string
  port: number
  user: string
  password?: string
  key?: string
  passphrase?: string
}

export interface HostKey {
  type: string
  /** `SHA256:...`, as ssh shows it. */
  fingerprint: string
  /** The key as known_hosts holds it, without the host. */
  line: string
}

/** A name or address ssh can be given, and nothing an option could hide in. */
export function sshAddress(text: unknown): text is string {
  return typeof text === 'string' && text.length <= 253 && /^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(text)
}

export function sshUser(text: unknown): text is string {
  return typeof text === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._@\\-]{0,63}$/.test(text)
}

/** A private directory for this run's files: where sockets fit (a Unix
 * socket's path is short) and only this user can look. */
function workDir(): string {
  const base = process.env.XDG_RUNTIME_DIR ?? tmpdir()
  const dir = mkdtempSync(join(base, 'nh-ssh-'))
  chmodSync(dir, 0o700)
  return dir
}

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { env: options.env ?? { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const take = (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-65536)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 15_000)
    child.on('error', (err) => take(Buffer.from(String(err.message))))
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code ?? 1, out })
    })
    child.stdin.end(options.input ?? '')
  })
}

/** The keys a host's SSH server offers, to be shown before a login goes to it. */
export async function hostKeys(address: string, port: number): Promise<HostKey[]> {
  if (!sshAddress(address) || !Number.isInteger(port) || port < 1 || port > 65535) return []
  const scan = await run('ssh-keyscan', ['-T', '5', '-p', String(port), '--', address], { timeout: 10_000 })
  const keys: HostKey[] = []
  for (const row of scan.out.split('\n')) {
    const m = /^\S+ ((?:ssh|ecdsa|sk)-\S+) ([A-Za-z0-9+/=]+)$/.exec(row.trim())
    if (!m?.[1] || !m[2]) continue
    const line = `${m[1]} ${m[2]}`
    const print = await run('ssh-keygen', ['-l', '-E', 'sha256', '-f', '-'], { input: `x ${line}\n` })
    const fingerprint = /\b(SHA256:[A-Za-z0-9+/]+)/.exec(print.out)?.[1]
    if (fingerprint) keys.push({ type: m[1], fingerprint, line })
  }
  return keys
}

/** Takes the secrets out of what a run printed, should any come back. */
function scrub(text: string, secrets: (string | undefined)[]): string {
  let out = text
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('***')
  return out
}

/**
 * Runs `command` on the host as `login.user`, its standard input `input`,
 * once the host's key is one of `keys`. Its output, at most the last 64 KB,
 * comes to `seen` as it arrives. The answer is ssh's exit code: the
 * command's, or 255 when ssh itself failed.
 */
export async function runOver(
  login: SshLogin,
  keys: HostKey[],
  command: string,
  input: string,
  seen: (text: string) => void,
  timeout = 20 * 60_000,
): Promise<number> {
  if (!sshAddress(login.address) || !sshUser(login.user)) throw new Error('not an address or user ssh can be given')
  if (keys.length === 0) throw new Error("the host's key is not known")
  if (!login.password && !login.key) throw new Error('a password or a key is needed')
  const secrets = [login.password, login.passphrase, login.key]
  const dir = workDir()
  let agent: ReturnType<typeof spawn> | undefined
  try {
    // The host as the user saw it, under a name of its own.
    writeFileSync(join(dir, 'known_hosts'), keys.map((k) => `target ${k.line}\n`).join(''), { mode: 0o600 })
    const askpass = join(dir, 'askpass')
    writeFileSync(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$NUTHATCH_ASKPASS"\n', { mode: 0o700 })
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force' }
    const options = [
      '-F', '/dev/null',
      '-T',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`,
      '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'HostKeyAlias=target',
      '-o', 'UpdateHostKeys=no',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15',
      '-o', 'NumberOfPasswordPrompts=1',
      // This machine's own keys and agent are never offered.
      '-o', 'IdentityFile=none',
    ]
    if (login.key) {
      const socket = join(dir, 'agent')
      agent = spawn('ssh-agent', ['-D', '-a', socket], { stdio: 'ignore', env: { PATH: env.PATH } })
      for (let i = 0; i < 50 && !(await exists(socket)); i++) await new Promise((r) => setTimeout(r, 50))
      const added = await run('ssh-add', ['-q', '-'], {
        env: { ...env, SSH_AUTH_SOCK: socket, NUTHATCH_ASKPASS: login.passphrase ?? '' },
        input: login.key.replace(/\r\n/g, '\n').trimEnd() + '\n',
      })
      if (added.code !== 0) throw new Error(`the key was not taken: ${scrub(added.out, secrets).trim() || 'wrong passphrase, or not a private key'}`)
      env.SSH_AUTH_SOCK = socket
      options.push('-o', `IdentityAgent=${socket}`, '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no')
    } else {
      env.NUTHATCH_ASKPASS = login.password
      options.push('-o', 'IdentityAgent=none', '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive')
    }
    return await new Promise<number>((done) => {
      const child = spawn('ssh', [...options, '-p', String(login.port), '-l', login.user, '--', login.address, command], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      const take = (chunk: Buffer) => seen(scrub(chunk.toString(), secrets))
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
      child.on('error', (err) => seen(err.message))
      child.on('close', (code) => {
        clearTimeout(timer)
        done(code ?? 255)
      })
      child.stdin.end(input)
    })
  } finally {
    agent?.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    const { lstat } = await import('node:fs/promises')
    return (await lstat(path)).isSocket()
  } catch {
    return false
  }
}
