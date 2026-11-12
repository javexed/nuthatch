// Who is asking: passwords from an htpasswd file, as Thruk sites usually
// have one, and a limit on failed logins.
//
// Hashes read: bcrypt (`htpasswd -B`), SHA-crypt (`$5$`, `$6$`) and
// Apache's MD5 form (`$apr1$`, htpasswd's default). Plain crypt(3) and
// `{SHA}` lines are not: such a user cannot log in, and is named in a
// warning at start.

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import bcrypt from 'bcryptjs'
import * as unixcrypt from 'unixcrypt'

function readable(hash: string): boolean {
  return ['$2a$', '$2b$', '$2y$', '$5$', '$6$', '$apr1$'].some((prefix) => hash.startsWith(prefix))
}

function read(path: string): { users: Map<string, string>; warnings: string[] } {
  const users = new Map<string, string>()
  const warnings: string[] = []
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    const at = line.indexOf(':')
    if (line === '' || line.startsWith('#') || at < 0) continue
    const user = line.slice(0, at)
    const hash = line.slice(at + 1)
    if (!readable(hash)) {
      warnings.push(`${path}: the password of '${user}' is in a form nuthatch does not read; set it again with htpasswd -B`)
    }
    users.set(user, hash)
  }
  return { users, warnings }
}

const md5 = (...parts: Buffer[]): Buffer => {
  const h = createHash('md5')
  for (const part of parts) h.update(part)
  return h.digest()
}

/**
 * Apache's MD5 password hash, `$apr1$<salt>$<hash>`: the MD5-crypt scheme
 * with its own marker, as its documentation describes it.
 */
export function apr1(password: string, saltText: string): string {
  const pw = Buffer.from(password, 'utf8')
  const salt = Buffer.from(saltText, 'utf8').subarray(0, 8)
  const alternate = md5(pw, salt, pw)
  const parts: Buffer[] = [pw, Buffer.from('$apr1$'), salt]
  for (let left = pw.length; left > 0; left -= 16) parts.push(alternate.subarray(0, Math.min(left, 16)))
  for (let bits = pw.length; bits !== 0; bits >>= 1) parts.push(bits & 1 ? Buffer.from([0]) : pw.subarray(0, 1))
  let last = md5(...parts)
  for (let round = 0; round < 1000; round++) {
    const mix: Buffer[] = [round & 1 ? pw : last]
    if (round % 3 !== 0) mix.push(salt)
    if (round % 7 !== 0) mix.push(pw)
    mix.push(round & 1 ? last : pw)
    last = md5(...mix)
  }
  const alphabet = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let out = ''
  const put = (value: number, count: number) => {
    for (let i = 0; i < count; i++) {
      out += alphabet[value & 0x3f]
      value >>>= 6
    }
  }
  const f = (i: number) => last[i] ?? 0
  put((f(0) << 16) | (f(6) << 8) | f(12), 4)
  put((f(1) << 16) | (f(7) << 8) | f(13), 4)
  put((f(2) << 16) | (f(8) << 8) | f(14), 4)
  put((f(3) << 16) | (f(9) << 8) | f(15), 4)
  put((f(4) << 16) | (f(10) << 8) | f(5), 4)
  put(f(11), 2)
  return out
}

/** Compares without telling how much matched. */
function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function verify(password: string, hash: string): Promise<boolean> {
  if (hash.startsWith('$apr1$')) {
    const [salt, wanted] = hash.slice(6).split('$')
    return salt !== undefined && wanted !== undefined && same(apr1(password, salt), wanted)
  }
  if (hash.startsWith('$2')) return bcrypt.compare(password, hash)
  if (hash.startsWith('$5$') || hash.startsWith('$6$')) {
    try {
      return unixcrypt.verify(password, hash)
    } catch {
      return false
    }
  }
  return false
}

/**
 * A hash nobody's password gives, checked for a user that does not exist,
 * so that an unknown name takes as long as a wrong password.
 */
const NOBODY = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8rQyqHq6Tz9lFz8rXkQGZsVv9ZQ7mG'

export class Htpasswd {
  private users: Map<string, string>
  private readAt: number
  readonly warnings: string[]
  private readonly path: string

  constructor(path: string) {
    this.path = path
    const { users, warnings } = read(path)
    this.users = users
    this.warnings = warnings
    this.readAt = statSync(path).mtimeMs
  }

  /** Whether the password is the user's. */
  async check(user: string, password: string): Promise<boolean> {
    // The file is read again when it changed.
    try {
      const modified = statSync(this.path).mtimeMs
      if (modified !== this.readAt) {
        this.users = read(this.path).users
        this.readAt = modified
      }
    } catch {
      // Gone for a moment while it is rewritten: the last reading stands.
    }
    const hash = this.users.get(user)
    if (hash === undefined) {
      await verify(password, NOBODY)
      return false
    }
    return verify(password, hash)
  }
}

const WINDOW = 300_000
const ALLOWED = 5

/**
 * Failed logins, per user name and per address: five in five minutes,
 * then that name or address waits.
 */
export class Limiter {
  private readonly failures = new Map<string, number[]>()
  private readonly clock: () => number

  constructor(clock: () => number = Date.now) {
    this.clock = clock
  }

  blocked(keys: string[]): boolean {
    const since = this.clock() - WINDOW
    for (const [key, times] of this.failures) {
      const recent = times.filter((t) => t > since)
      if (recent.length === 0) this.failures.delete(key)
      else this.failures.set(key, recent)
    }
    return keys.some((key) => (this.failures.get(key)?.length ?? 0) >= ALLOWED)
  }

  failed(keys: string[]): void {
    for (const key of keys) this.failures.set(key, [...(this.failures.get(key) ?? []), this.clock()])
  }

  succeeded(userKey: string): void {
    this.failures.delete(userKey)
  }
}
