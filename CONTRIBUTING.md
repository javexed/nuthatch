# Contributing

## Clean-room rule

nuthatch is licensed MIT OR Apache-2.0. Thruk, the web interface it is
modelled on, is GPL, and so are Naemon and Nagios Core. Nothing in this
repo may be derived from their source.

- Do not port, translate or copy from Thruk's source: its Perl, templates,
  HTML, CSS, JavaScript, images or icons. Do not open that source while
  working on nuthatch.
- Take what Thruk does from its public documentation and from using a
  running Thruk as a black box: what pages there are, what they show,
  what can be done from them. Design and write the screens anew.
- Take how engines answer from the Livestatus documentation and from
  queries sent to a running Naemon and checkd (`dev/`).
- Icons and fonts come from projects with a permissive licence, named in
  `web/THIRD-PARTY.md`.
- What an engine does with a request (which tables `AuthUser` limits, for
  one) is measured on a running engine and written down in `docs/`.
- Sample configs and test data are written for this project.

One exception happened before this repo existed: for checkd, part of
Thruk's Livestatus backend (how it picks the columns it asks for) was read
to choose checkd's version string. Nothing of it is used here.

By contributing you confirm that your change was not written from GPL
source.

## AI-written code

Much of the code is written by Claude, which may have seen Thruk, Naemon or
Nagios source in its training data. The rule above still applies to how
the work is done. Whether that supports a clean-room claim is a legal
question that has not been checked.

## Before the first commit

    scripts/install-hooks.sh

turns on the hooks of `.githooks`: before a commit and before a push,
`scripts/leak-scan.sh` looks at what is new for things that look like
secrets and for private addresses that are not plainly made up
(documentation addresses such as 192.0.2.1 are fine). The same check runs
on every pull request. A line that must show such a thing, as a test
fixture, says so with the marker `leak-scan-allow`.

