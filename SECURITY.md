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
  pings the one address typed and connects from the server to about
  forty well-known ports of it, to the port of a URL that was typed, and
  to up to thirty further ports the request names (those a host's
  checks are of). Where a web server answers it asks for one page, the
  path of the URL typed or `/`, and gives back the status, the page's
  title and where it redirects to. It is for `config_edit` only, and
  each look is in the audit log. It reaches what the server can reach,
  including addresses the browser cannot.
- **The same role installs agents.** It writes agent tokens into
  checkd's agents directory and makes install commands. A command's
  code fetches, once and within 15 minutes, a script with the host's
  token in it, without a login; the agent binaries are served to anyone
  too. Each fetch is in the audit log. Commands are made only for an
  `https` address of nuthatch. `[agents] listen` opens a second listener
  that answers only those two paths; its commands check its certificate
  by pin. See [docs/agents.md](docs/agents.md).

## Logging in

- Passwords are in an htpasswd file (bcrypt; SHA-crypt and `$apr1$` are
  read). Failed logins are counted by user name and by address, five in
  five minutes; behind a proxy the address is the last one in
  `X-Forwarded-For`, which the proxy must set, and without that header
  they are counted by user name only. Taking a user out of the htpasswd
  file does not end that user's sessions (up to seven days) or tokens
  (until deleted): see below. A session is a cookie; anything that
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

- Its store (SQLite): sessions and API tokens (as hashes), preferences,
  dashboards, the browsers subscribed for notifications with their keys,
  the server's own key pair for pushed notifications (not hashed: it has
  to be used), and the audit log of logins, commands sent and refused,
  and config changes, which names hosts and holds comment texts. The
  file is made with the permissions the service's umask gives: keep its
  directory to the service's user.
- A user who has left keeps working sessions and tokens until they are
  removed from the store; there is no page for that yet. With the
  service stopped: `sqlite3 <store> "DELETE FROM sessions WHERE user =
  'name'; DELETE FROM tokens WHERE user = 'name'; DELETE FROM push WHERE
  user = 'name';"`.
- With `[graphs]`: a second file with the numbers checks return, by host
  and service name, for the days configured.
- Nothing else of what is monitored: pages ask the engine each time. The
  service worker of the installed app keeps only the interface's own
  files.

## What leaves the machine

- **Pushed notifications**, with `[notifications]`: for each notification the
  engine logs for a user, an encrypted message goes to the push service
  of that user's browser (Google, Apple, Mozilla or Microsoft; no other
  address is sent to). The push service sees which browser, when, how
  big, and the `subject` of the config; it cannot read the message. See
  [docs/notifications.md](docs/notifications.md).
- **Other sites' nuthatch**, with `nuthatch = "https://..."` under a
  backend: requests for the logged-in user, with a key for that site
  ([docs/sites.md](docs/sites.md)).
- **checkd's `/metrics`**, with `[backend.agents]` and `push_url`: read to
  show which agents are connected.
- The page loads nothing from anywhere but the server itself.

## Not yet looked at by anyone else

No outside review or audit has been done. The permission rules are
tested on both engines for five kinds of user against twelve of the
seventeen tables and a set of the commands (`dev/matrix`,
[docs/permissions.md](docs/permissions.md)); the other five tables
(state history, downtimes and the three by service group) were tried by
hand to show an unknown user nothing. That shows what was thought of,
not what was not.
