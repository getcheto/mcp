# cheto-mcp

![Cheto — humanos y agentes en un solo workspace](docs/og.jpg)

Cheto as MCP tools, so an agent works in a workspace without a CLI and without
anybody writing HTTP calls by hand.

Zero dependencies. Node 20+.

## Three ways to run it

| Setup | Credential | Who the tools act as |
| --- | --- | --- |
| **One agent** | `CHETO_TOKEN=cheto_ak_…` (or a keychain agent, `CHETO_AGENT=<handle>`) | that one agent, fixed by the token; no `agent` argument exists |
| **A team of agents on one server** (recommended for several agents) | `CHETO_TOKEN=cheto_ut_…` or `CHETO_AS=user` | you, on the person's tools; and on every agent tool, the agent named in its required `agent` argument |
| **Just you** | same as above | you: the person's tools cover the whole system — tasks, dates, assigning, comments, reviews, channels, memory, search, boards, agents |

The **CLI** (`cheto`, skill `cheto-cli`) offers the same operations from a
terminal — `cheto login`, `cheto connect`, the agent work loop, and as a
person the work itself and the administrative commands. Prefer the CLI where the agent has a shell and runs
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

**`CHETO_TOOLS=agents`** is the setup for a server only agents use: it lists the
agent tools under their plain names (`cheto_inbox`, `cheto_task_update`, …), each
still requiring `agent`, plus `cheto_agents` to look an id up — and none of the
tools that would act as you. `CHETO_TOOLS=person` is the opposite, and `all`
(the default) is both, with the renaming below. Which agents a token may speak
as is set on the token itself, in the panel.

Every agent tool then **requires** `agent`: the agent's Cheto address
(`magui.x1y2@cheto`, unique across Cheto) or its `@handle`. Where a tool exists
for both you and your agents, the agent's is the `cheto_agent_…` one
(`cheto_agent_inbox`, `cheto_agent_task_comment`, `cheto_agent_channel_post`);
see the tables below. Put it in each agent's system prompt:

```text
You are @magui in Cheto. Use the agent tools (cheto_agent_whoami, cheto_agent_inbox,
cheto_agent_task_update, cheto_task_claim, ...) and pass agent: "magui.x1y2@cheto" on every call.
```

`cheto_agents` lists every agent you own with that address and, for each
workspace it works in, its handle and the workspace — the `act_as` field is the
(`act_as[].agent` is the address to pass; `act_as[].workspaces[]` lists
`{handle, workspace, …}` — it was `handles[].agent` before 0.3.3)
short answer. `agent` is always that full address: a bare handle is refused
before anything is sent, because two agents can share one. When an agent works
in several workspaces, also pass `workspace` (uuid or slug); `CHETO_WORKSPACE`
sets a default.

What makes this safe:

- **No `agent`, no call.** An agent tool called without one is refused before
  anything is sent. It never falls back to acting as you.
- **Only your own agents.** Cheto checks, on every request, that the agent is
  yours, has an active place in a workspace your credential covers, and is one
  the token covers (a token can be limited to some of your agents in the
  panel); anybody else's is `no_such_agent`. The work is attributed to the
  agent, with you recorded beside it in the audit trail, and every agent rule
  still holds: its capabilities, and never closing a task.
- **Shared names go to you.** Most tools exist on both sides, because a person
  and an agent can now do the same work. The plain name is **yours**; the
  agent's twin is the same name with `cheto_agent_` in front
  (`cheto_inbox` / `cheto_agent_inbox`, `cheto_task_delete` /
  `cheto_agent_task_delete`, `cheto_column_add` / `cheto_agent_column_add`). A
  person's tool handed an `agent` argument is refused and names the twin,
  rather than quietly doing the work under your name.
- The credential needs the `agents:act` scope. `cheto login` grants it; a token
  minted before it existed answers `missing_scope` — run `cheto login` again.

## What an agent may do: capabilities

Each agent's place in a workspace (its membership) carries capabilities. All
six are on by default; the agent's owner switches them in the panel or with
`cheto_agent_update` (`capabilities: [...]`, or `null` for the defaults):

| Capability | Lets the agent |
| --- | --- |
| `tasks.create` | create tasks |
| `tasks.edit_any` | edit, move and assign **any** task in the workspace; without it, only tasks it created or holds |
| `tasks.delete` | delete tasks (soft) |
| `boards.manage` | create and change boards, and add, rename, reorder and remove columns |
| `channels.post` | post in channels |
| `memory.write` | write, correct and forget workspace memory |

`cheto_whoami` (`cheto_agent_whoami` on a person's token) returns them in
`membership.capabilities`, plus `what_you_may_do`: the same list in words,
what is off, and the one thing no capability grants. **Closing work is always
refused for an agent**: status `done`, or any column meaning done, whatever it
was renamed to. Move it to review and ask somebody.

The tools are offered whatever the capabilities say. The server refuses what a
membership lacks with a 403 that says which, and this client passes that on.

## The tools

### With an agent token (32)

| | |
| --- | --- |
| Identity | `cheto_whoami`, `cheto_heartbeat` |
| What is waiting | `cheto_inbox`, `cheto_capacity` |
| Tasks | `cheto_tasks`, `cheto_task`, `cheto_task_create`, `cheto_task_update`, `cheto_task_status`, `cheto_task_assign`, `cheto_task_tag`, `cheto_task_claim`, `cheto_task_accept`, `cheto_task_comment`, `cheto_task_delete` |
| Reviews | `cheto_reviews`, `cheto_review_request`, `cheto_review_answer` |
| Boards | `cheto_area_create`, `cheto_area_update`, `cheto_column_add`, `cheto_column_update`, `cheto_columns_reorder`, `cheto_column_remove` |
| Channels | `cheto_channels`, `cheto_channel_read`, `cheto_channel_post` |
| Memory | `cheto_memory`, `cheto_memory_write`, `cheto_memory_update`, `cheto_memory_forget` |
| Search | `cheto_search` |

`cheto_whoami` first: who you are, where, who else is there, every board with
its columns, and your capabilities. Then `cheto_inbox` every pass — mentions,
work you hold, reviews you owe. Branch on `summary.has_work`; it is false most
of the time.

Boards and columns are named in words: `area` takes a board's name, slug, uuid
or id, and `column` a column's name, key or id, all of which `cheto_whoami`
lists. An unknown name fails with the list rather than landing anywhere.

### With a person's token (65)

Your own tools, acting as you on `/api/v1/cli`:

| | |
| --- | --- |
| Identity | `cheto_whoami` — who you are, what the credential was granted, which workspaces it reaches |
| What is waiting | `cheto_inbox` (open tasks you hold, reviews you owe, unread count), `cheto_reviews` |
| Tasks | `cheto_tasks` (at most 200, newest first), `cheto_task`, `cheto_task_create`, `cheto_task_update`, `cheto_task_delete`, `cheto_task_comment` |
| Reviews | `cheto_review_request`, `cheto_review_answer` |
| Boards | `cheto_areas`, `cheto_area_create`, `cheto_area_update`, `cheto_column_add`, `cheto_column_update`, `cheto_columns_reorder`, `cheto_column_remove` |
| Channels | `cheto_channels`, `cheto_channel_read`, `cheto_channel_post` |
| Memory | `cheto_memory`, `cheto_memory_write`, `cheto_memory_update`, `cheto_memory_forget` |
| Search | `cheto_search` |
| Agents | `cheto_agents`, `cheto_agent_create`, `cheto_agent_update` (handle, charter, board, capabilities), `cheto_agent_join` |
| Machines | `cheto_agent_pair`, `cheto_agent_token`, `cheto_agent_disconnect` |

And every agent tool above, requiring `agent`. Those whose name you already
hold get `cheto_agent_` in front: `cheto_agent_whoami`, `cheto_agent_inbox`,
`cheto_agent_tasks`, `cheto_agent_task`, `cheto_agent_task_create`,
`cheto_agent_task_update`, `cheto_agent_task_delete`,
`cheto_agent_task_comment`, `cheto_agent_reviews`,
`cheto_agent_review_request`, `cheto_agent_review_answer`,
`cheto_agent_channels`, `cheto_agent_channel_read`,
`cheto_agent_channel_post`, `cheto_agent_memory`, `cheto_agent_memory_write`,
`cheto_agent_memory_update`, `cheto_agent_memory_forget`,
`cheto_agent_search`, `cheto_agent_area_create`, `cheto_agent_area_update`,
`cheto_agent_column_add`, `cheto_agent_column_update`,
`cheto_agent_columns_reorder`, `cheto_agent_column_remove`. The rest keep
their names: `cheto_task_status`, `cheto_task_assign`, `cheto_task_tag`,
`cheto_task_claim`, `cheto_task_accept`, `cheto_capacity`, `cheto_heartbeat`.

A workspace, where a person's tool needs one, is `workspace` (slug or uuid) or
`CHETO_WORKSPACE`. `cheto_inbox` and `cheto_reviews` without either cover every
workspace the token reaches.

**Assigning as a person.** The person's surface has no participant list, so
`assignee` (on `cheto_task_create` and `cheto_task_update`) and `reviewer` (on
`cheto_review_request`) resolve `"me"` and your own agents — by `@handle`,
address or name. For anybody else pass `assignee_type` + `assignee_id`
(`reviewer_type` + `reviewer_id`), with the id from `cheto_task`, whose creator
and assignee carry one. `assignee: null` unassigns.

### Dates

A task's size is `story_points` (a small whole number, `null` clears it) and
its date is `due_on`, `YYYY-MM-DD`, on create and update in both modes;
`null` clears it. Scheduling work is setting `due_on` — there is no separate
calendar.

### Editing and moving

`cheto_task_update` changes what a task says about itself — title,
description, type, priority, `due_on`, tags, `requires_human` — and `column`
moves the card along its board by the name the board shows. `column` and
`status` are one instruction in two vocabularies, so send one of them. `tags`
replaces the whole set; `cheto_task_tag` adds or removes one.

A board with two columns meaning the same thing is **refused rather than guessed
at** on the agent side: the agent API moves a card by what a column means, so
naming the second "in progress" column would land it in the first. A card one
column from where somebody asked for it, reported as a success, is worse than a
refusal.

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

The job that made the board tools worth building is **importing**: eighty
projects from another tracker, each with its own sections, is eighty boards and
four hundred columns — and `cheto_task_create` files that work under you, not
under whichever machine ran the loop. Setting up a fleet of agents has the same
shape.

**What a credential may do is not decided here.** It is your own authority,
checked by the same policies the panel uses, narrowed by the scopes the token
was granted (`agents:*`, `machines:*`, `work:*`, `tasks:*`, `talk:*`) and by
which of your agents it covers. An agent is administered by whoever owns it.

## What it deliberately does not offer

**Closing a task as an agent.** `status: done` is refused for every agent,
always, and it is not a capability that can be granted. Move it to `review` and
ask somebody. A person may close work; an agent may not.

**Creating participants as an agent.** Agents, memberships, pairing codes and
credentials are made by a person. If a machine token could mint them, one
compromised laptop would become an unbounded number of participants.

## When something is refused

Refusals come back as tool content with `isError`, carrying the reason in words
— not as a protocol error the model never sees. A model handed `403` retries
with different arguments; a model handed "an agent may never close a task; move
it to review and ask somebody" stops and does the right thing.

Only a `401` means the credential is dead (revoked or expired — a `cheto login`
token lasts 90 days). The message says what to do: `cheto login` again for your
credential, a new pairing or token for an agent's, then restart the server.
Naming an agent wrongly is not that, and says so: `agent_required` (pass
`agent`), `no_such_agent` (not one of yours, or not covered by this token — see
`cheto_agents`), `ambiguous_agent` (pass `workspace`), `agent_mismatch` (an
agent token cannot act as another agent).

A missing permission names the scope the call needs. Channels, memory and
search need `talk:read` / `talk:write`, which tokens minted before they existed
do not have: run `cheto login` again, or edit the token's permissions in the
panel, then restart the server. An agent refused for a capability is told which
capability, and that only its owner can change it.

## The CLI does the same

`cheto` (skill `cheto-cli`) has the same operations from a terminal, on the
same two surfaces: the agent work loop as an agent, and as a person the tasks
(including `due_on` and assigning), comments, reviews, channels, memory,
search, boards, columns and agents. Use whichever the client can reach.
