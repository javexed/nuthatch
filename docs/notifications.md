# Notifications on a phone or desktop

Where nuthatch is installed as an app (README, "As an app"), or just open
in a browser that allows it, the engine's notifications can be pushed to
the device: on the lock screen, with a tap leading to the host or service.

Several notifications to one user that the engine logs within the same
few seconds are pushed as one message, "2 problems, 1 recovery", with
the first six named; a tap opens the problems.

## Who is notified of what

The engine decides, as for every other notification: its contacts, their
notification periods and options, acknowledgements, downtimes, flapping.
nuthatch passes on what the engine wrote in its log as a notification to
a contact (`HOST NOTIFICATION:` and `SERVICE NOTIFICATION:` lines), to the
browsers the user of that name subscribed. So:

- the user must be a contact of what they want to hear of, with a
  notification command; any command will do, and a contact with several
  is told once;
- nothing is pushed for what the engine does not notify of;
- only this nuthatch's own backends are watched. A site's notifications
  are pushed by that site's nuthatch, to those subscribed there.

Each backend's log is asked every five seconds while anyone is
subscribed.

## Setting it up

In nuthatch's config:

    [notifications]
    subject = "mailto:ops@example.test"

`subject` is whom a push service may reach about this server, as the
standard asks (VAPID, RFC 8292): a `mailto:` or an `https://` address. It
is sent to the push services with every message.

Then each user, on each device: **This device** (under More on a phone,
or their name in the top bar), **Notify this device**. On an iPhone or
iPad, nuthatch must first be added to the Home Screen and opened from
there (iOS 16.4 or later). Browsers only allow this over HTTPS.

## What leaves the machine

A message goes from nuthatch to the push service of the browser's maker
(Google for Chrome, Apple for Safari, Mozilla for Firefox, Microsoft for
Edge), which delivers it to the device. It is encrypted for that one
browser (RFC 8291), so the push service sees where it goes, when, and how
big it is, and the `subject` above, but not the host, the service or the
output. nuthatch sends only to those four services' addresses; a
subscription that names another is refused.

The server's key pair is made at the first start with `[notifications]` and kept
in nuthatch's store; browsers subscribe to it. A subscription the push
service says is gone is forgotten.

No dependency was added for this: `server/src/webpush.ts` does the
encryption and the signature with Node's own `crypto`.

## E-mail, chat and ntfy

A contact can also be reached by e-mail, in a chat channel, or with the
ntfy app, whether or not they log in to nuthatch. The same notifications
go these ways, from the same log, one message per contact per pass.

**How nuthatch sends** is set once, by the role `config_edit`: Config,
Notifications, **Notification channels**.

- **E-mail** through a mail server that takes a password login (AUTH
  PLAIN) over TLS: port 465, or 587 with STARTTLS. The server's
  certificate is checked. For Gmail: server `smtp.gmail.com`, port 465,
  the Google account as login, and an *app password* (Google Account,
  Security, 2-Step Verification, App passwords), not the account's own.
  The password is kept in nuthatch's store and never shown again; leave
  the field empty to keep it.
- **Chat**: links by name, each a channel's incoming webhook: Slack,
  Discord, Microsoft Teams (a Workflows webhook), Google Chat or
  Mattermost.
- **ntfy**: the server, `https://ntfy.sh` unless you run your own.

Each has a test, which saves first and sends by what is saved.

**How each contact is reached** is in their form, **Channels**: e-mail
(to their address), a chat link, or ntfy. ntfy gives the contact a topic
of its own, a random name, and a QR code: scanned with the phone, or the
link opened, it subscribes the ntfy app. On a public ntfy server anyone
who knows the topic can read it, so it is long and random; keep it to
the contact. A contact reached these ways needs no notification command
of their own: nuthatch gives them `nuthatch_notify`, which does nothing
(`checkd:dummy 0` on checkd, `/bin/true` on Naemon) but makes the engine
notify them, and log it.

What leaves the machine: the host, service, state and output go to the
mail server, the chat's service, or the ntfy server, in the clear to
them. Links in the messages lead to nuthatch when `subject` is its
`https://` address. A message that cannot be sent is logged by nuthatch
(`notify <backend>/<contact>: ...`) and not tried again.

The engine counts a notification as sent when it is logged; nuthatch
sends it on from the log. What is logged while nuthatch is stopped or
restarting is sent, once, when it is back, as far back as six hours;
older than that, it is not sent at all. Keep nuthatch running as the
engine is, or give contacts who must be told a notification command of
the engine's own besides.
