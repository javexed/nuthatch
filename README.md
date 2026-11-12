# nuthatch

A web interface for monitoring engines of the Nagios family: it shows the
state of hosts and services and lets people act on them. It talks
Livestatus, so it works with [Naemon](https://www.naemon.io/) and with
checkd, the engine it is written beside. It aims to do what Thruk does,
written anew.

**Status: phase 0 of the plan below.** There is a server that knows who is
logged in and what they may see and do, a typed client, and a first page
with totals. The views people work in come next.

## How it fits together

    browser ── HTTPS (your proxy) ── nuthatch ── Livestatus socket ── Naemon or checkd

- `server/`: the nuthatch server, in Rust. The browser talks only to it.
  It checks every request against the user's rights, asks the engines,
  and puts the answers of several engines together.
- `web/`: the interface, Vue 3 and TypeScript. `web/src/api` is the client
  of the server, free of Vue, for the phone app to use as it is.
- `dev/`: a demo site with invented hosts, run on either engine.
- `docs/`: [who may see and do what](docs/permissions.md).

## Try it

    dev/up naemon            # in one terminal: the demo site on Naemon, in a container
    dev/up checkd            # in another: the same on checkd (built from ../checkd)
    dev/users                # users admin, ops, viewer, nobody, stranger; password nuthatch-dev
    (cd web && pnpm install && pnpm build)
    (cd server && cargo build)
    server/target/debug/nuthatch dev/nuthatch.toml

Then open <http://127.0.0.1:8080>.

## The config file

    listen = "127.0.0.1:8080"
    web_root = "/usr/share/nuthatch/web"
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

- `htpasswd`: users and passwords, as `htpasswd -B` writes them (bcrypt);
  SHA-crypt and Apache's `$apr1$` are read too. A user is the contact of
  the same name.
- nuthatch speaks plain HTTP. It refuses to listen beyond the machine
  unless `behind_proxy = true` says a proxy in front does TLS; the
  session's cookie is then marked `Secure`.
- `store`: an SQLite file for sessions, API tokens, preferences and the
  audit log (logins, commands sent, commands refused). Nothing about what
  is monitored is kept there.
- `dev_user = "admin"` in place of `htpasswd`: nobody logs in and everyone
  is that user. For trying things on one machine; refused otherwise.
- `[roles]`: see [docs/permissions.md](docs/permissions.md).

## Tests

    (cd server && cargo test)
    (cd web && pnpm test)
    dev/matrix                 # every kind of user × every table and command, on both engines
    (cd web && pnpm build && pnpm e2e)    # in a browser, at desktop and phone width

The last two need `dev/up naemon` and `dev/up checkd` running.

## Plan

0. Foundations and permissions (here now)
1. Status views and actions
2. History and availability
3. Adding and changing hosts and services
4. Dashboards
5. One interface over several sites
6. Phone app

Each phase ends with a test that must pass on both engines.

## Licence

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT) at your option.

This is a clean-room project: nothing is taken from Thruk's source. See
[CONTRIBUTING.md](CONTRIBUTING.md) before changing anything.
