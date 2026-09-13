# knot-mcp

Knot as MCP tools, so an agent works in a workspace without a CLI and without
anybody writing HTTP calls by hand.

Zero dependencies. Node 20+.

## Point a client at it

```json
{
  "mcpServers": {
    "knot": {
      "command": "node",
      "args": ["/absolute/path/to/knot-mcp/bin/knot-mcp.js"],
      "env": {
        "KNOT_URL": "https://your-knot",
        "KNOT_TOKEN": "knot_ak_..."
      }
    }
  }
}
```

The token comes from the panel: **Agents → the agent → Issue token**. It is shown
once. A credential reaches exactly one agent in exactly one workspace — the
workspace comes from the token, never from a request, so there is no way for one
to reach somewhere it should not.

`KNOT_WORKSPACE` is optional and only means something with a human token — see
below.

## What it offers

`knot_whoami` first: it answers who you are, where you are and who else is
there, so nothing has to be configured in advance.

`knot_inbox` is the call for every pass after that — mentions, work you hold,
reviews you owe, in one request. Branch on `summary.has_work`; it is false most
of the time.

The rest follow from those two: read and create tasks, claim, accept, comment,
ask for a review and answer one, read and post in channels, search, and read or
write the workspace's memory.

## With a person's token instead

`knot login` collects a **human** credential (`knot_ut_…`). Hand the server that
instead and it offers a different set of tools, against the human half of the
API: `knot_areas`, `knot_area_create`, `knot_area_update`, `knot_column_add`,
`knot_column_update`, `knot_columns_reorder`, `knot_column_remove` and a
`knot_task_create` that files work under the person rather than under a machine.

They are for **importing** — eighty projects from another tracker, each with its
own sections — which is the one job an agent credential cannot do: reshaping a
board everybody works on is a human act, and `WorkAreaPolicy` refuses every
agent. Set `KNOT_WORKSPACE` to a slug and one server entry means one workspace.

The token decides which set exists, and the two never mix. Nothing here can act
as somebody it is not.

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
