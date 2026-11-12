# nuthatch

A web interface for monitoring engines of the Nagios family: it shows the
state of hosts and services and lets people act on them. It talks
Livestatus, so it works with [Naemon](https://www.naemon.io/) and with
checkd, the engine it is written beside. It aims to do what Thruk does,
written anew.

**Status: phase 1 of the plan below is done.** People can log in and see
what is theirs to see: an overview, problems, hosts and services with
filters, sorting and pages, host and service groups, and a page for each
host and service. From there they can check now, acknowledge, schedule
downtimes, comment, and turn notifications and checks off and on, for one
object or for several ticked in a list. History, reports, changing the
config and dashboards are not there yet.

## How it fits together

    browser ── HTTPS (your proxy) ── nuthatch ── Livestatus socket ── Naemon or checkd

Everything is TypeScript, in one pnpm workspace:

- `server/`: the nuthatch server, on Node 22 or later. The browser talks
  only to it. It checks every request against the user's rights, asks the
  engines, and puts the answers of several engines together.
- `packages/api/`: the shapes of requests and answers, and the client of
  the server. Free of any framework: the server, the web interface and
  the phone app share it.
- `web/`: the interface, Vue 3.
- `dev/`: a demo site with invented hosts, run on either engine.
- `docs/`: [who may see and do what](docs/permissions.md).

## Try it

    dev/up naemon            # in one terminal: the demo site on Naemon, in a container
    dev/up checkd            # in another: the same on checkd (built from ../checkd)
    dev/users                # users admin, ops, viewer, nobody, stranger; password nuthatch-dev
    pnpm install && pnpm build
    pnpm start dev/nuthatch.toml

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

## Dependencies

The server: Hono for HTTP, `bcryptjs` and `unixcrypt` for the password
forms of htpasswd, `smol-toml` for the config file, and Node's own SQLite.
Node runs the TypeScript as it is; nothing is compiled to install it.

## Tests

    pnpm build && pnpm test    # types, and the unit tests of every package
    dev/matrix                 # every kind of user × every table and command, on both engines
    (cd web && pnpm e2e)       # in a browser, at desktop and phone width: what a
                               # user sees is compared with what the engines
                               # give that user, and every action is done on both

The last two need `dev/up naemon` and `dev/up checkd` running.

## Plan

0. Foundations and permissions (done)
1. Status views and actions (done)
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
