/**
 * What a **person** may do from a terminal, as tools.
 *
 * The other half of Knot's machine surface, and it is a different job rather
 * than a bigger version of the same one. An agent participates in the work: it
 * reads its inbox, takes a task, comments, asks for a review. It deliberately
 * cannot redraw the board everybody is standing on — `WorkAreaPolicy` refuses
 * every agent, and that rule is not going to be relaxed because a script found
 * it inconvenient.
 *
 * So the tools that *do* redraw it run on a human credential (`knot_ut_…`, from
 * `knot login`) and are here, separate. The server picks the set from the token,
 * because a token is the one thing that cannot be argued with.
 *
 * The job they exist for is **importing**. Eighty projects from another tracker,
 * each with its own sections, is eighty boards and four hundred columns — a day
 * of clicking in the panel, or a loop from here.
 *
 * Two things are deliberately absent. **There is no tool to act as an agent**:
 * one credential is one identity, and a person's token writing under an agent's
 * name would make every author line a guess. And **nothing here touches an
 * account** — no invites, no roles, no deletions; the panel keeps those.
 */
export const HUMAN_TOOLS = [
    {
        name: 'knot_whoami',
        description:
            'Who this credential is, what it was granted, and which workspaces it reaches. Call it once at the start: every other tool needs a workspace, and this is where the names come from. If a tool is refused for a missing scope, the answer is here — the token was minted before that scope existed and `knot login` is what fixes it.',
        inputSchema: { type: 'object', properties: {} },
        run: (knot) => knot.call('/me'),
    },
    {
        name: 'knot_areas',
        description:
            'The boards of one workspace, each with its columns in order. Call it before creating anything: an import that runs twice should find the board it made last time rather than make a second one with the same name.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid. knot_whoami lists them.' },
                archived: { type: 'boolean', description: 'Include boards that were put away. Default false.' },
            },
        },
        run: (knot, { workspace, archived = false }) => {
            const query = new URLSearchParams({ workspace: workspaceFor(knot, workspace) });

            if (archived) {
                query.set('archived', '1');
            }

            return knot.call(`/areas?${query}`);
        },
    },
    {
        name: 'knot_tasks',
        description:
            'The work already in a workspace, or on one board of it. Call it before importing anything: a run that cannot see what the last run wrote is a run that writes it all again. At most 200, newest first.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid.' },
                area: { type: 'string', description: 'One board only, by name, slug, uuid or id.' },
                open: { type: 'boolean', description: 'Only unfinished work. Default false — an import wants to see everything.' },
            },
        },
        run: async (knot, { workspace, area, open = false }) => {
            const named = workspaceFor(knot, workspace);
            const query = new URLSearchParams({ workspace: named });

            if (!isBlank(area)) {
                const { work_area_id: id } = await placementIn(knot, named, area, null);

                query.set('area', String(id));
            }

            if (open) {
                query.set('open', '1');
            }

            return knot.call(`/tasks?${query}`);
        },
    },
    {
        name: 'knot_area_create',
        description:
            'Create a board, with its own columns. `columns` is the reason this exists: a project imported from another tracker keeps that tracker\'s sections, and without it the board arrives with five defaults nobody there uses. Each column needs `category` — one of inbox, ready, in_progress, review, done — because the words on a board are the team\'s but the meaning is what every rule in Knot reads, and it is never guessed from the name.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid.' },
                name: { type: 'string' },
                description: { type: 'string' },
                color: { type: 'string' },
                icon: { type: 'string' },
                columns: {
                    type: 'array',
                    description: 'Left to right. Omit for the five defaults.',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            category: { type: 'string', enum: ['inbox', 'ready', 'in_progress', 'review', 'done'] },
                        },
                        required: ['name', 'category'],
                    },
                },
            },
            required: ['name'],
        },
        run: (knot, { workspace, ...rest }) =>
            knot.call('/areas', {
                method: 'POST',
                body: { workspace: workspaceFor(knot, workspace), ...rest },
                idempotencyKey: `mcp-area-${slug(String(rest.name ?? ''))}`,
            }),
    },
    {
        name: 'knot_area_update',
        description: 'Rename a board, or change what it says about itself. The board is named by uuid or id — knot_areas has both.',
        inputSchema: {
            type: 'object',
            properties: {
                area: { type: 'string', description: 'Board uuid or id.' },
                name: { type: 'string' },
                description: { type: 'string' },
                color: { type: 'string' },
                icon: { type: 'string' },
            },
            required: ['area'],
        },
        run: (knot, { area, ...rest }) => knot.call(`/areas/${encodeURIComponent(area)}`, { method: 'PATCH', body: rest }),
    },
    {
        name: 'knot_column_add',
        description:
            'Add a column to a board. `category` says which of the five states it means and is required: "Blocked" could reasonably be in progress or waiting on somebody else, and the rule that stops an agent closing its own work reads the category rather than the word.',
        inputSchema: {
            type: 'object',
            properties: {
                area: { type: 'string', description: 'Board uuid or id.' },
                name: { type: 'string' },
                category: { type: 'string', enum: ['inbox', 'ready', 'in_progress', 'review', 'done'] },
            },
            required: ['area', 'name', 'category'],
        },
        run: (knot, { area, ...rest }) => knot.call(`/areas/${encodeURIComponent(area)}/columns`, { method: 'POST', body: rest }),
    },
    {
        name: 'knot_column_update',
        description:
            'Rename a column, or change what it means. Changing `category` moves every task in it, because the category IS the task\'s state. Sending an empty name puts a default column back to being drawn in the reader\'s own language.',
        inputSchema: {
            type: 'object',
            properties: {
                area: { type: 'string', description: 'Board uuid or id.' },
                column: { type: 'number', description: 'Column id, from knot_areas.' },
                name: { type: 'string' },
                category: { type: 'string', enum: ['inbox', 'ready', 'in_progress', 'review', 'done'] },
            },
            required: ['area', 'column'],
        },
        run: (knot, { area, column, ...rest }) =>
            knot.call(`/areas/${encodeURIComponent(area)}/columns/${column}`, { method: 'PATCH', body: rest }),
    },
    {
        name: 'knot_columns_reorder',
        description: 'Put the columns of a board in this order, left to right. Ids you leave out keep the positions they had.',
        inputSchema: {
            type: 'object',
            properties: {
                area: { type: 'string', description: 'Board uuid or id.' },
                order: { type: 'array', items: { type: 'number' }, description: 'Column ids, in the order they should appear.' },
            },
            required: ['area', 'order'],
        },
        run: (knot, { area, order }) => knot.call(`/areas/${encodeURIComponent(area)}/columns`, { method: 'PUT', body: { order } }),
    },
    {
        name: 'knot_column_remove',
        description:
            'Remove a column and move its work into another one. `into` is required: the only thing worse than work disappearing off a board is work moving somewhere nobody was told about. A board cannot lose its last column.',
        inputSchema: {
            type: 'object',
            properties: {
                area: { type: 'string', description: 'Board uuid or id.' },
                column: { type: 'number' },
                into: { type: 'number', description: 'The column its tasks go to.' },
            },
            required: ['area', 'column', 'into'],
        },
        run: (knot, { area, column, into }) =>
            knot.call(`/areas/${encodeURIComponent(area)}/columns/${column}`, { method: 'DELETE', body: { into } }),
    },
    {
        name: 'knot_task_create',
        description:
            'Put a task on a board, created by you rather than by an agent. This is the one to use for an import: work brought over from another tracker was written by people, and filing three hundred rows under whichever machine ran the loop is a lie the activity feed then repeats forever. Name the board with `area`, and a specific column with `column` when the board has its own.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid.' },
                title: { type: 'string' },
                description: { type: 'string' },
                area: { type: 'string', description: 'Board name, slug, uuid or id. knot_areas lists them.' },
                column: { type: 'string', description: 'A column of that board, by name or key. Decides the status, so do not send both.' },
                status: { type: 'string', enum: ['inbox', 'ready', 'in_progress', 'review', 'done'] },
                type: { type: 'string', enum: ['task', 'feature', 'bug', 'chore', 'epic', 'idea'] },
                priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
                tags: { type: 'array', items: { type: 'string' } },
                due_on: { type: 'string', description: 'A date, YYYY-MM-DD. Nothing else parses.' },
                requires_human: { type: 'boolean' },
            },
            required: ['title'],
        },
        run: async (knot, { workspace, area, column, ...rest }) => {
            const named = workspaceFor(knot, workspace);
            const body = { workspace: named, ...rest, ...(await placementIn(knot, named, area, column)) };

            return knot.call('/tasks', { method: 'POST', body, idempotencyKey: `mcp-task-${slug(String(rest.title ?? ''))}` });
        },
    },
];

/**
 * Which workspace, from the call or from how this server was started.
 *
 * `KNOT_WORKSPACE` is what makes "one MCP entry per workspace" a sensible way to
 * run this: point one at `appsi` and another at `savia`, and neither model has
 * to remember which room it is in. A call that names one wins over it.
 */
function workspaceFor(knot, named) {
    const workspace = named ?? knot.workspace;

    if (!workspace || String(workspace).trim() === '') {
        throw new Error(
            'Say which workspace. knot_whoami lists the ones this credential reaches, or set KNOT_WORKSPACE on the server so every call defaults to one.',
        );
    }

    return String(workspace).trim();
}

/**
 * A board and one of its columns, as the ids the API takes.
 *
 * Resolved against what this credential can actually see, and a name we cannot
 * find **fails** rather than falling back. Falling back is precisely the bug
 * this surface was built after: an id the server did not recognise used to put
 * the task on the first board instead, and three hundred rows landed in the
 * wrong place without anybody noticing.
 */
async function placementIn(knot, workspace, area, column) {
    if (isBlank(area)) {
        if (!isBlank(column)) {
            throw new Error('A column belongs to a board, so `column` needs `area` as well. knot_areas lists both.');
        }

        return {};
    }

    const { data: areas = [] } = await knot.call(`/areas?workspace=${encodeURIComponent(workspace)}`);
    const wanted = String(area).trim().toLowerCase();

    const board =
        areas.find((candidate) => String(candidate.id) === wanted) ??
        areas.find((candidate) => String(candidate.uuid ?? '').toLowerCase() === wanted) ??
        areas.find((candidate) => String(candidate.slug ?? '').toLowerCase() === wanted) ??
        areas.find((candidate) => String(candidate.name ?? '').toLowerCase() === wanted);

    if (!board) {
        throw new Error(
            `"${workspace}" has no board called "${area}". It has: ${areas.map((candidate) => `${candidate.name} (${candidate.slug})`).join(', ') || 'none'}.`,
        );
    }

    if (isBlank(column)) {
        return { work_area_id: board.id };
    }

    const named = String(column).trim().toLowerCase();
    const match = (board.statuses ?? []).find(
        (candidate) => String(candidate.name ?? '').toLowerCase() === named || String(candidate.key ?? '').toLowerCase() === named,
    );

    if (!match) {
        throw new Error(`"${board.name}" has no column called "${column}". It has: ${(board.statuses ?? []).map((one) => one.name).join(', ')}.`);
    }

    // The column alone: it names its own board, and sending both is two chances
    // to disagree — which the server refuses rather than guesses at.
    return { work_area_status_id: match.id };
}

function isBlank(value) {
    return value === undefined || value === null || String(value).trim() === '';
}

function slug(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
}
