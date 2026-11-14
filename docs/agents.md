# Agents

With checkd as the engine, the Agents page installs `checkd-agent` on a
monitored Linux or Windows host. The agent connects out to the engine over
TLS and runs that host's service checks there; see checkd's
`docs/agent.md`. The page is for the role `config_edit`.

NRPE goes on working beside it. On Linux the page can install NRPE as
well, for `check_nrpe` from the engine.

## Installing

1. Choose the host and its system. **Plugins only** limits the agent to
   programs in the plugin directories, and on Linux installs the
   monitoring plugins package. **NRPE** (Linux) also installs NRPE, open
   to the engine.
2. **Make command** writes a new token for the host into checkd's agents
   directory, reloads checkd, and gives a command:
   - Linux, as root:
     `curl -fsSL --proto '=https' 'https://…/agent/install/<code>' | sudo sh`
   - Windows, in Windows PowerShell as Administrator:
     `irm 'https://…/agent/install/<code>' | iex`

   With nuthatch's own listener for hosts (below), the commands also
   check its certificate: curl by `--pinnedpubkey`, PowerShell by the
   certificate's SHA-256. Windows PowerShell 5.1 does this; PowerShell 7
   refuses the certificate.
3. Run it on the host. The code works once, within 15 minutes. Making a
   new command for a host shuts out the agent it had.

On Linux the script downloads the agent for the machine (x86_64 or
aarch64), checks it against `SHA256SUMS`, puts the token and the engine's
CA in `/etc/checkd-agent`, makes the user `checkd-agent`, and starts the
systemd service `checkd-agent`. It knows apt, dnf, yum, zypper and apk for
the plugins and NRPE.

On Windows it puts the agent in `C:\Program Files\checkd-agent`, the
token and CA in `C:\ProgramData\checkd-agent` (made anew, owned by
Administrators, readable by LOCAL SERVICE), and registers the scheduled
task `checkd-agent`, run at startup as LOCAL SERVICE. Not yet tried on a
Windows machine.

**Remove** deletes the token and reloads checkd; the agent is shut out.
It stays installed on the host.

## Settings

    # The agent binaries: checkd's dist/agent (scripts/build-agents.sh).
    [agents]
    bin = "/opt/checkd/dist/agent"
    # This nuthatch as the hosts reach it; else the address of the request.
    url = "https://nuthatch.example.test"

    [[backend]]
    name = "site"
    livestatus = "unix:/run/checkd/live"
    push_url = "http://127.0.0.1:6559"   # for "Connected", from /metrics

    [backend.agents]
    dir = "/etc/checkd/workers/agents"   # checkd's agents= directory
    engine = "checkd.example.test:4730"  # its workers listener, as hosts reach it
    ca = "/etc/checkd/workers/ca.crt"
    # server_name = "engine"             # the name in the engine's certificate

Or, instead of `url`, a listener of nuthatch's own for hosts, with no
proxy or public certificate:

    [agents]
    bin = "/opt/checkd/dist/agent"
    listen = "0.0.0.0:10444"
    cert = "/etc/checkd/workers/engine.crt"   # any certificate; checked by its pin
    key = "/etc/checkd/workers/engine.key"
    addresses = ["192.0.2.10", "198.51.100.10"]  # this machine, as hosts reach it

It answers `/agent/install/` and `/agent/bin/` only. The page asks which
address a host should use when there is more than one. With
`engine = ":4730"` the engine is at that same address; give
`server_name` the name in the engine's certificate.

nuthatch needs to write `dir`; token files are readable by their group,
so checkd runs as nuthatch's user or in its group. checkd runs with
`--workers`, and its workers file has `agents=` naming the same
directory.

Install commands need nuthatch at an `https` address (`url`, or the
address the page was opened at); plain `http` only on this machine
(`127.0.0.1`, for trying it).

## What anyone can fetch

`/agent/install/<code>` and `/agent/bin/<file>` need no login: a host
running the command has none. A script holds the host's token and is
given once, for a code made by someone with `config_edit`; each fetch is
in the audit log; a `HEAD` request does not use the code up. The
binaries hold nothing secret.

An agent receives its host's checks with their arguments filled in, so
a password in a check reaches that host; see checkd's `docs/agent.md`.
