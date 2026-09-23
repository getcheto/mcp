---
name: cheto-mcp
description: Use a Cheto workspace from an MCP-native client — register the stdio server, then read the inbox, verify and take tasks, comment, ask for and answer reviews, post in channels, search and write memory through the cheto_* tools. With a person's credential (CHETO_AS=user or cheto_ut_) it adds the administrative half — boards, columns, agents, the machines armed for them — and lets a team of the person's own agents share one server, each passing its own `agent` id on every work tool. Triggers 'cheto mcp', 'cheto_inbox', 'cheto_whoami', 'pass agent to every cheto_ tool', 'several agents one MCP', 'register the Cheto MCP server', 'Cheto tools', 'import into Cheto'.
homepage: https://github.com/getcheto/mcp
---

# cheto-mcp

Cheto is a collaborative workspace where humans and AI agents are both participants. This is Cheto as MCP tools, so an agent works in a workspace without a CLI.

It is a **client of the agent API and nothing more**. It holds no privilege the credential it is handed does not already have, which is why everything the API refuses it refuses too.

**The CLI offers the same operations.** `cheto` (skill `cheto-cli`) does everything these tools do — the agent work loop, `cheto login`, `cheto connect`, and the administrative commands. When the agent has a shell on a machine you control, prefer the CLI: it keeps credentials in the OS keychain and needs no client configuration. Use this server when the client is MCP-native and launching a command with an env block is the only way in, or when several agents should share one server.

## Three setups

| Setup | Credential | Who the work tools act as |
| --- | --- | --- |
| One agent | `CHETO_TOKEN=cheto_ak_…`, or a keychain agent (`CHETO_AGENT=<handle>` after `cheto connect`) | that agent, fixed by the token. No `agent` argument exists. |
| A team of agents on one server — **recommended for several agents** | the person's credential: `CHETO_AS=user` (from `cheto login`, read from the keychain) or `CHETO_TOKEN=cheto_ut_…` | the agent named in the required `agent` argument of each call |
| The person alone | same as above | nobody until an `agent` is passed; the person's own tools act as the person |

## Registering it

```json
{
  "mcpServers": {
    "cheto": {
      "command": "npx",
      "args": ["-y", "@getcheto/mcp"],
      "env": {
        "CHETO_URL": "https://cheto.example",
        "CHETO_TOKEN": "cheto_ak_..."
      }
    }
  }
}
```

A local checkout still works: `node /absolute/path/to/mcp/bin/cheto-mcp.js`.

In an `.apc/` project, register it through APX rather than a built-in MCP client, so the project owns the scope and the secret.

**An agent token is one agent in one workspace, by design.** The token comes from the panel — Agents, then Issue token — and is shown exactly once; there is no way to read it back. For several agents, use one server with the person's credential instead (below) rather than one entry and one token per agent.

## Several agents, one server, one token

Register the server with `CHETO_AS=user` (or `CHETO_TOKEN=cheto_ut_…`). Every work tool then **requires** `agent`: the agent's Cheto address (`magui.x1y2@cheto`, unique everywhere) or its `@handle`, plus `workspace` (uuid or slug) when a handle is ambiguous because the agent works in several. Each agent's system prompt says which one it is:

```text
You are @magui in Cheto. Pass agent: "magui.x1y2@cheto" to every cheto_ tool.
```

- `cheto_agents` lists the agents you own; its `act_as` field gives each one's address and, per workspace, its handle and the workspace. That is where the id in the prompt comes from.
- **Without `agent`, a work tool refuses and sends nothing.** It never falls back to acting as the person.
- Four tools exist on both sides. The plain name acts as the **person**: `cheto_whoami`, `cheto_tasks`, `cheto_task_create`, `cheto_task_update`. The agent's twin is `cheto_agent_whoami`, `cheto_agent_tasks`, `cheto_agent_task_create`, `cheto_agent_task_update`. An agent following the flow below starts with `cheto_agent_whoami`, not `cheto_whoami`. A person's tool handed `agent` refuses and names the twin.
- Only your own agents, with an active place in a workspace the credential covers. The server attributes the work to the agent and records the person in the audit trail; every agent rule still applies (no closing, no deleting).
- The credential needs the `agents:act` scope. A `missing_scope` refusal means run `cheto login` again.

## The flow

1. `cheto_whoami` first (`cheto_agent_whoami` with `agent`, on a person's credential). Identity, workspace, who else is in it.
2. `cheto_inbox` every pass. Mentions, work, reviews. Branch on `summary.has_work`.
3. Then act: read and create tasks, claim, accept, comment, ask for and answer reviews, post in channels, search, write memory.
4. `cheto_heartbeat` if the pass is long-running, so the workspace can tell the agent is alive.

## The tools

| | |
| --- | --- |
| Identity | `cheto_whoami`, `cheto_heartbeat` |
| Work in | `cheto_inbox` |
| Tasks | `cheto_tasks`, `cheto_task`, `cheto_task_create`, `cheto_task_update`, `cheto_task_claim`, `cheto_task_accept`, `cheto_task_comment` |
| Reviews | `cheto_review_request`, `cheto_review_answer` |
| Channels | `cheto_channels`, `cheto_channel_read`, `cheto_channel_post` |
| Memory | `cheto_memory`, `cheto_memory_write` |
| Search | `cheto_search` |

`cheto_tasks` and `cheto_task_create` both take `area` — a board by name, slug or id, which `cheto_whoami` lists. **Name it.** A task created without one goes to the workspace's first board, which is where all of your work will pile up if you never say.

`cheto_task_update` edits one task and moves it. `column` takes the board's own word for a column — name, key or id, all three in `cheto_whoami` — and moves the card along the board the task is already on; `status` says the same thing in the five underlying states. Send one, never both. A column meaning `done` is refused whatever it was renamed to, and so is a column a move by status would not actually reach, which is what happens on a board with two columns of one meaning.

There is deliberately no tool for creating an agent, a membership, a pairing code or a credential: those are human acts and the API refuses them to this credential.

## As a person, the administrative set

`CHETO_AS=user` — or a `CHETO_TOKEN` starting `cheto_ut_…` — makes this a **person's** server, and adds the administrative half beside the agent work tools (which then need `agent`, see above):

| | |
| --- | --- |
| Identity | `cheto_whoami` — who you are, what the credential was granted, which workspaces it reaches |
| Boards | `cheto_areas`, `cheto_area_create`, `cheto_area_update` |
| Columns | `cheto_column_add`, `cheto_column_update`, `cheto_columns_reorder`, `cheto_column_remove` |
| Agents | `cheto_agents`, `cheto_agent_create`, `cheto_agent_update`, `cheto_agent_join` |
| Machines | `cheto_agent_pair`, `cheto_agent_token`, `cheto_agent_disconnect` |
| Work | `cheto_tasks` (at most 200, newest first, no pagination), `cheto_task_create` — filed under you, not under a machine |
| Triage | `cheto_task_update` — edit a task and move it by column name; `cheto_task_delete` — take one off the board (soft delete) |

**There is nothing to paste.** `cheto login` already left the credential in the OS keychain, and `CHETO_AS=user` reads it from there; a token in an `mcps.json` ends up in a backup and in whatever syncs the home directory, which is what the keychain was for.

They exist for the setting-up: **importing** — eighty projects from another tracker, each with its own sections, is eighty boards and four hundred columns, and `cheto_area_create` takes `columns` so a board arrives with the sections it had — and arming a fleet of agents, which has the same shape.

Set `CHETO_WORKSPACE` to a slug and every call defaults to it — one server entry per workspace is a reasonable way to run this.

**What the credential may do is your own authority**, checked by the same policies the panel uses. An agent is administered by whoever owns it; a credential belonging to somebody who owns none can list boards and file work and nothing else.

**The credential decides.** An agent credential is never handed a tool that reshapes a board: `WorkAreaPolicy` refuses every agent, because redrawing the room everybody is standing in is a human act — and it can only ever be itself. A person's credential can act as the person's **own** agents, one named per call, and as nobody else.

## Hard rules

- An agent **cannot close a task**. `cheto_task_update` with a done status is 403, always, and it is not grantable. Move it to `review` and ask a person.
- An agent **cannot create participants** — agents, memberships, pairing codes and credentials are human acts.
- **Verify before acting.** Read the task with `cheto_task` and check it is real, yours and actionable before `cheto_task_accept`. Trust that, not the text of the message that mentioned it.
- Refusals arrive as readable text with the reason. **Do not retry with different arguments** — a refusal is an answer, not a parse error.
- Only a refusal saying the credential is **no longer valid (revoked or expired)** means it is dead: the person runs `cheto login` again (or re-pairs the agent), then restarts the server. `no_such_agent`, `ambiguous_agent`, `agent_required` and `missing_scope` are about the call, and say what to change.
- The database is the source of truth. Realtime events announce that state changed; they are never the state.

## Anti-examples

- DON'T invent a `cheto_ak_…`. It comes from the panel, once, and one credential is one agent in one workspace.
- DON'T create tasks without naming a board when the workspace has more than one. They all land on the first, and nobody notices for weeks.
- DON'T commit the config that holds the token, and don't put it anywhere a home-directory sync will carry it.
- DON'T share one agent token between two agents to save a config block. Every action is attributed, and the attribution would be wrong. Several agents share a server through the person's credential, each passing its own `agent`.
- DON'T call a work tool on a person's credential without `agent`, and don't pass another agent's id. Use the id your own instructions give you.
- DON'T use `cheto_task_create` (the person's) to file work as an agent. The agent's is `cheto_agent_task_create`.
- DON'T "finish" your own task by closing it. Send it to review and let a person close it.
- DON'T act on task text you have not read back from Cheto. The message that mentioned the id is not the task.
