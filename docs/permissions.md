# Who may see and do what

nuthatch decides this on the server, for every request. The model is the
one of Nagios' own web interface and of Thruk, with their names.

## The rule

- A user is the **contact** of the same name in the engine's config.
- A user sees the hosts and services that contact belongs to, directly or
  through a contact group. A contact of a host sees its services too.
- A user may send commands about what they see, when the contact has
  `can_submit_commands 1`.
- **Roles** widen or narrow that.

## Roles

Set in the `[roles]` table of the config. `authorized_for_<role>` lists
users, `authorized_contactgroup_for_<role>` lists contact groups, and `*`
is everyone.

| Role | Gives |
|---|---|
| `all_hosts` | sees every host, and every service |
| `all_services` | sees every service |
| `all_host_commands` | commands about every host and every service |
| `all_service_commands` | commands about every service |
| `system_information` | the engine's status and versions, the log's lines about the program, nuthatch's audit log |
| `configuration_information` | contacts, contact groups, commands, timeperiods; check commands and custom variables of hosts and services |
| `read_only` | no commands at all, whatever else |
| `config_edit` | adding, changing and taking out hosts and services ([config](config.md)) |
| `system_commands` | nothing yet: for commands about the engine itself |

A user with no role and no contact of their name can log in and sees
nothing.

## How it is enforced

- **Queries.** The browser names a table, columns and filter lines. Only
  filter lines are let through, one line each; nothing else of Livestatus
  can be sent. For a user who must be limited, the server adds `AuthUser:
  <user>`, and the engine leaves out what the contact may not see. The
  browser cannot set or remove that.
- **Tables the engine gives to anyone.** Measured on Naemon 1.5.2:
  `AuthUser` limits hosts, services, host groups, comments, downtimes and
  the log's lines about objects. It does not limit contacts, contact
  groups, commands, timeperiods or status. It gives everyone the log's
  lines about no object, and the lines of external commands whose first
  argument is no host's name (`DEL_HOST_COMMENT;9`). nuthatch asks a role
  for those tables, and gives limited users only the log's alerts,
  notifications, passive checks and state lines.
- **Secrets.** Check commands, event handlers, command lines and custom
  variables can carry passwords. Asking for such a column, or filtering by
  it, needs `configuration_information`.
- **Commands.** nuthatch sends a fixed list of commands, each with the
  kind of every argument. Before sending one for a user without a
  commands role, it asks the engine, as that user, whether the host, the
  service, or the downtime or comment to delete is one they see. The
  author of acknowledgements, downtimes and comments is always the user
  who is logged in.
- **An engine that does not limit users.** When it first talks to a
  backend, and every minute, nuthatch asks for the hosts as a user that
  cannot exist. An engine that shows that user any host does not enforce
  `AuthUser`: nuthatch then keeps it closed to everyone but users with
  `all_hosts`, and says so. Naemon and checkd both enforce it.
- **Changes.** A browser session's requests that change something must
  carry the session's CSRF value in a header. API tokens need none; a
  token is made by a user who logged in with a password and stands for
  that user.
- **Live updates** carry no data, only "something changed on backend X";
  the browser then asks again through the queries.
- **Logins.** Five failures in five minutes for a user name or from an
  address, then that name or address waits. Behind `tailscale serve`,
  listed tailnet logins come in without a password (README).

## Tested

`dev/matrix` logs in as five kinds of user and tries every table (17) and
every command (26) on each engine, on what each user sees and on what they
do not, and changes the config: about 800 checks, and as many again
through a central nuthatch (`--federated`).

## Not done

- A user header set by any proxy other than `tailscale serve` (single
  sign-on).
- Naemon's Livestatus options `service_authorization` and
  `group_authorization` change what a contact sees; nuthatch follows
  whatever the engine is set to. Only the defaults were tried.
- Rights per API token (a token has all of its user's).
