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
