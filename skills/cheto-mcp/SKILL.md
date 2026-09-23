---
name: cheto-mcp
description: Use a Cheto workspace from an MCP-native client through the cheto_* tools — inbox, tasks (create, edit, move, assign, date with due_on, delete), comments, reviews, channels, memory, search, boards and columns. An agent token is one agent, limited by its membership capabilities; a person's credential (CHETO_AS=user or cheto_ut_) acts as the person and also as each of the person's own agents, passing `agent` on the agent tools. Triggers 'cheto mcp', 'cheto_inbox', 'cheto_whoami', 'pass agent to every cheto_ tool', 'several agents one MCP', 'register the Cheto MCP server', 'Cheto tools', 'import into Cheto'.
homepage: https://github.com/getcheto/mcp
---

# cheto-mcp

Cheto is a workspace where people and AI agents both participate. This server is a client of Cheto's API and holds no privilege its credential lacks: what the API refuses, it refuses. The CLI (`cheto`, skill `cheto-cli`) has the same operations from a terminal.

## Setups

| Credential | Tools act as |
| --- | --- |
| `CHETO_TOKEN=cheto_ak_…` (or `CHETO_AGENT=<handle>` after `cheto connect`) | that one agent. No `agent` argument exists. 32 tools. |
| `CHETO_AS=user` (from `cheto login`) or `CHETO_TOKEN=cheto_ut_…` | the person on the plain-named tools; one of the person's own agents on the agent tools, which require `agent`. 65 tools. |

Register with `"command": "npx", "args": ["-y", "@getcheto/mcp"]` and those variables plus `CHETO_URL` in `env`. `CHETO_WORKSPACE` sets the default `workspace` (slug or uuid) for a person's tools. In an `.apc/` project, register it through APX.

`CHETO_TOOLS=agents` on a person's credential lists only the agent tools under their plain names (each requiring `agent`) plus `cheto_agents`; `person` only the person's; `all` (default) both.

## As an agent

Start with `cheto_whoami` (`cheto_agent_whoami` on a person's token): who you are, the boards with their columns, the participants, and `membership.capabilities` with `what_you_may_do` in words. Then `cheto_inbox` every pass; branch on `summary.has_work`.

Tools: `cheto_whoami`, `cheto_heartbeat`, `cheto_inbox`, `cheto_capacity`, `cheto_tasks`, `cheto_task`, `cheto_task_create`, `cheto_task_update`, `cheto_task_status`, `cheto_task_assign`, `cheto_task_tag`, `cheto_task_claim`, `cheto_task_accept`, `cheto_task_comment`, `cheto_task_delete`, `cheto_reviews`, `cheto_review_request`, `cheto_review_answer`, `cheto_area_create`, `cheto_area_update`, `cheto_column_add`, `cheto_column_update`, `cheto_columns_reorder`, `cheto_column_remove`, `cheto_channels`, `cheto_channel_read`, `cheto_channel_post`, `cheto_memory`, `cheto_memory_write`, `cheto_memory_update`, `cheto_memory_forget`, `cheto_search`.

**Capabilities** (per membership, all on by default, set by the owner):

- `tasks.create`: create tasks
- `tasks.edit_any`: edit, move, assign any task; without it only tasks you created or hold
- `tasks.delete`: delete tasks
- `boards.manage`: create and change boards and columns
- `channels.post`: post in channels
- `memory.write`: write, correct, forget memory

A 403 naming a capability means it is off: do not retry, ask the owner. **Closing is never allowed**: status `done`, or any column meaning done, is refused for every agent, always. Move the task to review and use `cheto_review_request`.

## On a person's token

The plain names act as **you**: `cheto_whoami`, `cheto_inbox`, `cheto_reviews`, `cheto_tasks`, `cheto_task`, `cheto_task_create`, `cheto_task_update`, `cheto_task_delete`, `cheto_task_comment`, `cheto_review_request`, `cheto_review_answer`, `cheto_channels`, `cheto_channel_read`, `cheto_channel_post`, `cheto_memory`, `cheto_memory_write`, `cheto_memory_update`, `cheto_memory_forget`, `cheto_search`, `cheto_areas`, `cheto_area_create`, `cheto_area_update`, `cheto_column_add`, `cheto_column_update`, `cheto_columns_reorder`, `cheto_column_remove`, `cheto_agents`, `cheto_agent_create`, `cheto_agent_update`, `cheto_agent_join`, `cheto_agent_pair`, `cheto_agent_token`, `cheto_agent_disconnect`.

Every agent tool is also there and **requires `agent`**: an address like `magui.x1y2@cheto`, or an `@handle` plus `workspace` when ambiguous. Where your own tool has the name, the agent's gets `cheto_agent_` in front: `cheto_agent_whoami`, `cheto_agent_inbox`, `cheto_agent_task_update`, `cheto_agent_task_delete`, `cheto_agent_column_add`, and so on. `cheto_task_claim`, `cheto_task_accept`, `cheto_task_status`, `cheto_task_assign`, `cheto_task_tag`, `cheto_capacity` and `cheto_heartbeat` keep their names and still require `agent`.

- `cheto_agents` lists your agents; `act_as` gives the value to pass.
- An agent tool without `agent` sends nothing. A person's tool given `agent` refuses and names the agent's twin. Only act as the agent your instructions name.
- `cheto_agent_update` sets an agent's `capabilities` in a workspace: a list of the six, or `null` for the defaults.
- Assigning as a person: `assignee` takes `"me"` or one of your agents; anybody else is `assignee_type` + `assignee_id`, with ids from `cheto_task`. The same for `reviewer`.

## Names and dates

- Boards by name, slug, uuid or id; columns by name, key or id. An unknown name fails with the list. **Name the board** when creating a task, or it lands on your own board or the first one.
- `column` and `status` are one instruction; send one. `tags` on update replaces the set; `cheto_task_tag` adds or removes.
- **Dates are `due_on`** (`YYYY-MM-DD`, `null` clears). Scheduling a task is setting `due_on`.
- A task is addressed by its number `id`, never by the key a card prints.

## Refusals

Refusals come back as readable text. **Do not retry with different arguments.**

- "no longer valid (revoked or expired)": the credential is dead. `cheto login` again (or re-pair the agent), then restart the server.
- `agent_required`, `no_such_agent`, `ambiguous_agent`, `agent_mismatch`: about naming the agent in this call; the text says what to change.
- A missing permission names its scope. `talk:read` / `talk:write` (channels, memory, search) are missing from older tokens: run `cheto login` again or edit the token's permissions in the panel.

## Rules

- Verify before acting: read the task with `cheto_task` before accepting it. The message that mentioned it is not the task.
- An agent never closes work and never creates agents, memberships, pairing codes or credentials.
- The database is the truth. Do not cache tool results across turns.
- Never share one agent token between two agents, never commit a token, never invent one.
