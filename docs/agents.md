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
   directory and gives a command:
   - Linux, as root:
     `curl -fsSL --proto '=https' 'https://…/agent/install/<code>' | sudo sh`
   - Windows, in Windows PowerShell as Administrator:
     `irm 'https://…/agent/install/<code>' | iex`

   On a LAN without a certificate authority the commands also check
   nuthatch's certificate by its pin (below).
3. Run it on the host. The code works once, within 15 minutes.

Until the new agent connects, the host shows **Waiting** and nothing
changes: its checks run where they ran, and an agent it had goes on. Once
the agent connects, its token becomes the host's, checkd reloads, and the
host's service checks go to it; an agent it had before is shut out. A
command never run is taken back after an hour.

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

**Remove** deletes the token, and reloads checkd if the agent was in use;
the agent is shut out and the host's checks go back to where they ran.
It stays installed on the host.

## Settings

    # The agent binaries: checkd's dist/agent (scripts/build-agents.sh).
    [agents]
    bin = "/opt/checkd/dist/agent"

    [[backend]]
    name = "site"
    livestatus = "unix:/run/checkd/live"
    push_url = "http://127.0.0.1:6559"   # needed: /metrics tells when an agent connects

    [backend.agents]
    dir = "/etc/checkd/workers/agents"   # checkd's agents= directory
    engine = "checkd.example.test:4730"  # its workers listener, as hosts reach it
    ca = "/etc/checkd/workers/ca.crt"
    server_name = "checkd"               # the name in the engine's certificate

nuthatch needs to write `dir`; token files are readable by their group,
so checkd runs as nuthatch's user or in its group. checkd runs with
`--workers`, and its workers file has `agents=` naming the same
directory.

## How hosts reach nuthatch and the engine

A host needs two things: the install script and binaries from nuthatch,
over `https`; and a TCP connection to the engine's workers port (4730
here) for as long as the agent runs. The engine's port is checked by
checkd's own CA, which the script brings, so it needs no public
certificate. Pick one setup:

| Setup | nuthatch for hosts | Engine port |
|---|---|---|
| VPN (Tailscale, WireGuard) | `url` = nuthatch's VPN address | the VPN address |
| LAN, no certificate authority | own listener, certificate pinned | a LAN address |
| Let's Encrypt, with a proxy | own listener on loopback, proxy in front | open or forwarded, or `wss://` through the proxy |
| Let's Encrypt, certificate files | own listener with the files | open or forwarded |
| Cloudflare Tunnel | own listener on loopback, tunnel in front | `wss://` through the tunnel |

nuthatch's own listener (`[agents] listen`) answers `/agent/install/`
and `/agent/bin/` only, never the interface.

**VPN.** nuthatch as a whole at an `https` address on the VPN, for
example `tailscale serve`:

    [agents]
    bin = "/opt/checkd/dist/agent"
    url = "https://nuthatch.tailnet-name.ts.net"

**LAN, no certificate authority.** Any certificate, checked in each
command by its pin: curl by `--pinnedpubkey`, Windows PowerShell 5.1 by
the certificate's SHA-256 (PowerShell 7 refuses it).

    [agents]
    listen = "0.0.0.0:10444"
    cert = "/etc/checkd/workers/engine.crt"
    key = "/etc/checkd/workers/engine.key"
    addresses = ["192.0.2.10", "198.51.100.10"]  # this machine, as hosts reach it

The page asks which address when there is more than one. With
`engine = ":4730"` the engine is at that same address.

**Let's Encrypt, with a proxy.** A plain listener on loopback, and a
proxy that gets the certificate, here Caddy:

    [agents]
    listen = "127.0.0.1:10445"
    url = "https://nuthatch.example.com"

    # Caddyfile
    nuthatch.example.com {
        reverse_proxy 127.0.0.1:10445
    }

**Let's Encrypt, certificate files.** The listener serves them itself and
takes up a renewed certificate within the hour. nuthatch's user must be
able to read the key (certbot keeps it for root; copy it in a deploy
hook).

    [agents]
    listen = "0.0.0.0:443"
    cert = "/etc/nuthatch/fullchain.pem"
    key = "/etc/nuthatch/privkey.pem"
    url = "https://nuthatch.example.com"

**Cloudflare Tunnel.** As with a proxy, a plain listener on loopback,
and for the engine its WebSocket listener (`websocket=127.0.0.1:4732` in
checkd's workers file), both behind the tunnel:

    [agents]
    listen = "127.0.0.1:10445"
    url = "https://nuthatch.example.com"

    [backend.agents]
    engine = "wss://checkd.example.com/workers"
    server_name = "checkd"

    # cloudflared config.yml
    ingress:
      - hostname: nuthatch.example.com
        service: http://127.0.0.1:10445
      - hostname: checkd.example.com
        service: http://127.0.0.1:4732
      - service: http_status:404

The engine's TLS runs inside the WebSocket, so Cloudflare sees neither
tokens nor checks. A `wss://` engine works behind any HTTPS proxy too.
NRPE is not offered with it: NRPE needs the engine to reach the host.

Without `listen`, install commands use `url`, or the address the page was
opened at, and need `https`; plain `http` only on this machine
(`127.0.0.1`, for trying it). A plain listener must be on loopback.

## What anyone can fetch

`/agent/install/<code>` and `/agent/bin/<file>` need no login: a host
running the command has none. A script holds the host's token and is
given once, for a code made by someone with `config_edit`; each fetch is
in the audit log; a `HEAD` request does not use the code up. The
binaries hold nothing secret.

An agent receives its host's checks with their arguments filled in, so
a password in a check reaches that host; see checkd's `docs/agent.md`.
