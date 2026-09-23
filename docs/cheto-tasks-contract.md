# `cheto_tasks` contract

`cheto_tasks` calls `GET /api/v1/agent/tasks` and supports:

- `cursor`: opaque numeric `next_cursor` from the previous response;
- `limit`: 1–100 rows (default 100);
- `status`: `inbox`, `ready`, `in_progress`, `review`, or `done`;
- `created_after`: ISO date/time lower bound (exclusive);
- `count`: include the total matching row count.

Responses contain `data`, optional `next_cursor`, and optional `count`. Results
are newest first and remain scoped to the credential's workspace. Existing
`cheto_inbox` and `cheto_reviews` remain available for actionable work and
pending reviews.

## Capacity status

`cheto_capacity` calls `GET /api/v1/agent/capacity`. It returns workspace-scoped
board rows with `open_tasks`, `in_progress`, `in_review`, and
`unassigned_open`, plus matching totals in `summary`. The response labels these
values `semantics: derived_workload`: Cheto has no configured throughput limit,
lease, or availability budget, so consumers must not treat these counts as a
promise of free capacity.
