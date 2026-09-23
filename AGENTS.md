# AGENTS.md — cheto-mcp

Cheto as MCP tools. A **client** of `/api/v1/agent` (and `/api/v1/cli` with a person's
credential, `cheto_ut_…` or `CHETO_AS=user`). It holds no privilege the credential it is handed does not
already have.

This is its own repository (`getcheto/mcp`). The application lives in
[`getcheto/cheto`](https://github.com/getcheto/cheto).

## Start here

| Read | For |
| --- | --- |
| [`README.md`](README.md) | How to point a client at it |
| [`skills/cheto-mcp/SKILL.md`](skills/cheto-mcp/SKILL.md) | The skill an agent follows when using these tools |
| https://getcheto.com/skills/cheto-http | The HTTP surface this wraps |

## Rules

- Zero runtime dependencies. Node 20+.
- An agent credential is one agent, and gets only the agent tools. A person's
  credential gets the person's tools and the agent tools, and every agent tool
  then requires `agent` (sent as `X-Cheto-Agent`). An agent tool never falls
  back to acting as the person, and a person's tool never runs when handed an
  `agent`. See `src/toolset.js`.
- An agent cannot close a task and cannot create participants. The API refuses
  those; this client must refuse them too, not retry.
- The database on the server is the source of truth. Do not treat a tool result
  as state to cache across turns.
- Run `npm test` (`node --test`) before calling a change done. The application
  pipeline does not run this suite.

## Layout

```
bin/cheto-mcp.js
src/            api.js (HTTP), toolset.js (which tools per credential), tools.js, human-tools.js
skills/cheto-mcp/SKILL.md
test/
```
