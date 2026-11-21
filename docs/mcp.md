# MCP

nuthatch answers MCP (the Model Context Protocol) at `/api/v1/mcp`, so an
AI client you run, such as Claude Code, can read the engines: what is
down, what changed, what a check's numbers did. The client's own model
does the thinking; nuthatch gives it two tools and nothing else.

## The tools

- `livestatus_query`: rows of a Livestatus table (hosts, services, the
  log, history, comments, downtimes, groups), with filters and sorting,
  at most 100 rows.
- `perf_history`: the numbers a check gave over the last hours, from
  `[graphs]`.

Both read as the token's user, through the same checks as the pages: a
user limited to their contact's hosts gets the same limit here, and
columns or tables that need a role need it here too. Neither changes
anything: there is no tool to acknowledge, set a downtime, recheck or
change the config. Both are marked read-only for the client.

## Connecting

1. On **This device** (the user name at the top), under Tokens, make a
   token with **Read-only** ticked, named for the client, such as
   `claude-code`. Copy it; it is shown once.
2. Tell the client where nuthatch is. For Claude Code:

       claude mcp add --transport http nuthatch https://nuthatch.example.ts.net/api/v1/mcp \
         --header "Authorization: Bearer nh_..."

   Use the address the browser uses, with `/api/v1/mcp` after it.

Then ask the client about your monitoring; it calls the tools as it
needs them.

## Who can use it

- **Only with an API token.** A browser session cannot use it, and a
  request from a web page (one with an `Origin` header) is refused.
- **A read-only token** is enough, and is what to give a client. It
  reaches the engines' state (the session, queries, stats, graphs and
  MCP) and nothing else: no commands, even where its user could send
  them, no config, no settings, no secrets.
- **Each call is in the audit log**, with the token's name and what it
  looked at. Delete the token on This device to cut the client off.
- **Where it can be reached** is where nuthatch can: keep it on the
  tailnet or another private network. Services that connect from their
  own cloud (claude.ai, ChatGPT) cannot reach a nuthatch that is not on
  the internet, and nuthatch has no OAuth for them.

## What leaves the machine

What the tools return goes to the client, and from there to whichever
model the client uses (for Claude Code, Anthropic's). That is host and
service names, addresses, states, plugin output, log lines, numbers: as
much as the token's user may see.

What a monitored host writes reaches the model as data. A host could
write output meant to steer it; with tools that only read, the most that
can do is a misleading answer.

## In the protocol's terms

Streamable HTTP, stateless: each POST carries one JSON-RPC message and
gets one JSON answer; there is no session and no stream from the server
(GET answers 405). Protocol versions 2025-11-25, 2025-06-18 and
2025-03-26. Methods: `initialize`, `ping`, `tools/list`, `tools/call`.
