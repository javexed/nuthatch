// The key that signs the agent binaries nuthatch serves. An agent
// installed while there is one takes only binaries signed by it (checkd's
// update.rs, `--update-signer`): whoever can change the files in
// `[agents] bin` can no longer change the agents, only someone who may
// press Sign here.
//
// The key is made here (Ed25519, in a self-signed certificate) or a
// certificate and its key are uploaded. Agents check the key alone, not
// who issued the certificate or until when.

import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { binaries, binariesVersion } from './agents.ts'
import { Refused } from './policy.ts'
import type { Store } from './store.ts'

/** What is signed for a binary (checkd's update.rs checks the same). */
export function statement(file: string, sum: string, time: number): string {
  return `checkd-agent update\n${file}\n${sum}\n${time}\n`
}

/** The id agents know a key by: hex SHA-256 of its SubjectPublicKeyInfo. */
export function keyId(key: KeyObject): string {
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
}

/** The hash a key signs with; refused for keys agents cannot check. */
function hashOf(key: KeyObject): string | null {
  const details = key.asymmetricKeyDetails ?? {}
  switch (key.asymmetricKeyType) {
    case 'ed25519':
      return null
    case 'ec':
      if (details.namedCurve === 'prime256v1') return 'sha256'
      if (details.namedCurve === 'secp384r1') return 'sha384'
      throw new Refused('an ECDSA key on P-256 or P-384')
    case 'rsa':
      if ((details.modulusLength ?? 0) < 2048 || (details.modulusLength ?? 0) > 8192) throw new Refused('an RSA key of 2048 to 8192 bits')
      return 'sha256'
    default:
      throw new Refused('an Ed25519, ECDSA P-256 or P-384, or RSA key')
  }
}

/** Signs a binary's statement: the signature in hex. */
export function signBinary(keyPem: string, file: string, sum: string, time: number): string {
  const key = createPrivateKey(keyPem)
  return sign(hashOf(key), Buffer.from(statement(file, sum, time)), key).toString('hex')
}

// DER, as far as a self-signed certificate needs.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const n = body.length
  const length = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff])
  return Buffer.concat([Buffer.from([tag]), length, body])
}
const seq = (...parts: Buffer[]) => der(0x30, ...parts)
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'))
function time(at: Date): Buffer {
  const iso = at.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'
  return at.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(iso.slice(2))) : der(0x18, Buffer.from(iso))
}

const ED25519 = '2b6570'

/** A new Ed25519 key in a self-signed certificate, PEM. */
export function selfSigned(name: string, now = new Date()): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const serial = randomBytes(16)
  serial[0] = (serial[0] ?? 0) & 0x7f
  const subject = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from(name)))))
  const until = new Date(now)
  until.setUTCFullYear(until.getUTCFullYear() + 30)
  const extensions = der(
    0xa3,
    seq(
      // Not a CA; for signatures only.
      seq(oid('551d13'), der(0x01, Buffer.from([0xff])), der(0x04, seq())),
      seq(oid('551d0f'), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([0x07, 0x80])))),
    ),
  )
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    seq(oid(ED25519)),
    subject,
    seq(time(now), time(until)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  )
  const signature = sign(null, tbs, privateKey)
  const cert = seq(tbs, seq(oid(ED25519)), der(0x03, Buffer.from([0]), signature))
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n?$/, '\n')}-----END CERTIFICATE-----\n`
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

/** The first certificate of a PEM text. */
function firstCert(text: string): string {
  const found = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text)
  if (!found) throw new Refused('a certificate in PEM (-----BEGIN CERTIFICATE-----)')
  return `${found[0]}\n`
}

/** An uploaded certificate and its key, checked: agents can verify what
 * the key signs, and the key is the certificate's. */
export function uploaded(certText: string, keyText: string): { cert: string; key: string } {
  const cert = firstCert(certText)
  let x509: X509Certificate
  try {
    x509 = new X509Certificate(cert)
  } catch {
    throw new Refused('the certificate cannot be read')
  }
  if (/-----BEGIN (ENCRYPTED PRIVATE KEY|[A-Z ]+-----\s*Proc-Type: 4,ENCRYPTED)/.test(keyText)) throw new Refused('the key has a passphrase; upload it without')
  let key: KeyObject
  try {
    key = createPrivateKey(keyText)
  } catch {
    throw new Refused('the private key cannot be read (PEM)')
  }
  hashOf(key)
  if (keyId(createPublicKey(key)) !== keyId(x509.publicKey)) throw new Refused('the key is not the certificate’s')
  return { cert, key: key.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

/** The key as the Config page shows it. */
export interface SignerInfo {
  subject: string
  algorithm: string
  /** Hex SHA-256 of the public key, as agents know it. */
  id: string
  /** The certificate's dates (ms); agents do not check them. */
  until: number
  self_signed: boolean
}

export function describe(certPem: string): SignerInfo {
  const x509 = new X509Certificate(certPem)
  const key = x509.publicKey
  const details = key.asymmetricKeyDetails ?? {}
  const algorithm =
    key.asymmetricKeyType === 'ec'
      ? `ECDSA ${details.namedCurve === 'secp384r1' ? 'P-384' : 'P-256'}`
      : key.asymmetricKeyType === 'rsa'
        ? `RSA ${details.modulusLength ?? ''}`.trim()
        : 'Ed25519'
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(x509.subject)?.[1] ?? x509.subject.replace(/\n/g, ', ')
  return { subject: cn, algorithm, id: keyId(key), until: Date.parse(x509.validTo), self_signed: x509.subject === x509.issuer && x509.verify(key) }
}

/** The signatures of the binaries, as signed together at one time. */
export interface Signed {
  /** Seconds since 1970; each signing later than the one before. */
  at: number
  version?: string
  files: Record<string, { sum: string; signature: string }>
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const KEY = 'agent-signing'
const SIGNED = 'agent-signatures'

/** The key and the signatures, kept in the store. */
export class AgentSigning {
  private readonly store: Store
  constructor(store: Store) {
    this.store = store
  }

  private read<T>(key: string): T | undefined {
    const text = this.store.pref('', key)
    if (!text) return undefined
    try {
      return JSON.parse(text) as T
    } catch {
      return undefined
    }
  }

  key(): { cert: string; key: string } | undefined {
    const found = this.read<{ cert?: unknown; key?: unknown }>(KEY)
    return typeof found?.cert === 'string' && typeof found.key === 'string' ? { cert: found.cert, key: found.key } : undefined
  }

  /** The id of the key, as agents send it. */
  id(): string | undefined {
    const held = this.key()
    return held ? describe(held.cert).id : undefined
  }

  /** A new key, made or uploaded: signatures by the one before are gone,
   * and binaries are to be signed again. */
  setKey(held: { cert: string; key: string } | null): void {
    if (held) this.store.setPref('', KEY, JSON.stringify(held))
    else this.store.setPref('', KEY, '')
    const before = this.signed()
    // Kept: the time, so that the next signing is later still.
    this.store.setPref('', SIGNED, before ? JSON.stringify({ at: before.at, files: {} }) : '')
  }

  signed(): Signed | undefined {
    const found = this.read<Signed>(SIGNED)
    return found && typeof found.at === 'number' && found.files && typeof found.files === 'object' ? found : undefined
  }

  /** Signs every binary in `dir`, each by its SHA-256 as read now, which
   * must be the one SHA256SUMS gives. */
  async sign(dir: string, now = Date.now()): Promise<Signed> {
    const held = this.key()
    if (!held) throw new Refused('no signing key')
    const sums = binaries(dir)
    if (sums.size === 0) throw new Refused(`no agent binaries in ${dir}`)
    const before = this.signed()
    const at = Math.max(Math.floor(now / 1000), (before?.at ?? 0) + 1)
    const files: Signed['files'] = {}
    for (const [file, sum] of sums) {
      if ((await sha256(join(dir, file))) !== sum) throw new Refused(`${file} does not match SHA256SUMS`)
      files[file] = { sum, signature: signBinary(held.key, file, sum, at) }
    }
    const version = binariesVersion(dir)
    const signed: Signed = { at, ...(version ? { version } : {}), files }
    this.store.setPref('', SIGNED, JSON.stringify(signed))
    return signed
  }

  /** A binary's signature, when it is signed as SHA256SUMS has it now. */
  signatureOf(file: string, sum: string): { time: number; signature: string } | undefined {
    const signed = this.signed()
    const found = signed?.files[file]
    return signed && found && found.sum === sum ? { time: signed.at, signature: found.signature } : undefined
  }

  /** The binaries served as signed: those whose SHA-256 is signed. */
  signedSums(dir: string): Map<string, { sum: string; time: number; signature: string }> {
    const out = new Map<string, { sum: string; time: number; signature: string }>()
    for (const [file, sum] of binaries(dir)) {
      const found = this.signatureOf(file, sum)
      if (found) out.set(file, { sum, ...found })
    }
    return out
  }

  /** For the Config page. */
  state(dir: string): { signer?: SignerInfo; signed?: { at: number; version?: string }; current: boolean; unsigned: string[] } {
    const held = this.key()
    if (!held) return { current: false, unsigned: [] }
    const signed = this.signed()
    const unsigned = [...binaries(dir)].filter(([file, sum]) => !this.signatureOf(file, sum)).map(([file]) => file)
    return {
      signer: describe(held.cert),
      ...(signed && Object.keys(signed.files).length > 0 ? { signed: { at: signed.at * 1000, ...(signed.version ? { version: signed.version } : {}) } } : {}),
      current: unsigned.length === 0 && binaries(dir).size > 0,
      unsigned,
    }
  }
}
