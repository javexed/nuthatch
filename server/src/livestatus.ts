// A Livestatus client: one request per connection, over a Unix socket,
// with the answer in JSON behind a fixed16 response header.

import { connect } from 'node:net'

const LIMIT = 15_000
/** Answers larger than this are refused, so that one query cannot take
 * the server's memory. */
const MAX_ANSWER = 64 << 20

/** Where an engine answers: `unix:<socket>`. */
export function socketPath(address: string): string {
  if (address.startsWith('unix:')) return address.slice(5)
  if (address.startsWith('/')) return address
  throw new Error(`'${address}': give unix:<socket>`)
}

function exchange(path: string, text: string, wantAnswer: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const socket = connect({ path })
    const timer = setTimeout(() => socket.destroy(new Error('no answer within 15 seconds')), LIMIT)
    socket.on('connect', () => {
      // Half-closed: the engine answers and closes.
      socket.end(text)
      if (!wantAnswer) resolve(Buffer.alloc(0))
    })
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_ANSWER + 16) socket.destroy(new Error('the answer is too large'))
      else chunks.push(chunk)
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${path}: ${err.message}`))
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
  })
}

/**
 * Sends one request (without the empty line that ends it) and gives the
 * answer's rows.
 */
export async function query(path: string, request: string): Promise<unknown[][]> {
  const full = `${request.trimEnd()}\nOutputFormat: json\nResponseHeader: fixed16\nKeepAlive: off\n\n`
  const answer = await exchange(path, full, true)
  const head = answer.subarray(0, 16).toString('latin1')
  const code = Number(head.slice(0, 3))
  const length = Number(head.slice(4, 15).trim())
  if (answer.length < 16 || !Number.isInteger(code) || !Number.isInteger(length)) {
    throw new Error(`not a Livestatus answer: ${JSON.stringify(head)}`)
  }
  const body = answer.subarray(16, 16 + length).toString('utf8')
  if (code !== 200) throw new Error(`${code}: ${body.trim()}`)
  let rows: unknown
  try {
    rows = JSON.parse(body)
  } catch {
    throw new Error('the answer is not JSON')
  }
  if (!Array.isArray(rows)) throw new Error('the answer is not a list')
  return rows.filter((row): row is unknown[] => Array.isArray(row))
}

/** Sends an external command. Livestatus gives no answer to one. */
export async function command(path: string, line: string): Promise<void> {
  await exchange(path, `COMMAND ${line}\n\n`, false)
}
