# Security

## Reporting a problem

Use **"Report a vulnerability"** under the repository's Security tab on
GitHub. That reaches the maintainer privately. Please do not open a
public issue for something that could be used against a running site.

Say what you did, what happened and what you expected. There is one
maintainer and no promised time to answer. Only the newest commit of
`main` is looked after; there are no releases yet.

## What nuthatch is trusted with

- **It speaks for people to the engine.** The engine's Livestatus socket
  takes whatever it is sent; nuthatch is what stands between a browser
  and that socket. Every query is limited on the server to the tables
  and columns the user's roles allow, and to what the engine shows that
  user's contact (`AuthUser`); every command is checked, argument by
  argument, against the object it names. The browser never chooses a
  user, a header or a raw request. See
  [docs/permissions.md](docs/permissions.md).
- **One role can run programs.** `config_edit` writes hosts and services
  into the engine's config, and a check command is a program the engine
  runs. Commands are chosen from those the engine already has, or the few
  nuthatch brings; every change is checked by the engine's own verifier
  and written to the audit log. Give that role to those you would give a
  shell as the engine's user.
- **The same role can look at the network.** "Look before adding a host"
  connects from the server to about forty well-known ports of the one
  address typed, and pings it. It is for `config_edit` only, and each
  look is in the audit log. It reaches what the server can reach,
  including addresses the browser cannot.

## Logging in

- Passwords are in an htpasswd file (bcrypt; SHA-crypt and `$apr1$` are
  read). Logins are rate-limited. A session is a cookie; anything that
  changes something also needs the session's CSRF value. The phone app
  and scripts use tokens, made and taken away on the "This device" page.
- nuthatch speaks plain HTTP and refuses to listen beyond the machine
  unless `behind_proxy = true` says a proxy in front does TLS.
- `[tailscale]` trusts the header `Tailscale-User-Login`. That is only
  sound behind `tailscale serve`, listening where nothing else can
  connect: a Unix socket is best, and nuthatch warns about a TCP listen.
  Anything that can reach the listen address directly can name itself
  anyone in that table.
- `dev_user` makes everyone one user without logging in. It is for
  trying things on one machine, and is refused with a listen address
  beyond it.

## What it keeps

- Its store (SQLite): sessions, hashed API tokens, preferences,
  dashboards, browsers subscribed for notifications, and the audit log
  of logins, commands sent and refused, and config changes.
- With `[graphs]`: a second file with the numbers checks return, by host
  and service name, for the days configured.
- Nothing else of what is monitored: pages ask the engine each time. The
  service worker of the installed app keeps only the interface's own
  files.

## What leaves the machine

- **Pushed notifications**, with `[push]`: for each notification the
  engine logs for a user, an encrypted message goes to the push service
  of that user's browser (Google, Apple, Mozilla or Microsoft; no other
  address is sent to). The push service sees which browser, when, how
  big, and the `subject` of the config; it cannot read the message. See
  [docs/notifications.md](docs/notifications.md).
- **Other sites' nuthatch**, with `nuthatch = "https://..."` under a
  backend: requests for the logged-in user, with a key for that site
  ([docs/sites.md](docs/sites.md)).
- The page loads nothing from anywhere but the server itself.

## Not yet looked at by anyone else

No outside review or audit has been done. The permission rules are
tested for every kind of user against every table and command on both
engines (`dev/matrix`); that shows what was thought of, not what was not.
