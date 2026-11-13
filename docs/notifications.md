# Notifications on a phone or desktop

Where nuthatch is installed as an app (README, "As an app"), or just open
in a browser that allows it, the engine's notifications can be pushed to
the device: on the lock screen, with a tap leading to the host or service.

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

    [push]
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

The server's key pair is made at the first start with `[push]` and kept
in nuthatch's store; browsers subscribe to it. A subscription the push
service says is gone is forgotten.

No dependency was added for this: `server/src/webpush.ts` does the
encryption and the signature with Node's own `crypto`.
