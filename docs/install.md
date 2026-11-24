# Installing

Beside an engine on the same machine: a Naemon that runs as a system
service with Livestatus (the Consol packages, or a build with the
Livestatus module), or checkd ([beside checkd](#beside-checkd)).
The paths are those of the Naemon packages; change them where yours
differ.

## checkd and nuthatch together

### On a server

1. checkd, as its [install guide](https://github.com/javexed/checkd/blob/main/docs/install.md) says: the binary, the user
   `checkd`, a config in `/etc/checkd`, the system service. A config to
   start from: [the one below](#without-root), with the paths of
   `naemon.cfg` under `/var/lib/checkd` and `/run/checkd`.
2. nuthatch, as this page says, with the changes of
   [Beside checkd](#beside-checkd).
3. [A proxy in front](#a-proxy-in-front).

### Without root

One machine, watched from your own account: checkd as a user service,
and nuthatch beside it at <http://127.0.0.1:7780>. Needs Rust, Node
22.18 or later, and pnpm.

checkd, built, and a config that watches this machine with checks that
need no plugin:

    git clone https://github.com/javexed/checkd.git ~/checkd
    (cd ~/checkd && cargo build --release -p checkd)
    install -Dm 755 ~/checkd/target/release/checkd ~/.local/bin/checkd
    mkdir -p ~/.config/checkd/objects ~/.config/checkd/managed ~/.local/state/checkd

    cat > ~/.config/checkd/naemon.cfg <<EOF
    cfg_dir=$HOME/.config/checkd/objects
    cfg_dir=$HOME/.config/checkd/managed
    resource_file=$HOME/.config/checkd/resource.cfg
    check_external_commands=1
    command_file=$XDG_RUNTIME_DIR/checkd/checkd.cmd
    lock_file=$XDG_RUNTIME_DIR/checkd/checkd.pid
    log_file=$HOME/.local/state/checkd/checkd.log
    retain_state_information=1
    state_retention_file=$HOME/.local/state/checkd/retention.dat
    temp_path=$HOME/.local/state/checkd
    EOF
    echo '$USER1$=/usr/lib/monitoring-plugins' > ~/.config/checkd/resource.cfg

`~/.config/checkd/objects/start.cfg`:

    define timeperiod {
        timeperiod_name  24x7
        alias            Always
        sunday 00:00-24:00
        monday 00:00-24:00
        tuesday 00:00-24:00
        wednesday 00:00-24:00
        thursday 00:00-24:00
        friday 00:00-24:00
        saturday 00:00-24:00
    }
    define command {
        command_name  notify-none
        command_line  /bin/true
    }
    define contact {
        contact_name                   admin
        alias                          Admin
        host_notification_period       24x7
        service_notification_period    24x7
        host_notification_commands     notify-none
        service_notification_commands  notify-none
    }
    define command {
        command_name  ping
        command_line  checkd:ping -H $HOSTADDRESS$
    }
    define command {
        command_name  disk
        command_line  checkd:disk -p $ARG1$ -w 80 -c 90
    }
    define command {
        command_name  memory
        command_line  checkd:memory -w 80 -c 90
    }
    define command {
        command_name  load
        command_line  checkd:load -w 4 -c 8
    }
    define host {
        name                   machine
        register               0
        check_command          ping
        max_check_attempts     3
        check_interval         5
        retry_interval         1
        check_period           24x7
        contacts               admin
        notification_period    24x7
    }
    define service {
        name                   check
        register               0
        max_check_attempts     3
        check_interval         5
        retry_interval         1
        check_period           24x7
        contacts               admin
        notification_period    24x7
    }
    define host {
        use                    machine
        host_name              localhost
        address                127.0.0.1
    }
    define service {
        use                    check
        host_name              localhost
        service_description    Disk /
        check_command          disk!/
    }
    define service {
        use                    check
        host_name              localhost
        service_description    Memory
        check_command          memory
    }
    define service {
        use                    check
        host_name              localhost
        service_description    Load
        check_command          load
    }

Then:

    checkd verify ~/.config/checkd/naemon.cfg
    install -Dm 644 ~/checkd/contrib/systemd/checkd-user.service ~/.config/systemd/user/checkd.service
    systemctl --user daemon-reload && systemctl --user enable --now checkd
    loginctl enable-linger "$USER"    # keep both running when logged out

nuthatch, with one user, `admin`, the contact above (`openssl` asks
for the password):

    git clone https://github.com/javexed/nuthatch.git ~/nuthatch
    cd ~/nuthatch && corepack enable && pnpm install --frozen-lockfile && pnpm build
    mkdir -p ~/.config/nuthatch ~/.local/state/nuthatch
    printf 'admin:%s\n' "$(openssl passwd -6)" > ~/.config/nuthatch/htpasswd
    chmod 600 ~/.config/nuthatch/htpasswd

    cat > ~/.config/nuthatch/nuthatch.toml <<EOF
    listen = "127.0.0.1:7780"
    web_root = "$HOME/nuthatch/web/dist"
    store = "$HOME/.local/state/nuthatch/nuthatch.sqlite"
    htpasswd = "$HOME/.config/nuthatch/htpasswd"

    [[backend]]
    name = "checkd"
    livestatus = "unix:$XDG_RUNTIME_DIR/checkd/live"
    EOF

    install -Dm 644 contrib/systemd/nuthatch-user.service ~/.config/systemd/user/nuthatch.service
    systemctl --user daemon-reload && systemctl --user enable --now nuthatch

Open <http://127.0.0.1:7780> and log in as `admin`. More hosts and
services: files in `~/.config/checkd/objects`, then
`systemctl --user reload checkd`; or the Config page, with
`[backend.config]` and a role for it ([config](config.md)). From other machines: a proxy in front,
or `tailscale serve` (README).

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
([checkd's install guide](https://github.com/javexed/checkd/blob/main/docs/install.md)): the user and group `checkd`, the config in
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
