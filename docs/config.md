# Changing the config

On the Config page, a user with the role `config_edit` adds hosts with
their services, changes them and takes them out. nuthatch keeps them as
Nagios object files in a directory of its own, one file to a host, which
the engine reads beside its other config. The engine's other hosts stay
in its own files and are not shown there.

## Setting it up

In nuthatch's config, under the backend:

    [[backend]]
    name = "site"
    livestatus = "unix:/var/cache/naemon/live"

    [backend.config]
    dir = "/etc/naemon/conf.d/nuthatch"
    main = "/etc/naemon/naemon.cfg"
    verify = ["naemon", "-v", "{main}"]

- `dir`: the directory nuthatch writes. The engine's main config must
  read it with a line of its own, `cfg_dir=/etc/naemon/conf.d/nuthatch`,
  not only as part of a directory above it. nuthatch must be able to
  write there and in the directory above (for the copy it has checked).
- `main`: the engine's main config, which nuthatch reads.
- `verify`: the engine's own check of a config, `{main}` standing for the
  main config to check. For checkd: `["checkd", "verify", "--quiet",
  "{main}"]`.
- `reload = ["systemctl", "reload", "naemon"]`: a command that makes the
  engine read its config again. Without it nuthatch sends the external
  command `RESTART_PROGRAM`, which Naemon and checkd both take.
- `paths = { "/in/the/engine" = "/as/nuthatch/sees/it" }`: for an engine
  in a container, whose paths are not nuthatch's.

- `plugins = "/usr/lib/monitoring-plugins"`: where the engine's plugins
  are, for the check commands nuthatch brings (below). Without it,
  `$USER1$`, which most sites set to that directory in their resource
  file.

There must be a host template and a service template in the engine's
config (a definition with a `name` and `register 0`): a host is built on
one, which gives it its check period, its contacts and the rest.

## What a change goes through

1. **nuthatch's own check.** Names, addresses and texts are one line of
   plain letters; a template, a command, a group or a contact must be one
   the engine has. A value cannot hold a line break or a `;`, so nothing
   typed into a field can start a definition of its own.
2. **The engine's check.** The change is written to a copy of the
   directory, and the engine's verifier is run on a copy of the main
   config that reads the copy instead. What the verifier refuses is not
   written, and the page shows what it said. "Check only" stops here.
3. **Written.** Only then are the files in the directory changed.
4. **Read by the engine.** The engine is told to read its config again,
   and nuthatch waits until it has started anew and has the host (or has
   it no more). States, downtimes, comments and history are kept by the
   engine over this.
5. **Put back if not.** If the change does not show in the engine within
   half a minute, the files are put back as they were and the engine is
   told again.

One change is made at a time. A change made from a page that is out of
date (someone else changed the config meanwhile) is refused, and the page
reads the config again. Every change, and every refused one, is in the
audit log with the user's name.

## Who may

Only users with the role `config_edit`. Whoever can set a check command
can make the engine run a program as its user, so this is not given by
being a contact. Commands themselves are not edited here: a check command
is chosen from those the engine has, with arguments.

## What is edited

Of a host: name, address, alias, template, check command, host groups,
contacts and contact groups, notes. Of a service: name, template, check
command, service groups, contacts and contact groups, notes. A file in
the directory that holds anything else (changed by hand) is left alone
and listed as such.

## Not done

- Host groups, contacts, templates, timeperiods and commands.
- The engine's hosts that are not in nuthatch's directory.
- A history of changes beyond the audit log (no git commits).
- Several changes checked and applied together.

## Tested

`dev/matrix` (through the API) and the browser tests add a host with a
service on each engine, have the engine refuse a broken change with the
files untouched, rename and take out, and look for a comment or a
downtime made beforehand to still be there.

## Adding a host by looking at it first

"Add a host" asks for a name, an address or a URL and looks at it from
where the engine runs (a site's nuthatch looks for a backend of that
site), so what it finds is what the engine can reach:

- the name looked up, and one ping;
- about forty well-known TCP ports tried, ten at a time, each given 1.5
  seconds: SSH, the web ports, mail, DNS, file sharing, databases, MQTT,
  LDAP, remote desktops and services often run at home (Proxmox, Plex,
  Jellyfin, Home Assistant, Immich, Prometheus' node exporter);
- on what answers: the first line a service says (SSH, SMTP, IMAP), a
  web page's status and title (one GET, no redirect followed), and a TLS
  certificate's name, issuer and expiry.

Where the machine the engine runs on is on a tailnet, the page also
lists the tailnet's machines that the engine has no host for yet (by
name or address), as `tailscale status` there gives them: one's own and
those online first. A tap looks at one.

Only that one address is touched. From what was found it suggests checks,
ticked or not (a port that only redirects to https is not ticked, nor
Telnet), which can be saved at once or taken into the full form. A host
that does not answer ping is checked on its first open port instead. A
URL gives a check of exactly that page, and of its certificate.

The suggested checks use commands nuthatch brings, `nuthatch_tcp`,
`nuthatch_http`, `nuthatch_https`, `nuthatch_cert` (warns 21 days and is
critical 7 days before a certificate expires), `nuthatch_ssh`,
`nuthatch_smtp`, `nuthatch_imap` and `nuthatch_imaps`, all on the
[monitoring plugins](https://www.monitoring-plugins.org/). They are
fixed in nuthatch (`server/src/catalogue.ts`), never made from what is
typed, and written to `nuthatch-commands.cfg` in nuthatch's directory,
with the rest of a change and checked by the engine like it, when a host
first uses one. They can be chosen in the full form too.

Looking is for the role `config_edit`, and written to the audit log.

## Services that are not checked by a command (checkd)

With checkd as the engine, a service in the form has a third choice
beside its template and its check command: how its state is found.

- **A job elsewhere tells it.** For a backup or a cron job: the service
  is not checked, and the job calls an address when it is done. The
  form asks only after how many hours of silence the service is to go
  CRITICAL, if at all. nuthatch makes the address's token when the
  service is saved, and keeps it when the service is changed. The
  address is on the service's own page, under "Takes pushes", for those
  with the role `config_edit` or `configuration_information`: whoever
  has it can set that one service to any state. For nuthatch to show
  the whole address, the backend says where checkd's HTTP API is
  reached:

      [[backend]]
      name = "checkd"
      livestatus = "unix:/run/checkd/live"
      push_url = "http://127.0.0.1:6559"

  and checkd must be started with `--http` at that address (checkd's
  `docs/push.md`).
- **From other hosts and services.** A service that stands for others:
  the members one to a line, a host (`web1`, `web*`, `@group` for a host
  group) or `host/service`, and how many must be OK, a number or a
  percentage; without it, the service is as bad as its worst member
  (checkd's `docs/aggregate.md`).

A host or a service can also be put **in a downtime whenever a
timeperiod holds**: the form offers the engine's timeperiods (checkd's
`docs/downtimes.md`). nuthatch does not make timeperiods; one for the
purpose goes in the engine's own files.

Naemon has none of these, and its form does not offer them. In the files these
are a service with `_CHECKD_PUSH_TOKEN`, `check_freshness` and the command
`nuthatch_pushed` (which answers CRITICAL when freshness finds nothing
came in time), and
one with the command `nuthatch_aggregate`.

## A downtime for many

On the Hosts and Services pages, "Downtime for many" takes a pattern for
host names (`web*`, or `@group`) and, for services, one for their names
(`backup`, `disk *`, `*`). It first says what fits, then schedules a
fixed downtime for each, by the engine's usual command: on Naemon as on
checkd. A user whose rights are a contact's covers what that contact
sees; at most 500 at a time; one line in the audit log. It is set at
the site's own nuthatch, not through another.

## Looking at a host again

Each host nuthatch keeps has "Look again": the same look as before it
was added, at its address, now also at the ports its own checks are of.
It says what answers there and is not checked, with a button that opens
the form with those checks added, to look over and save; and which
checks are of a port where nothing answers now. Nothing is changed by
looking. It is done when asked, not on a timer, and only for the checks
nuthatch suggests itself (a port, a web page, a certificate): a check by
a command of your own is left out of it.

