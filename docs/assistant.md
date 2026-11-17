# The assistant

A chat beside the pages that reads what the engines say and explains it:
why a service is critical, what changed before an alert, whether several
problems are one. A problem host's or service's page also gets an
**Explain** button. It answers with Claude, through Anthropic's API.

It can only read. It acknowledges nothing, sets no downtime and changes
no config; where an action would help, it says which.

## Setting it up

    [assistant]
    users = ["ann", "bob"]
    model = "claude-opus-5-5"
    effort = "medium"

- `users`: who may use it; `"*"` is everyone who logs in. It costs money
  per question, so name people.
- `model` (optional): the Claude model; `claude-opus-5-5` when left out.
- `effort` (optional): `low`, `medium` (when left out), `high`, `xhigh` or
  `max`. Higher looks further and costs more.

Then someone with the role `config_edit` sets the API key on the Config
page, under Assistant. It is kept in the store and never shown again; the
same place takes it away. Until a key is set, nobody sees the assistant.

## What it reads, and as whom

The assistant has two tools: a Livestatus query (any table the pages
read: hosts, services, the log, history, comments, downtimes, groups) and
the history of a check's numbers from `[graphs]`. Both go through the
same checks as the pages, as the user who asks: a user limited to their
contact's hosts gets an assistant limited the same way, and columns or
tables that need a role need it here too. A site's rows come from that
site's nuthatch, as they do on the pages.

## What leaves the machine

Each question, the conversation before it, and what the assistant reads
to answer it go to Anthropic: host and service names, addresses, states,
plugin output, log lines, numbers. See
[SECURITY.md](../SECURITY.md#what-leaves-the-machine).

What a monitored host writes reaches the model as data. A host could
write output meant to steer it; with no tool that changes anything, the
most that can do is a misleading answer.

## Limits

- One answer at a time per user, of at most 12 requests to the model.
- A conversation is kept in the browser while the page is open, up to 40
  turns; nothing of it is kept on the server.
- Each answer is logged with its steps and tokens in the audit log, not
  its text.
- When the model declines a request, the API tries it once more on
  another model (Anthropic's server-side fallback) before saying so;
  for the models that have one (Opus 5 and later, Sonnet 5.5, Fable).
