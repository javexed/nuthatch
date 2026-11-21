# The assistant

A chat beside the pages that reads what the engines say and explains it:
why a service is critical, what changed before an alert, whether several
problems are one. A problem host's or service's page also gets an
**Explain** button. It answers with the model service set on the Config
page: Claude through Anthropic's API, a local model through Ollama, or any
service that speaks OpenAI's chat completions.

It can only read. It acknowledges nothing, sets no downtime and changes
no config; where an action would help, it says which.

## Setting it up

    [assistant]
    users = ["ann", "bob"]

- `users`: who may use it; `"*"` is everyone who logs in. A paid service
  costs money per question, so name people.
- `model`, `effort` (optional): the Claude model and effort used until the
  Config page sets others; `claude-opus-5-5` and `medium` when left out.

Then someone with the role `config_edit` picks the service on the Config
page, under Assistant:

| Service | Address (when left empty) | Key |
|---|---|---|
| Anthropic | `https://api.anthropic.com` | needed |
| Ollama | `http://127.0.0.1:11434` | only where a proxy in front asks for one |
| OpenAI-compatible | `https://api.openai.com/v1` | as the service asks |

OpenAI-compatible covers OpenAI, OpenRouter, vLLM, llama.cpp's server,
LM Studio, LocalAI and others: give the address up to and including `/v1`.
The model field suggests the models the service lists.

- **Effort** (Anthropic): `low` to `max`. Higher looks further and costs
  more.
- **Context** (Ollama): how many tokens the model may hold, sent as
  `num_ctx`; 16384 when not changed. Ollama's own default, 4096, is too
  small for the assistant's tool answers. Through Ollama's `/v1` address
  (as OpenAI-compatible) this cannot be set, so use Ollama's own.
- The model has to call tools: on Ollama, one whose page lists "tools"
  (Qwen 3, Llama 3.1 and later, Mistral and others). Small local models
  follow the instructions less closely than Claude: they may write
  Markdown, or state a value they did not read.

The key is kept in the store and never shown again; Remove key takes it
away. A key is sent only over HTTPS, or to this machine or the tailnet,
and is dropped when the service or address changes. Until a model (and,
for Anthropic, a key) is set, nobody sees the assistant.

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
to answer it go to the model service: host and service names, addresses,
states, plugin output, log lines, numbers. With Ollama or another model
on this machine, nothing leaves it. See
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
- When a Claude model declines a request, the API tries it once more on
  another model (Anthropic's server-side fallback) before saying so;
  for the models that have one (Opus 5 and later, Sonnet 5.5, Fable).
- Each change of the settings is in the audit log: service, address,
  model, and whether a key was set, kept or removed.
