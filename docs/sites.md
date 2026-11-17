# One interface over several sites

**Experimental.** The settings and the protocol between sites may change before 1.0.

A nuthatch can show, beside or instead of engines of its own, the engines
of other sites: each through the nuthatch that runs at that site.

    browser ── central nuthatch ── HTTPS, a key ── site's nuthatch ── Livestatus ── engine

The central one does not talk Livestatus across the network, which has no
login and is not encrypted. It asks the site's nuthatch and says for which
user it asks.

## Setting it up

At the site, in its nuthatch's config, a key for the central one:

    [[peer]]
    name = "central"
    key_file = "/etc/nuthatch/central.key"

At the central one, the site as a backend:

    [[backend]]
    name = "east"
    nuthatch = "https://east.example.test"
    key_file = "/etc/nuthatch/east.key"

The key is one word of at least 32 letters, the same in both files:
`head -c 32 /dev/urandom | base64 | tr -d '+/=' > central.key`. The URL
must be `https://` (plain `http://` is taken for this machine only); the
site's certificate is checked against the system's authorities, or those
in `NODE_EXTRA_CA_CERTS`.

A site with one engine appears under the name given here (`east`); one
with several as `east/<the site's name for it>`.

## Who decides what

- **The user logs in at the central nuthatch**, against its htpasswd.
- **The site decides what that user may see and do there**, with its own
  roles and the engine's contacts, exactly as for a user who logged in at
  the site: the central one passes requests on and puts the answers
  together. A host of one name at two sites is two hosts.
- **The key is trusted to say who the user is.** Whoever has a site's key
  can ask as any user of that site. Keep it as you would a password of
  the site's administrator, and give a key no more than it needs:
  - `read_only = true`: with this key nothing is sent and nothing changed;
  - `config = true`: with this key the config can be changed, by users who
    have the role for it at the site. Off unless set.
- Dashboards, preferences, tokens and the audit log are each nuthatch's
  own. A command passed on is written down at both: at the central one
  with the user, at the site with the user and "through central".

## What is passed on

Queries and totals, commands, the config pages, and the events that say
something changed. Lists are sorted over all sites: each site gives its
first rows in the order asked for, and the page is cut from those.

## When a site does not answer

Its part of a list is missing and the page says which site and why; the
rest is shown. A site that does not take the key says so, and the user
stays logged in at the central one.

## Tested

`dev/matrix --federated` runs the whole permissions test, the config
changes included, through a central nuthatch that has no engine of its
own, over a nuthatch at Naemon's "site" and one at checkd's; then with a
key that may only read, and with one the site does not know.

## Not done

- Tried on one machine only, over plain HTTP between the nuthatches; not
  over a real network with TLS.
- A site's history and availability over long spans are as slow as at the
  site, and the central one waits for them.
