import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'nuthatch-config-'))
writeFileSync(join(dir, 'peer.key'), 'k'.repeat(40))

/** What nuthatch says of a config file it refuses: its first line. */
function refused(body: string): string {
  const file = join(dir, 'nuthatch.toml')
  writeFileSync(file, `listen = "127.0.0.1:0"\ndev_user = "admin"\nstore = "${join(dir, 'store.sqlite')}"\n${body}`)
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, 'main.ts'), file], { encoding: 'utf8', timeout: 15000 })
  expect(run.status, run.stderr).toBe(2)
  return run.stderr.trim().split('\n').at(-1) ?? ''
}

const backend = '[[backend]]\nname = "site"\nlivestatus = "unix:/nowhere/live"\n'

describe('a mistyped config file', () => {
  it('is refused, not read as if the setting were not there', () => {
    expect(refused(`${backend}[[peer]]\nname = "central"\nkey_file = "${join(dir, 'peer.key')}"\nreadonly = true\n`)).toMatch(/\[\[peer\]\] has no setting 'readonly'.*read_only/)
    expect(refused(`${backend}[[peer]]\nname = "central"\nkey_file = "${join(dir, 'peer.key')}"\nread_only = "true"\n`)).toMatch(/read_only is true or false, without quotes/)
    expect(refused('[[backend]]\nname = "site"\nlivestatus = "unix:/nowhere/live"\nhttp_ur = "http://127.0.0.1:6559"\n')).toMatch(/has no setting 'http_ur'/)
    expect(refused(`${backend}[backend.config]\ndir = "/x"\nmain = "/x/naemon.cfg"\nverify = ["naemon", "-v", "{main}"]\nrelaod = ["true"]\n`)).toMatch(/config has no setting 'relaod'/)
    expect(refused(`${backend}[backend.agents]\ndir = "/x"\nca = "/x/ca.crt"\nengine = ":4730"\nservername = "x"\n`)).toMatch(/agents has no setting 'servername'/)
    expect(refused('[[backend]]\nname = "far"\nnuthatch = "https://far.example.test"\nkey_file = "/x"\nlivestatus = "unix:/x"\n')).toMatch(/backend far has no setting 'livestatus'/)
    expect(refused(`behind_proxy = "yes"\n${backend}`)).toMatch(/behind_proxy is true or false/)
    expect(refused(`${backend}[graphs]\nday = 3\n`)).toMatch(/\[graphs\] has no setting 'day'/)
    expect(refused(`${backend}[agents]\nbin = "/x"\nupdate = "auto"\n`)).toMatch(/update = "auto" waits for signed agent binaries/)
  })
})
