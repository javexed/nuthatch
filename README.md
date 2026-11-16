<img src="docs/logo.svg" alt="nuthatch logo" width="128" align="right">

# nuthatch

A web interface for monitoring engines of the Nagios family. It shows
the state of hosts and services, and lets people act on them: check now,
acknowledge, schedule a downtime, comment. It talks Livestatus, so it
works with [Naemon](https://www.naemon.io/) and with checkd, the engine
it is written beside. It covers the ground Thruk covers, written anew,
and is made to be used on a phone as much as at a desk.

## Status: young, and honest about it

- **One installation.** nuthatch runs one small site, its author's, and
  a demo site with invented hosts. It has not been run with many users
  or on a large site.
- **Tested on both engines.** Five kinds of user against the tables and
  a set of the commands, and the pages in a browser at desk and phone
  width, on Naemon Core 1.5.2 and on checkd (below). Those tests are run
  by hand; CI runs the types and the unit tests. Nagios Core itself has not been
  tried: it needs a Livestatus module of its own.
- **Much of the code was written by an AI model** (Claude), directed and
  reviewed by one person: see [CONTRIBUTING.md](CONTRIBUTING.md).
- **Version 0.1.0**, not packaged. The config file's keys
  may change before 1.0; the store is migrated from one version to the next.
- The phone app is built for Android and tried in an emulator and on one
  phone; there is no iOS build. Installed from the browser, as a PWA, it
  works on both.

## What it does

- **See:** an overview, the problems, hosts and services with filters,
  sorting and pages, groups, and a page for each host and service with
  its numbers drawn over time. A page shows a change when the engine has
  it, without being reloaded.
- **Act:** check now, acknowledge, schedule downtimes (for one, for
  several ticked in a list, or for everything that fits a pattern),
  comment, turn notifications and checks off and on.
- **Look back:** the history of alerts and notifications, and
  availability over a span of time, with a CSV file.
- **Change the config:** those with the role for it add, change and take
  out hosts and services, by looking at a host first and choosing among
  what answers there; the engine checks every change before it is
  written ([docs/config.md](docs/config.md)).
- **Each to their own:** people see and may act on what their contact
  sees, as in Thruk, with roles for more
  ([docs/permissions.md](docs/permissions.md)); dashboards of one's own
  or shared ([docs/dashboards.md](docs/dashboards.md)).
- **Several sites** in one interface, each through the nuthatch at its
  site ([docs/sites.md](docs/sites.md)).
- **On a phone:** installable from the browser, with notifications
  pushed to it ([docs/notifications.md](docs/notifications.md)).
- **Agents** (checkd): a host is added with checkd's agent, installed
  over SSH or by a one-line command, on Linux or Windows; the agent says
  what the machine runs, its disks and memory are watched at once, and its
  services are proposed ([docs/agents.md](docs/agents.md)).

With checkd as the engine there is more in the config form: services a
job elsewhere tells its result, services that stand for others, and
downtimes that come round. Naemon has none of those.

## What it is trusted with

nuthatch sends the engine external commands for the people logged in,
and for one role writes the engine's config, which is as much as running
programs as the engine's user. It keeps sessions, API tokens and an audit
log in a file of its own, and nothing about what is monitored. See
[SECURITY.md](SECURITY.md) for who may do what, what leaves the machine,
and how to report a problem.

## How it fits together

    browser ── HTTPS (your proxy) ── nuthatch ── Livestatus socket ── Naemon or checkd

Everything is TypeScript, in one pnpm workspace:

- `server/`: the nuthatch server, on Node 22.18 or later. The browser talks
  only to it. It checks every request against the user's rights, asks the
  engines, and puts the answers of several engines together.
- `packages/api/`: the shapes of requests and answers, and the client of
  the server. Free of any framework: the server, the web interface and
  the phone app share it.
- `web/`: the interface, Vue 3.
- `mobile/`: the interface wrapped as a phone app, with Capacitor.
- `dev/`: a demo site with invented hosts, run on either engine.
- `docs/`: [who may see and do what](docs/permissions.md),
  [history and availability](docs/history.md),
  [changing the config](docs/config.md),
  [dashboards](docs/dashboards.md),
  [several sites](docs/sites.md),
  [agents](docs/agents.md).

## Try it

Node 22.18 or later, pnpm, and Docker for the demo site on Naemon.

    dev/up naemon            # in one terminal: the demo site on Naemon, in a container
    dev/up checkd            # in another: the same on checkd, built from a clone of
                             # checkd's repository beside this one (../checkd, needs
                             # Rust), or CHECKD=/path/to/checkd
    dev/users                # users admin, ops, viewer, nobody, stranger; password nuthatch-dev
    pnpm install && pnpm build
    pnpm start dev/nuthatch.toml

Then open <http://127.0.0.1:8080>.

## Running it as a service

`contrib/systemd/nuthatch.service`: the repository at `/opt/nuthatch`
after `pnpm install && pnpm build`, Node 22.18 or later, a user `nuthatch`
that may read the engine's Livestatus socket, and the config at
`/etc/nuthatch/nuthatch.toml`. It passes `systemd-analyze verify`.
Beside an existing Naemon, step by step, with a proxy in front:
[docs/install.md](docs/install.md).

Without root, beside a checkd that runs as a user service:
`contrib/systemd/nuthatch-user.service` in `~/.config/systemd/user/`,
the repository in `~/nuthatch`, the config in
`~/.config/nuthatch/nuthatch.toml`, listening on `127.0.0.1` with
`behind_proxy = true`. To reach it over a tailnet with HTTPS:

    tailscale serve --bg --https=10443 http://127.0.0.1:7780

or, to sign in by Tailscale, on a socket (below).

## As it happens

A page shows a change of state when the engine has it: nuthatch asks the
engine to answer when something changes (Livestatus `WaitTrigger`), which
Naemon and checkd both do, and tells the open pages, which then ask for
what they show. After someone asked for a check, its result is shown the
same way even when it changes nothing. An engine that does not wait is
asked every two seconds, as is each one anyway, for what it does not
count as a change of state.

## On a phone

On a narrow screen the pages are in a bar at the bottom. On a touch
screen, a row swiped right is checked now, one swiped left is
acknowledged (when it is a problem nobody has taken), and a pull down
from the top of a page asks the server anew. A dot in the top bar says
the page is live; when the connection breaks it says since when what is
shown stands.

## Signed in by Tailscale

`tailscale serve` tells the service behind it who each request is from,
in the header `Tailscale-User-Login`, and drops such a header sent by a
client. With a `[tailscale]` table, a listed login gets a session
without a password, as if it had logged in; others see the login form.
What changes things still needs the session's CSRF value, so a page of
another site cannot act for you, although your tailnet identity comes
with every request your device sends. A token, as the phone app uses,
says who it is for, whatever the tailnet says.

Anything that can reach nuthatch's listen address directly could send
that header itself. So with `[tailscale]` nuthatch must listen on this
machine behind the proxy (`behind_proxy = true`), and best on a Unix
socket, which only its own user may open (it warns otherwise):

    listen = "unix:/run/user/1000/nuthatch/http.sock"

    [tailscale]
    users = { "ann@example.test" = "ann" }

and, as root (tailscale serves a socket only for root):

    tailscale serve --bg --https=10443 unix:/run/user/1000/nuthatch/http.sock

Funnel, which opens a service to the internet, sends no such header:
there everyone logs in with a password.

## As an app on a phone or desktop (PWA)

Served over HTTPS, nuthatch can be installed from the browser: Chrome's
"Install app" or "Add to home screen", Safari's "Add to Home Screen".
`web/public` holds the manifest, the icons and a service worker that
keeps only the interface's own files, never monitoring data. An
installed copy keeps itself up to date: each build writes
`version.json`, and a page that comes back from the background finds a
newer build and reloads (one in use says so instead, to lose nothing
half typed). There is nothing to reinstall. The icons,
here and in the Android app, are made from `docs/logo.svg` by
`mobile/make-icons`.

## The config file

    listen = "127.0.0.1:8080"
    web_root = "/opt/nuthatch/web/dist"
    store = "/var/lib/nuthatch/nuthatch.sqlite"
    htpasswd = "/etc/nuthatch/htpasswd"
    behind_proxy = true

    [roles]
    authorized_contactgroup_for_all_hosts = ["admins"]
    authorized_for_all_host_commands = ["ann"]
    authorized_for_system_information = ["ann"]

    [[backend]]
    name = "site"
    livestatus = "unix:/var/cache/naemon/live"

- A setting nuthatch does not know, anywhere in the file, stops it from
  starting, as does `true` or `false` in quotes: a typo is never read as
  a setting left out.
- `htpasswd`: users and passwords, as `htpasswd -B` writes them (bcrypt);
  SHA-crypt and Apache's `$apr1$` are read too. A user is the contact of
  the same name.
- nuthatch speaks plain HTTP. It refuses to listen beyond the machine
  unless `behind_proxy = true` says a proxy in front does TLS; the
  session's cookie is then marked `Secure`.
- `store`: an SQLite file for sessions, API tokens, preferences and the
  audit log (logins, commands sent, commands refused). Nothing about what
  is monitored is kept there. A newer nuthatch migrates an older file when
  it starts; an older one refuses a newer file, so back it up before an
  upgrade.
- `listen = "unix:/run/nuthatch/http.sock"`: a Unix socket in place of
  an address, made so that only nuthatch's own user may open it. For a
  proxy on the same machine.
- `[tailscale]`, `users = { "ann@example.test" = "ann" }`: behind
  `tailscale serve`, these tailnet logins are let in without a password,
  as the users named (see below).
- `dev_user = "admin"` in place of `htpasswd`: nobody logs in and everyone
  is that user. For trying things on one machine; refused otherwise.
- `[roles]`: see [docs/permissions.md](docs/permissions.md).
- `[backend.config]`: see [docs/config.md](docs/config.md).
- `[[peer]]`, and `nuthatch = "https://..."` under a backend: see
  [docs/sites.md](docs/sites.md).
- `app_origins`: see [mobile/README.md](mobile/README.md).
- `[graphs]`: a short history of the checks' numbers, see
  [docs/graphs.md](docs/graphs.md).
- `[notifications]`: on phones and desktops, see
  [docs/notifications.md](docs/notifications.md).
- `[agents]` and `[backend.agents]`: see [docs/agents.md](docs/agents.md).

## Dependencies

The server: Hono for HTTP, `bcryptjs` and `unixcrypt` for the password
forms of htpasswd, `smol-toml` for the config file, and Node's own SQLite.
Node runs the TypeScript as it is; nothing is compiled to install it.

## Tests

    pnpm build && pnpm test    # types, and the unit tests of every package
    (cd web && pnpm build:app) # the interface as the app, for the browser tests
    dev/matrix                 # every kind of user × every table and command, on both engines
    dev/matrix --federated     # the same through a central nuthatch over a nuthatch at each engine
    (cd web && pnpm e2e)       # in a browser, at desktop and phone width: what a
                               # user sees is compared with what the engines
                               # give that user, and every action is done on both

The last two need `dev/up naemon` and `dev/up checkd` running, and so
Docker and a clone of checkd beside this repository. CI runs the first
line only: the engines' tests need Docker to bind-mount the demo site
into Naemon's container, which a CI job inside a container cannot give
it, and running them on the runner's own machine would run every pushed
commit there.

## Licence

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT) at your option.

This is a clean-room project: nothing is taken from Thruk's source, which
is GPL. See [CONTRIBUTING.md](CONTRIBUTING.md) before changing anything.

Nagios is a trademark of Nagios Enterprises; Naemon and Thruk are their
projects' names. nuthatch is not affiliated with any of them.
