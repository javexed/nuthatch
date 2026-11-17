# Installing

Beside an engine on the same machine: a Naemon that runs as a system
service with Livestatus (the Consol packages, or a build with the
Livestatus module), or checkd ([beside checkd](#beside-checkd)).
The paths are those of the Naemon packages; change them where yours
differ.

## What it needs

- Node 22.18 or later, and pnpm (`corepack enable`).
- Naemon's Livestatus socket, usually `/var/cache/naemon/live`, made
  `0660` for the group `naemon`:

      ls -l /var/cache/naemon/live
      srw-rw---- 1 naemon naemon 0 ... /var/cache/naemon/live

  If it is not, the broker line in `naemon.cfg` says how it is made:
  `broker_module=/usr/lib/naemon/naemon-livestatus/livestatus.so
  /var/cache/naemon/live` and the module's own options.

## The program

    sudo useradd --system --home-dir /var/lib/nuthatch --shell /usr/sbin/nologin nuthatch
    sudo usermod -aG naemon nuthatch
    sudo git clone https://github.com/javexed/nuthatch.git /opt/nuthatch
    cd /opt/nuthatch && sudo corepack enable && sudo pnpm install --frozen-lockfile && sudo pnpm build

The group `naemon` lets nuthatch open the socket, read Naemon's config,
and run `naemon -v` on it.

## Users

    sudo mkdir -p /etc/nuthatch
    sudo htpasswd -B -c /etc/nuthatch/htpasswd ann
    sudo chown root:nuthatch /etc/nuthatch/htpasswd && sudo chmod 0640 /etc/nuthatch/htpasswd

A user is the Naemon contact of the same name, and sees what that
contact may see. Roles come from `[roles]` ([permissions](permissions.md)).

## The config

`/etc/nuthatch/nuthatch.toml`:

    listen = "127.0.0.1:8080"
    behind_proxy = true
    web_root = "/opt/nuthatch/web/dist"
    store = "/var/lib/nuthatch/nuthatch.sqlite"
    htpasswd = "/etc/nuthatch/htpasswd"

    [roles]
    authorized_for_all_hosts = ["ann"]
    authorized_for_all_host_commands = ["ann"]
    authorized_for_all_services = ["ann"]
    authorized_for_all_service_commands = ["ann"]
    authorized_for_system_information = ["ann"]
    authorized_for_config_edit = ["ann"]

    [[backend]]
    name = "naemon"
    livestatus = "unix:/var/cache/naemon/live"

    # Adding and changing hosts from the Config page; leave out to only look.
    [backend.config]
    dir = "/etc/naemon/conf.d/nuthatch"
    main = "/etc/naemon/naemon.cfg"
    verify = ["naemon", "-v", "{main}"]

Without `reload`, nuthatch makes Naemon read its config again with the
external command `RESTART_PROGRAM`, through the socket.

For the Config page, Naemon reads the directory nuthatch writes, and
nuthatch may write it and the directory above it (where it puts the
copy it checks):

    sudo mkdir -p /etc/naemon/conf.d/nuthatch
    sudo chown nuthatch:naemon /etc/naemon/conf.d/nuthatch
    sudo chgrp naemon /etc/naemon/conf.d && sudo chmod g+w /etc/naemon/conf.d
    echo 'cfg_dir=/etc/naemon/conf.d/nuthatch' | sudo tee -a /etc/naemon/naemon.cfg

and a host template and a service template in Naemon's config
([config](config.md)).

## The service

    sudo cp /opt/nuthatch/contrib/systemd/nuthatch.service /etc/systemd/system/
    sudo systemctl daemon-reload && sudo systemctl enable --now nuthatch
    journalctl -u nuthatch

The unit keeps `/etc` read-only but for `/etc/naemon/conf.d`
(`ReadWritePaths`); with another `dir`, change that line.

## Beside checkd

The same steps, with checkd installed as its install notes say
(checkd's `docs/install.md`): the user and group `checkd`, the config in
`/etc/checkd`, the Livestatus socket at `/run/checkd/live`. What differs:

- The group is `checkd`, not `naemon`. checkd makes its socket and
  command file `0660` for that group, and `/run/checkd` is the group's
  only:

      sudo usermod -aG checkd nuthatch

- The backend:

      [[backend]]
      name = "checkd"
      livestatus = "unix:/run/checkd/live"

- For the Config page, checkd checks the copy, and the directory is
  under `/etc/checkd`:

      [backend.config]
      dir = "/etc/checkd/conf.d/nuthatch"
      main = "/etc/checkd/naemon.cfg"
      verify = ["checkd", "verify", "--quiet", "{main}"]

      sudo mkdir -p /etc/checkd/conf.d/nuthatch
      sudo chown nuthatch:checkd /etc/checkd/conf.d/nuthatch
      sudo chgrp checkd /etc/checkd/conf.d && sudo chmod g+w /etc/checkd/conf.d
      echo 'cfg_dir=/etc/checkd/conf.d/nuthatch' | sudo tee -a /etc/checkd/naemon.cfg

  checkd takes `RESTART_PROGRAM` through the socket as Naemon does, and
  reads its config again only when it can be used.

- The unit: `ReadWritePaths=-/etc/checkd/conf.d` in place of
  `/etc/naemon/conf.d` (`sudo systemctl edit nuthatch`, or in the copied
  unit).

- What only checkd has, each optional:
  - services that take passive results over HTTP: start checkd with
    `--http 127.0.0.1:6559`
    (`systemctl edit checkd`: an empty `ExecStart=`, then the unit's
    line with `--http 127.0.0.1:6559` added) and give the backend
    `http_url = "http://127.0.0.1:6559"`; with `CHECKD_HTTP_TOKEN` set
    for checkd, `http_token_file` names the file that holds it
    ([config](config.md));
  - agents on other hosts: `[agents]` and `[backend.agents]`
    ([agents](agents.md)).

## A proxy in front

nuthatch speaks plain HTTP on `127.0.0.1`; the proxy does TLS.

Caddy:

    monitoring.example.test {
        reverse_proxy 127.0.0.1:8080
    }

nginx:

    server {
        listen 443 ssl;
        server_name monitoring.example.test;
        ssl_certificate     /etc/ssl/monitoring.crt;
        ssl_certificate_key /etc/ssl/monitoring.key;
        location / {
            proxy_pass http://127.0.0.1:8080;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto https;
            # Live updates are a stream: not buffered.
            proxy_buffering off;
            proxy_read_timeout 1h;
        }
    }

`listen = "unix:/run/nuthatch/http.sock"` instead of an address keeps
everyone else on the machine out, but the socket is for nuthatch's own
user alone: only a proxy that runs as that user can use it (as
`tailscale serve` can, README).

## Updating

    cd /opt/nuthatch && sudo git pull && sudo pnpm install --frozen-lockfile && sudo pnpm build
    sudo systemctl restart nuthatch

nuthatch's store is migrated when it starts; back it up first.

## Going back

An older nuthatch refuses a store a newer one has migrated. So: stop the
service, check out the commit you came from, put the store's backup
back, build, and start it.

    sudo systemctl stop nuthatch
    cd /opt/nuthatch && sudo git checkout <previous commit> && sudo pnpm install --frozen-lockfile && sudo pnpm build
    sudo cp <backup of the store> <store>
    sudo systemctl start nuthatch
