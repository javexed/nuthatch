// Web Push, for notifications on a phone or desktop where nuthatch is
// installed: a message encrypted for one browser (RFC 8291, aes128gcm)
// and handed to that browser's push service, signed as this server's
// (VAPID, RFC 8292). The push service sees where a message goes and how
// big it is, never what it says.

import { createCipheriv, createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto'

const b64url = (data: Buffer | Uint8Array) => Buffer.from(data).toString('base64url')

export interface Subscription {
  endpoint: string
  /** The browser's public key, base64url. */
  p256dh: string
  /** The browser's secret for this subscription, base64url. */
  auth: string
}

export interface ServerKeys {
  /** The private key, as PKCS#8 PEM. */
  privatePem: string
  /** The public key as browsers take it: the uncompressed point, base64url. */
  publicKey: string
}

export function newServerKeys(): ServerKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x ?? '', 'base64url'), Buffer.from(jwk.y ?? '', 'base64url')])
  return { privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: b64url(point) }
}

/** The push services browsers use. A subscription elsewhere is not sent to. */
const SERVICES = [/^fcm\.googleapis\.com$/, /\.push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/]

/** A subscription as a browser gives it, checked; or the reason it is not one. */
export function checkSubscription(given: unknown): Subscription {
  const g = (typeof given === 'object' && given !== null ? given : {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  if (typeof g.endpoint !== 'string' || g.endpoint.length > 2000) throw new Error('a subscription has an endpoint')
  let url: URL
  try {
    url = new URL(g.endpoint)
  } catch {
    throw new Error("the subscription's endpoint is not a URL")
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || !SERVICES.some((s) => s.test(url.hostname))) {
    throw new Error(`${url.hostname} is not a push service nuthatch sends to`)
  }
  const p256dh = typeof g.keys?.p256dh === 'string' ? g.keys.p256dh : ''
  const auth = typeof g.keys?.auth === 'string' ? g.keys.auth : ''
  if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) throw new Error("the subscription's keys are not a browser's")
  return { endpoint: g.endpoint, p256dh, auth }
}

/** The body of a push message: `text` encrypted for the subscription. */
export function encrypt(subscription: Subscription, text: string, salt = randomBytes(16), ephemeral?: ReturnType<typeof createECDH>): Buffer {
  const theirs = Buffer.from(subscription.p256dh, 'base64url')
  // A key pair for this message alone, unless one is given (a test).
  const mine = ephemeral ?? createECDH('prime256v1')
  if (!ephemeral) mine.generateKeys()
  const ours = mine.getPublicKey()
  const shared = mine.computeSecret(theirs)
  const ikm = Buffer.from(hkdfSync('sha256', shared, Buffer.from(subscription.auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), theirs, ours]), 32))
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const cipher = createCipheriv('aes-128-gcm', key, nonce)
  // One record, the last: the text and the mark that ends it.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header.writeUInt8(ours.length, 20)
  return Buffer.concat([header, ours, sealed])
}

/** The Authorization header that says a message is this server's. */
export function vapid(endpoint: string, keys: ServerKeys, subject: string, now = Date.now()): string {
  const part = (value: unknown) => b64url(Buffer.from(JSON.stringify(value)))
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`
  const signature = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey(keys.privatePem), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`
}

/** For tests: the public key of server keys, as a key object. */
export function publicKeyOf(keys: ServerKeys) {
  return createPublicKey(createPrivateKey(keys.privatePem))
}

export type Sent = 'sent' | 'gone' | 'failed'

/**
 * Sends one message. `gone`: the browser has ended the subscription, and
 * it should be forgotten.
 */
export async function send(subscription: Subscription, text: string, keys: ServerKeys, subject: string, urgent: boolean, fetcher: typeof fetch = fetch): Promise<Sent> {
  try {
    const response = await fetcher(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapid(subscription.endpoint, keys, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        // Kept a day for a device that is off.
        TTL: '86400',
        Urgency: urgent ? 'high' : 'normal',
      },
      body: new Uint8Array(encrypt(subscription, text)),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404 || response.status === 410) return 'gone'
    return response.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}
