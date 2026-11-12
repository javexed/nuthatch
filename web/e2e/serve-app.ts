// Serves the app build (web/dist-app) from an origin of its own, as a
// phone's shell does: for the tests of the app against a server elsewhere.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../dist-app')
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

createServer((request, response) => {
  const path = normalize(join(root, decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/')))
  const file = path.startsWith(root) && extname(path) !== '' ? path : join(root, 'index.html')
  readFile(file).then(
    (data) => response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(data),
    () => response.writeHead(404).end('not found'),
  )
}).listen(8097, '127.0.0.1')
