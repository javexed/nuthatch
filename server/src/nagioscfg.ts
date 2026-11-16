// Nagios object files, as far as nuthatch needs them: reading
// definitions out of a file, finding the files a main config names, and
// writing the hosts and services nuthatch keeps.
//
// The format is the one the Nagios documentation describes: `define
// <type> {`, a directive and its value to a line, `}`; `#` starts a
// comment line and `;` a comment anywhere.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface Definition {
  type: string
  /** Directives in the order written. */
  attrs: [string, string][]
}

/** The definitions of an object file's text. */
export function parseObjects(text: string): Definition[] {
  const out: Definition[] = []
  let open: Definition | null = null
  for (const raw of text.split(/\r?\n/)) {
    let line = raw
    const comment = line.indexOf(';')
    if (comment >= 0) line = line.slice(0, comment)
    line = line.trim()
    if (line === '' || line.startsWith('#')) continue
    if (open === null) {
      const start = /^define\s+(\w+)\s*\{?\s*$/.exec(line)
      if (start) open = { type: start[1] ?? '', attrs: [] }
      continue
    }
    if (line === '{') continue
    if (line.startsWith('}')) {
      out.push(open)
      open = null
      continue
    }
    const space = line.search(/\s/)
    open.attrs.push(space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space).trim()])
  }
  return out
}

export function attr(definition: Definition, key: string): string | undefined {
  return definition.attrs.find(([k]) => k === key)?.[1]
}

/** Maps a path as the engine knows it to where nuthatch finds it, and back. */
export class PathMap {
  private readonly pairs: [string, string][]

  /** `map`: engine path prefix → local path prefix. */
  constructor(map: Record<string, string> = {}) {
    // Without links, as the config admin's own paths are.
    const real = (path: string) => {
      try {
        return realpathSync(resolve(path))
      } catch {
        return resolve(path)
      }
    }
    this.pairs = Object.entries(map).map(([engine, local]) => [engine.replace(/\/+$/, ''), real(local)])
  }

  private move(path: string, from: 0 | 1): string {
    for (const pair of this.pairs) {
      const prefix = pair[from]
      if (path === prefix || path.startsWith(`${prefix}/`)) return pair[from === 0 ? 1 : 0] + path.slice(prefix.length)
    }
    return path
  }

  toLocal(enginePath: string): string {
    return this.move(enginePath, 0)
  }

  toEngine(localPath: string): string {
    return this.move(resolve(localPath), 1)
  }
}

export interface MainConfig {
  /** The lines, as they are. */
  lines: string[]
  /** The main config's directory, as the engine knows it. */
  engineDir: string
  /** The object files it names, as local paths. */
  files: string[]
  /** The `cfg_dir` values, as the engine knows them, absolute. */
  dirs: string[]
}

function cfgFiles(dir: string): string[] {
  const out: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return out
  }
  for (const name of names) {
    const path = join(dir, name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) out.push(...cfgFiles(path))
    else if (name.endsWith('.cfg')) out.push(path)
  }
  return out
}

/** Reads a main config: its lines and the object files it leads to. */
export function readMain(localPath: string, paths: PathMap): MainConfig {
  const lines = readFileSync(localPath, 'utf8').split(/\r?\n/)
  const engineDir = dirname(paths.toEngine(localPath))
  const files: string[] = []
  const dirs: string[] = []
  for (const line of lines) {
    const match = /^\s*(cfg_file|cfg_dir)\s*=\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    const enginePath = isAbsolute(match[2] ?? '') ? (match[2] ?? '') : join(engineDir, match[2] ?? '')
    if (match[1] === 'cfg_file') files.push(paths.toLocal(enginePath))
    else {
      dirs.push(enginePath)
      files.push(...cfgFiles(paths.toLocal(enginePath)))
    }
  }
  return { lines, engineDir, files, dirs }
}

/**
 * The main config's text with the object directory `from` read from `to`
 * instead, and every path in it absolute, so that the copy can lie
 * anywhere. Paths are the engine's.
 */
export function mainWith(main: MainConfig, from: string, to: string): string {
  const PATHS = /^(\s*)(cfg_file|cfg_dir|resource_file)(\s*=\s*)(.+?)\s*$/
  return main.lines
    .map((line) => {
      const match = PATHS.exec(line)
      if (!match) return line
      const path = isAbsolute(match[4] ?? '') ? (match[4] ?? '') : join(main.engineDir, match[4] ?? '')
      return `${match[1]}${match[2]}${match[3]}${match[2] === 'cfg_dir' && path.replace(/\/+$/, '') === from.replace(/\/+$/, '') ? to : path}`
    })
    .join('\n')
}

/** The names of the templates (`name`, with `register 0`) of a type, in the files. */
export function templates(files: string[], type: string): string[] {
  const names = new Set<string>()
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const definition of parseObjects(text)) {
      const name = attr(definition, 'name')
      if (definition.type === type && name !== undefined && attr(definition, 'register') === '0') names.add(name)
    }
  }
  return [...names].sort()
}

/** Writes definitions as an object file's text. */
export function writeObjects(definitions: Definition[], header: string): string {
  const out = header.split('\n').map((line) => `# ${line}`.trimEnd())
  for (const definition of definitions) {
    const width = Math.max(...definition.attrs.map(([key]) => key.length), 0)
    out.push(`define ${definition.type} {`)
    for (const [key, value] of definition.attrs) out.push(`    ${key.padEnd(width)}  ${value}`.trimEnd())
    out.push('}')
  }
  return `${out.join('\n')}\n`
}
