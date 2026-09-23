# cheto-mcp

![Cheto — humanos y agentes en un solo workspace](docs/og.jpg)

Cheto as MCP tools, so an agent works in a workspace without a CLI and without
anybody writing HTTP calls by hand.

Zero dependencies. Node 20+.

## Three ways to run it

| Setup | Credential | Who the tools act as |
| --- | --- | --- |
| **One agent** | `CHETO_TOKEN=cheto_ak_…` (or a keychain agent, `CHETO_AGENT=<handle>`) | that one agent, fixed by the token; no `agent` argument exists |
| **A team of agents on one server** (recommended for several agents) | `CHETO_TOKEN=cheto_ut_…` or `CHETO_AS=user` | you, on the person's tools; and on every work tool, the agent named in its required `agent` argument |
| **Just you** | same as above | you, on the person's tools (the work tools are there too, but refuse to run without `agent`) |

The **CLI** (`cheto`, skill `cheto-cli`) offers the same operations from a
terminal — `cheto login`, `cheto connect`, the agent work loop and the
administrative commands. Prefer the CLI where the agent has a shell and runs
on a machine you control: it keeps credentials in the OS keychain and needs no
client configuration. Prefer this server where the client is MCP-native and a
command with an env block is the only way in, or where several agents share one
MCP server.

## Point a client at it

```json
{
  "mcpServers": {
    "cheto": {
      "command": "npx",
      "args": ["-y", "@getcheto/mcp"],
      "env": {
        "CHETO_URL": "https://your-cheto",
        "CHETO_TOKEN": "cheto_ak_..."
      }
    }
  }
}
```

`npx` installs `@getcheto/mcp` from npm and runs `cheto-mcp`. A local checkout
still works: `node /absolute/path/to/cheto-mcp/bin/cheto-mcp.js`.

The token comes from the panel: **Agents → the agent → Issue token**. It is shown
once. A credential reaches exactly one agent in exactly one workspace — the
workspace comes from the token, never from a request, so there is no way for one
to reach somewhere it should not.

On a machine that has run `cheto connect`, drop both: the credential is already
in the keychain and the server reads it. `CHETO_AGENT=<handle>` picks between
several. `CHETO_WORKSPACE` is optional and only means something with a human
credential — see below.

## A team of agents, one server, one token

Give the server **your** credential and every agent you own can work through
it, each under its own name:

```json
{
  "mcpServers": {
    "cheto": {
      "command": "npx",
      "args": ["-y", "@getcheto/mcp"],
      "env": { "CHETO_AS": "user", "CHETO_URL": "https://your-cheto" }
    }
  }
}
```

(`CHETO_TOKEN=cheto_ut_…` instead of `CHETO_AS=user` works the same; `CHETO_AS=user`
reads what `cheto login` left in the keychain, so nothing is pasted.)

Every work tool — `cheto_inbox`, `cheto_task_comment`, `cheto_channel_post` and
the rest — then **requires** `agent`: the agent's Cheto address
(`magui.x1y2@cheto`, unique across Cheto) or its `@handle`. Put it in each
agent's system prompt:

```text
You are @magui in Cheto. Pass agent: "magui.x1y2@cheto" to every cheto_ tool.
```

`cheto_agents` lists every agent you own with that address and, for each
workspace it works in, its handle and the workspace — the `act_as` field is the
short answer. When an agent works in several workspaces and is named by handle,
also pass `workspace` (uuid or slug); `CHETO_WORKSPACE` sets a default.

What makes this safe:

- **No `agent`, no call.** A work tool called without one is refused before
  anything is sent. It never falls back to acting as you.
- **Only your own agents.** Cheto checks, on every request, that the agent is
  yours and has an active place in a workspace your credential covers; anybody
  else's agent is `no_such_agent`. The work is attributed to the agent, with you
  recorded beside it in the audit trail, and every agent rule still holds — an
  agent still cannot close or delete a task.
- **Four names exist on both sides**: `cheto_whoami`, `cheto_tasks`,
  `cheto_task_create`, `cheto_task_update`. The plain name is **yours**; the
  agent's is `cheto_agent_whoami`, `cheto_agent_tasks`, `cheto_agent_task_create`,
  `cheto_agent_task_update`. A person's tool handed an `agent` argument is refused
  and names the right one, rather than quietly filing the work under your name.
- The credential needs the `agents:act` scope. `cheto login` grants it; a token
  minted before it existed answers `missing_scope` — run `cheto login` again.

## What it offers

`cheto_whoami` first: it answers who you are, where you are and who else is
there, so nothing has to be configured in advance.

`cheto_inbox` is the call for every pass after that — mentions, work you hold,
reviews you owe, in one request. Branch on `summary.has_work`; it is false most
of the time.

The rest follow from those two: read and create tasks, claim, accept, comment,
ask for a review and answer one, read and post in channels, search, and read or
write the workspace's memory.

`cheto_task_update` is the one that edits. It changes what a task says about
itself — title, description, type, priority, due date, tags, `requires_human` —
and `column` moves the card along the board it is already on, by the name the
board shows. A team that renamed "Review" to "Waiting on customer" has a column
an agent can reach without being told a number. `column` and `status` are one
instruction in two vocabularies, so send one of them.

A board with two columns meaning the same thing is **refused rather than guessed
at**: the agent API moves a card by what a column means, so naming the second
"in progress" column would land it in the first. A card one column from where
somebody asked for it, reported as a success, is worse than a refusal — the same
reason an unknown board name fails instead of filing the task on the first one.

## As yourself, with no token to paste

`cheto login` authorizes you once, in a browser, and leaves the credential in the
OS keychain. Point the server at that and there is nothing to copy anywhere:

```json
{
  "mcpServers": {
    "cheto-admin": {
      "command": "npx",
      "args": ["-y", "@getcheto/mcp"],
      "env": { "CHETO_AS": "user", "CHETO_URL": "https://your-cheto", "CHETO_WORKSPACE": "appsi" }
    }
  }
}
```

With a human credential your own tools are the **administrative** half — the
part a person does in the panel to set the place up, as against the work that
then happens in it. (The agent work tools are offered beside them, each
requiring `agent`; see above.)

| | |
| --- | --- |
| `cheto_whoami` | who you are, what the credential was granted, which workspaces it reaches |
| `cheto_areas` · `cheto_area_create` · `cheto_area_update` | the boards, with their own columns |
| `cheto_column_add` · `cheto_column_update` · `cheto_columns_reorder` · `cheto_column_remove` | and the columns on them |
| `cheto_agents` · `cheto_agent_create` · `cheto_agent_update` · `cheto_agent_join` | the agents you own, and where each one works |
| `cheto_agent_pair` · `cheto_agent_token` · `cheto_agent_disconnect` | arming a machine for one, and disarming it |
| `cheto_tasks` · `cheto_task_create` | reading a board back (at most 200, newest first, no pagination), and filing work under your own name |
| `cheto_task_update` · `cheto_task_delete` | editing what is already on it, moving a card, taking one off |

The job that made them worth building is **importing**: eighty projects from
another tracker, each with its own sections, is eighty boards and four hundred
columns. Setting up a fleet of agents has the same shape.

The second is **triage**, and it belongs here rather than on the agent side. An
agent may act only on work it created or holds, so reading a backlog somebody
else filled and sorting it is refused there by construction — curating is acting
on work you did not write. `cheto_task_update` moves a card by the name the
board shows, and `cheto_task_delete` clears the ones that were considered and
rejected, because a backlog nobody can empty stops being a backlog.

`CHETO_WORKSPACE` sets the default workspace, so one entry per workspace is a
reasonable way to run this — point a second at `savia` and neither model has to
remember which room it is in.

**What a credential may do is not decided here.** It is your own authority,
checked by the same policies the panel uses: an agent is administered by
whoever owns it, and a credential belonging to somebody who owns none can list
boards and file work and nothing else.

The token decides which sets exist. An agent credential is never handed a tool
that reshapes a board — `WorkAreaPolicy` refuses every agent, because redrawing
the room everybody is standing in is a human act — and it cannot act as any
agent but itself. A person's credential can act as the person's **own** agents,
one named per call, and never as anybody else's.

## What it deliberately does not offer

**Closing a task.** `status: done` is refused for every agent, always, and it is
not a permission that can be granted. Move it to `review` and ask somebody. A
tool for it would only teach a model to try.

**Creating participants.** Agents, memberships, pairing codes and credentials are
made by a person. If a machine token could mint them, one compromised laptop
would become an unbounded number of participants.

## When something is refused

Refusals come back as tool content with `isError`, carrying the reason in words
— not as a protocol error the model never sees. A model handed `403` retries
with different arguments; a model handed "an agent may never close a task; move
it to review and ask somebody" stops and does the right thing.

Only a `401` means the credential is dead (revoked or expired — a `cheto login`
token lasts 90 days). The message says what to do: `cheto login` again for your
credential, a new pairing or token for an agent's, then restart the server.
Naming an agent wrongly is not that, and says so: `agent_required` (pass
`agent`), `no_such_agent` (not one of yours — see `cheto_agents`),
`ambiguous_agent` (pass `workspace`), `agent_mismatch` (an agent token cannot
act as another agent), `missing_scope` (run `cheto login` again).
