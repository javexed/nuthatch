# Agents

With checkd as the engine, nuthatch installs `checkd-agent` on a
monitored Linux or Windows host. The agent connects out to the engine over
TLS and runs that host's checks there; see checkd's `docs/agent.md`. For
the role `config_edit`.

NRPE goes on working beside it. On Linux nuthatch can install NRPE as
well, for `check_nrpe` from the engine.

## Adding a host with an agent

**Config → Add a host**: type its name or address and **Scan**. nuthatch
guesses its system from what answered (what its SSH server says of
itself, Windows' own ports, a ping's TTL); change it if wrong. With
**Install agent** ticked, adding the host goes on to installing its agent,
**over SSH** by default (below), or by a **command** to run there.

Once connected, the agent says what its machine is: system, processors,
memory, disks, the services running and the ports listened on (its
inventory). From that:

- **At once**, the base checks are added: each disk, memory, and the load
  (Linux) or processor (Windows). They are checkd's own checks, made by
  the agent, with no plugin on the host.
- **Proposed**, to tick and **Add**: the services it runs that are worth
  watching (a web server, a database, Docker, …), the processor on Linux,
  and other services. **Dismiss all** sets them aside.

The agent says again once a day; a service that appears later is
proposed then, on the host's page and in Config. The inventory is kept in
nuthatch's store. It is the agent's word: nothing in it is run, and only
nuthatch's own commands are added, with a mount point or a service name as
their argument when it is plainly one.

Checks are added only to hosts nuthatch keeps the config of. For a host
defined elsewhere, its page shows the agent and its inventory.

A look from outside (a port, a web page, a certificate) stays with the
engine on a host with an agent (`_CHECKD_RUN_ON engine`); a check of the
machine itself only ever runs on its agent (`_CHECKD_RUN_ON agent`), and
is UNKNOWN while the host has none.

## An existing host

Its page has **Agent → Install agent**, as does its card in Config. The
options:

- **Plugins** also installs the monitoring plugins package (Linux), for
  checks that need them. Without it the agent runs checkd's own checks and
  programs under `/usr/local/lib/checkd-agent` (Windows: its `plugins`
  directory) only.
- **NRPE** (Linux) also installs NRPE, open to the engine.

**Command instead** writes a new token for the host into checkd's agents
directory and gives a command:

- Linux, as root:
  `curl -fsSL --proto '=https' 'https://…/agent/install/<code>' | sudo sh`
- Windows, in Windows PowerShell as Administrator:
  `irm 'https://…/agent/install/<code>' | iex`

On a LAN without a certificate authority the commands also check
nuthatch's certificate by its pin (below). The code works once, within 15
minutes.

Until the new agent connects, the host shows **Waiting for the agent**
and nothing changes: its checks run where they ran, and an agent it had
goes on. Once the agent connects, its token becomes the host's, checkd
reloads, and the host's checks go to it; an agent it had before is shut
out. A command never run is taken back after an hour.

### Over SSH

**Over SSH** (the default) has nuthatch log in to the host and run the command itself.
Give the SSH address (the host's address to start with), port and user,
and a password or a private key (with its passphrase, if it has one);
The key the host's SSH server offers is shown as the panel opens (or
with **Look up host key** for another address), and **Install** goes
ahead only with that key. The output follows on the page.

- On Linux the user is root, or one sudo lets run commands; sudo is given
  the password (or, with a key, the sudo password). On Windows the user is
  an administrator and the SSH server is Windows' OpenSSH; Windows
  PowerShell runs the command.
- The login is sent once, for that run, and kept nowhere: not in the
  store, the audit log, a file or the browser. ssh gets a password through
  `SSH_ASKPASS` from its own environment, and a key through an ssh-agent
  of that run alone, given the key on a pipe; the agent ends with the run.
  The page empties the fields when it sends them.
- nuthatch uses the OpenSSH client of its machine (`ssh`, `ssh-keyscan`,
  `ssh-agent`, `ssh-add`), never its own keys or agent, nor its user's
  `~/.ssh/config`.
- The host must still reach nuthatch and the engine, as with a command.
- After a wrong login, OpenSSH servers may refuse the address for a while
  (`PerSourcePenalties`); the page says so.
- The audit log has who installed which host, as which SSH user, and
  whether it worked.

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

## Updates

The host's page shows the version of its agent, and when that is older
than the agents nuthatch serves (the `VERSION` file that checkd's
`scripts/build-agents.sh` writes beside them), **Update to …**.

On Linux the agent replaces itself. Every five minutes it asks nuthatch,
with its token, whether it is to be replaced. nuthatch says yes when the
binary it serves differs from the one the host has, and either **Update**
was pressed for that host (kept until done, across a restart of nuthatch,
as `<host>.update` beside the host's token). Updates without asking
(`[agents] update = "auto"`) wait for signed binaries ([TODO.md](../TODO.md));
nuthatch refuses that setting until then.

Then the agent fetches the binary from nuthatch, by the same pin as the
installer, checks it against the checksum nuthatch gave, runs it once
(`--version`), puts it in place of its own and ends, and systemd starts
the new one. So an update takes up to five minutes after **Update** is
pressed. The audit log has who asked and when each host fetched it.

- No root after the install: the binary is in `/var/lib/checkd-agent/bin`,
  which belongs to the agent's user `checkd-agent`. The other side of
  that: whoever takes over that user can change the agent, and so keep
  their hold across restarts; still only as that user.
- Whoever can change the binaries in `[agents] bin` on this machine can
  change each agent the next time **Update** is pressed for it. The
  binaries are checked against `SHA256SUMS` beside them, which is no
  defence against that. Signed binaries are not done yet.
- A new agent that runs `--version` but then fails is not put back: the
  host shows its agent not connected, and installing again mends it.
- An agent installed before updates came does not ask: use **Install
  again** on its host's page once, over SSH or by the command. The agent
  it has goes on until the new one connects.
- Windows: agents do not update themselves yet; install again.

## When an agent does not connect

Almost always, the host cannot reach this machine: a firewall here or on
the host, or an address of this machine the host has no way to.

- **Over SSH**, nuthatch first checks from the host that it reaches this
  machine at nuthatch's agent port and the engine's, at each address
  under `[agents] addresses` (the one on the host's own network first),
  and gives the agent the first that works. When none does, it installs
  nothing and says which ports were not reached.
- **With the command**, the host's page says each step as it comes:
  waiting for the host to fetch the installer, then for its agent to
  connect. A step not taken within a minute says what to check. The
  command itself gives up within seconds when it cannot reach nuthatch.
- **This machine's firewall**: when ufw is on and does not let the
  agent ports in from the networks of `[agents] addresses`, nuthatch
  says so when it starts, and the install panel shows the `ufw allow`
  commands to run here. (It reads ufw's files; it changes nothing.)
  Other firewalls are not read.

## Settings

    # The agent binaries: checkd's dist/agent (scripts/build-agents.sh), or
    # checkd-agents-<version>.tar.gz of a checkd release, unpacked.
    [agents]
    bin = "/opt/checkd/dist/agent"

    [[backend]]
    name = "site"
    livestatus = "unix:/run/checkd/live"
    http_url = "http://127.0.0.1:6559"   # needed: /metrics tells when an agent connects
    http_token_file = "/etc/checkd/http.env"  # when checkd has CHECKD_HTTP_TOKEN

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

nuthatch's own listener (`[agents] listen`) answers `/agent/install/`,
`/agent/bin/` and `/agent/update/` only, never the interface.

**VPN.** nuthatch as a whole at an `https` address on the VPN, for
example `tailscale serve`:

    [agents]
    bin = "/opt/checkd/dist/agent"
    url = "https://nuthatch.tailnet-name.ts.net"

**LAN, no certificate authority.** Any certificate, checked in each
command by its pin: curl by `--pinnedpubkey`, Windows PowerShell 5.1 by
the certificate's SHA-256 (PowerShell 7 refuses it).

    [agents]
    listen = "0.0.0.0:4731"
    cert = "/etc/checkd/workers/engine.crt"
    key = "/etc/checkd/workers/engine.key"
    addresses = ["192.0.2.10", "198.51.100.10"]  # this machine, as hosts reach it

The page asks which address when there is more than one. With
`engine = ":4730"` the engine is at that same address.

**The agent ports: 4730 and 4731.** 4730 is the engine's workers
listener (the port Gearman has, as mod_gearman uses it); 4731 is
nuthatch's, for the installer. Side by side, one firewall rule lets both
in, from the network the hosts are on:

    sudo ufw allow from 192.0.2.0/24 to any port 4730:4731 proto tcp

Hosts connect out to them; nothing on a host needs to be opened, unlike
NRPE (5666), which the engine connects in to.

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
