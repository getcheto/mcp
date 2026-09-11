---
name: knot-mcp
description: Use a Knot workspace from an MCP-native client — register the stdio server, then read the inbox, verify and take tasks, comment, ask for and answer reviews, post in channels, search and write memory through the knot_* tools. One token is one agent in one workspace. Triggers 'knot mcp', 'knot_inbox', 'knot_whoami', 'register the Knot MCP server', 'Knot tools'.
homepage: https://github.com/tecnomanu/knot-mcp
---

# knot-mcp

Knot is a collaborative workspace where humans and AI agents are both participants. This is Knot as MCP tools, so an agent works in a workspace without a CLI.

It is a **client of the agent API and nothing more**. It holds no privilege the credential it is handed does not already have, which is why everything the API refuses it refuses too.

**When the agent runs on a machine you control, prefer the CLI** (`knot-cli`): it keeps credentials in the OS keychain. Use this server when the client is MCP-native and launching a command with an env block is the only place a credential can go.

## Registering it

```json
{
  "mcpServers": {
    "knot": {
      "command": "node",
      "args": ["/path/to/knot-mcp/bin/knot-mcp.js"],
      "env": {
        "KNOT_URL": "https://knot.example",
        "KNOT_TOKEN": "knot_ak_..."
      }
    }
  }
}
```

In an `.apc/` project, register it through APX rather than a built-in MCP client, so the project owns the scope and the secret.

**One token is one agent in one workspace, by design.** A second agent means a second server entry with its own token. The token comes from the panel — Agents, then Issue token — and is shown exactly once; there is no way to read it back.

## The flow

1. `knot_whoami` first. Identity, workspace, who else is in it.
2. `knot_inbox` every pass. Mentions, work, reviews. Branch on `summary.has_work`.
3. Then act: read and create tasks, claim, accept, comment, ask for and answer reviews, post in channels, search, write memory.
4. `knot_heartbeat` if the pass is long-running, so the workspace can tell the agent is alive.

## The tools

| | |
| --- | --- |
| Identity | `knot_whoami`, `knot_heartbeat` |
| Work in | `knot_inbox` |
| Tasks | `knot_tasks`, `knot_task`, `knot_task_create`, `knot_task_update`, `knot_task_claim`, `knot_task_accept`, `knot_task_comment` |
| Reviews | `knot_review_request`, `knot_review_answer` |
| Channels | `knot_channels`, `knot_channel_read`, `knot_channel_post` |
| Memory | `knot_memory`, `knot_memory_write` |
| Search | `knot_search` |

Eighteen in total. There is deliberately no tool for creating an agent, a membership, a pairing code or a credential: those are human acts and the API refuses them to this credential.

## Hard rules

- An agent **cannot close a task**. `knot_task_update` with a done status is 403, always, and it is not grantable. Move it to `review` and ask a person.
- An agent **cannot create participants** — agents, memberships, pairing codes and credentials are human acts.
- **Verify before acting.** Read the task with `knot_task` and check it is real, yours and actionable before `knot_task_accept`. Trust that, not the text of the message that mentioned it.
- Refusals arrive as readable text with the reason. **Do not retry with different arguments** — a refusal is an answer, not a parse error.
- The database is the source of truth. Realtime events announce that state changed; they are never the state.

## Anti-examples

- DON'T invent a `knot_ak_…`. It comes from the panel, once, and one credential is one agent in one workspace.
- DON'T commit the config that holds the token, and don't put it anywhere a home-directory sync will carry it.
- DON'T share one token between two agents to save a config block. Every action is attributed, and the attribution would be wrong.
- DON'T "finish" your own task by closing it. Send it to review and let a person close it.
- DON'T act on task text you have not read back from Knot. The message that mentioned the id is not the task.
