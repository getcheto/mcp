/**
 * What a **person** may do from a terminal, as tools.
 *
 * The other half of Cheto's machine surface, and it is a different job rather
 * than a bigger version of the same one. An agent participates in the work: it
 * reads its inbox, takes a task, comments, asks for a review. It deliberately
 * cannot redraw the board everybody is standing on — `WorkAreaPolicy` refuses
 * every agent, and that rule is not going to be relaxed because a script found
 * it inconvenient.
 *
 * So the tools that *do* redraw it run on a human credential (`cheto_ut_…`, from
 * `cheto login`) and are here, separate. The server picks the set from the token,
 * because a token is the one thing that cannot be argued with.
 *
 * What they cover is the administrative half of Cheto: the boards and their
 * columns, and the agents — creating one, giving it a place to work, saying what
 * it is for and which board its work lands on, arming a machine for it and
 * disarming one. Everything a person does in the panel to set the place up, as
 * against the work that then happens in it.
 *
 * The job that made it worth building is **importing**: eighty projects from
 * another tracker, each with its own sections, is eighty boards and four hundred
 * columns — a day of clicking in the panel, or a loop from here. Setting up a
 * fleet of agents has the same shape.
 *
 * Two things are deliberately absent, and they are the same two the panel is
 * careful about. **There is no tool to act as an agent**: one credential is one
 * identity, and a person's token writing under an agent's name would make every
 * author line a guess. And **nothing here touches an account** — no passwords,
 * no roles, no invitations, no deletions.
 *
 * What a credential may do beyond that is not decided here at all. It is the
 * person's own authority, checked by the same policies the panel uses: an agent
 * is administered by whoever owns it, and a token belonging to somebody who owns
 * none of them can list boards and file work and nothing else.
 */
export const HUMAN_TOOLS = [
    {
        name: 'cheto_whoami',
        description:
            'Who this credential is, what it was granted, and which workspaces it reaches. Call it once at the start: every other tool needs a workspace, and this is where the names come from. If a tool is refused for a missing scope, the answer is here — the token was minted before that scope existed and `cheto login` is what fixes it.',
        inputSchema: { type: 'object', properties: {} },
        run: (cheto) => cheto.call('/me'),
    },
    {
        name: 'cheto_areas',
        description:
            'The boards of one workspace, each with its columns in order. Call it before creating anything: an import that runs twice should find the board it made last time rather than make a second one with the same name.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid. cheto_whoami lists them.' },
                archived: { type: 'boolean', description: 'Include boards that were put away. Default false.' },
            },
        },
        run: (cheto, { workspace, archived = false }) => {
            const query = new URLSearchParams({ workspace: workspaceFor(cheto, workspace) });

            if (archived) {
                query.set('archived', '1');
            }

            return cheto.call(`/areas?${query}`);
        },
    },
    {
        name: 'cheto_tasks',
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
        run: async (cheto, { workspace, area, open = false }) => {
            const named = workspaceFor(cheto, workspace);
            const query = new URLSearchParams({ workspace: named });

            if (!isBlank(area)) {
                const { work_area_id: id } = await placementIn(cheto, named, area, null);

                query.set('area', String(id));
            }

            if (open) {
                query.set('open', '1');
            }

            return cheto.call(`/tasks?${query}`);
        },
    },
    {
        name: 'cheto_area_create',
        description:
            'Create a board, with its own columns. `columns` is the reason this exists: a project imported from another tracker keeps that tracker\'s sections, and without it the board arrives with five defaults nobody there uses. Each column needs `category` — one of inbox, ready, in_progress, review, done — because the words on a board are the team\'s but the meaning is what every rule in Cheto reads, and it is never guessed from the name.',
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
        run: (cheto, { workspace, ...rest }) =>
            cheto.call('/areas', {
                method: 'POST',
                body: { workspace: workspaceFor(cheto, workspace), ...rest },
                idempotencyKey: `mcp-area-${slug(String(rest.name ?? ''))}`,
            }),
    },
    {
        name: 'cheto_area_update',
        description: 'Rename a board, or change what it says about itself. The board is named by uuid or id — cheto_areas has both.',
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
        run: (cheto, { area, ...rest }) => cheto.call(`/areas/${encodeURIComponent(area)}`, { method: 'PATCH', body: rest }),
    },
    {
        name: 'cheto_column_add',
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
        run: (cheto, { area, ...rest }) => cheto.call(`/areas/${encodeURIComponent(area)}/columns`, { method: 'POST', body: rest }),
    },
    {
        name: 'cheto_column_update',
        description:
            'Rename a column, or change what it means. Changing `category` moves every task in it, because the category IS the task\'s state. Sending an empty name puts a default column back to being drawn in the reader\'s own language.',
        inputSchema: {
            type: 'object',
            properties: {
                area: { type: 'string', description: 'Board uuid or id.' },
                column: { type: 'number', description: 'Column id, from cheto_areas.' },
                name: { type: 'string' },
                category: { type: 'string', enum: ['inbox', 'ready', 'in_progress', 'review', 'done'] },
            },
            required: ['area', 'column'],
        },
        run: (cheto, { area, column, ...rest }) =>
            cheto.call(`/areas/${encodeURIComponent(area)}/columns/${column}`, { method: 'PATCH', body: rest }),
    },
    {
        name: 'cheto_columns_reorder',
        description: 'Put the columns of a board in this order, left to right. Ids you leave out keep the positions they had.',
        inputSchema: {
            type: 'object',
            properties: {
                area: { type: 'string', description: 'Board uuid or id.' },
                order: { type: 'array', items: { type: 'number' }, description: 'Column ids, in the order they should appear.' },
            },
            required: ['area', 'order'],
        },
        run: (cheto, { area, order }) => cheto.call(`/areas/${encodeURIComponent(area)}/columns`, { method: 'PUT', body: { order } }),
    },
    {
        name: 'cheto_column_remove',
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
        run: (cheto, { area, column, into }) =>
            cheto.call(`/areas/${encodeURIComponent(area)}/columns/${column}`, { method: 'DELETE', body: { into } }),
    },
    {
        name: 'cheto_agents',
        description:
            'The agents you own: what each one is called in each workspace, its charter, its board, and which machines are armed for it. The administrative view — somebody else\'s agent is not yours to administer and is not here.',
        inputSchema: { type: 'object', properties: {} },
        run: (cheto) => cheto.call('/agents'),
    },
    {
        name: 'cheto_agent_create',
        description:
            'Create an agent and, with `workspace`, give it a place to work in one call. The handle is what people type to mention it there and is derived from the name when you leave it out; the charter is its job **in that workspace**, because the same agent does something else in another.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                description: { type: 'string', description: "What it is, everywhere. Not its job here — that is the charter." },
                workspace: { type: 'string', description: 'Workspace slug or uuid. Without it the agent exists and works nowhere.' },
                handle: { type: 'string', description: 'What it answers to there, without the @.' },
                charter: { type: 'string', description: 'Its job in that workspace, in words. Worth writing: it is what the runtime is told it is for.' },
            },
            required: ['name'],
        },
        run: (cheto, { workspace, ...rest }) =>
            cheto.call('/agents', {
                method: 'POST',
                body: { ...rest, ...(isBlank(workspace) ? {} : { workspace: workspaceFor(cheto, workspace) }) },
                idempotencyKey: `mcp-agent-${slug(String(rest.name ?? ''))}`,
            }),
    },
    {
        name: 'cheto_agent_update',
        description:
            'Change an agent. `name` and `description` follow it into every workspace; `handle`, `charter` and `area` belong to the one you name and change nothing elsewhere. `area` is the board its work lands on when it does not say — a default, not a fence — and `area: "none"` clears it.',
        inputSchema: {
            type: 'object',
            properties: {
                agent: { type: 'number', description: 'Agent id, from cheto_agents.' },
                name: { type: 'string' },
                description: { type: 'string' },
                workspace: { type: 'string', description: 'Required to change handle, charter or area: they belong to one workspace.' },
                handle: { type: 'string' },
                charter: { type: 'string' },
                area: { type: 'string', description: 'Board uuid or id, or "none" to clear it. cheto_areas lists them.' },
            },
            required: ['agent'],
        },
        run: (cheto, { agent, workspace, area, ...rest }) => {
            const body = { ...rest };

            if (!isBlank(workspace)) {
                body.workspace = workspaceFor(cheto, workspace);
            }

            // Present-and-null is how "no board of its own" is said, so "none"
            // has to survive as a value rather than be dropped as empty.
            if (area !== undefined) {
                body.area = ['none', 'null', ''].includes(String(area).trim().toLowerCase()) ? null : String(area).trim();
            }

            return cheto.call(`/agents/${agent}`, { method: 'PATCH', body });
        },
    },
    {
        name: 'cheto_agent_join',
        description: 'Put an agent you own into another workspace. It keeps its identity and gets a handle and a charter there — the same agent is @qa on one project and @kalel on another.',
        inputSchema: {
            type: 'object',
            properties: {
                agent: { type: 'number' },
                workspace: { type: 'string' },
                handle: { type: 'string' },
                charter: { type: 'string' },
            },
            required: ['agent', 'workspace'],
        },
        run: (cheto, { agent, workspace, ...rest }) =>
            cheto.call(`/agents/${agent}/memberships`, { method: 'POST', body: { workspace: workspaceFor(cheto, workspace), ...rest } }),
    },
    {
        name: 'cheto_agent_pair',
        description:
            'A pairing code for a machine to redeem with `cheto connect`. Single-use, fifteen minutes, and the **better** way to arm a runtime that has a terminal: what you hand over is worthless the moment the machine has connected. Use cheto_agent_token instead only where no terminal exists.',
        inputSchema: {
            type: 'object',
            properties: { membership: { type: 'number', description: 'Membership id, from cheto_agents.' } },
            required: ['membership'],
        },
        run: (cheto, { membership }) => cheto.call(`/memberships/${membership}/pair`, { method: 'POST' }),
    },
    {
        name: 'cheto_agent_token',
        description:
            'A credential for a machine with nowhere to type `cheto connect` — a container, a cron line, another MCP entry that takes a token in an env block. **Shown once and never again**, so whatever is going to hold it should be ready. Prefer cheto_agent_pair where there is a terminal.',
        inputSchema: {
            type: 'object',
            properties: {
                membership: { type: 'number', description: 'Membership id, from cheto_agents.' },
                name: { type: 'string', description: 'What this credential is for, so it can be recognised later and revoked.' },
                expires_in_days: { type: 'number' },
            },
            required: ['membership', 'name'],
        },
        run: (cheto, { membership, ...rest }) => cheto.call(`/memberships/${membership}/credentials`, { method: 'POST', body: rest }),
    },
    {
        name: 'cheto_agent_disconnect',
        description: 'Disarm one machine. The agent and its other machines keep working; the credential that machine holds stops on its next request.',
        inputSchema: {
            type: 'object',
            properties: { connection: { type: 'number', description: 'Connection id, from cheto_agents.' } },
            required: ['connection'],
        },
        run: (cheto, { connection }) => cheto.call(`/connections/${connection}`, { method: 'DELETE' }),
    },
    {
        name: 'cheto_task_create',
        description:
            'Put a task on a board, created by you rather than by an agent. This is the one to use for an import: work brought over from another tracker was written by people, and filing three hundred rows under whichever machine ran the loop is a lie the activity feed then repeats forever. Name the board with `area`, and a specific column with `column` when the board has its own.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid.' },
                title: { type: 'string' },
                description: { type: 'string' },
                area: { type: 'string', description: 'Board name, slug, uuid or id. cheto_areas lists them.' },
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
        run: async (cheto, { workspace, area, column, ...rest }) => {
            const named = workspaceFor(cheto, workspace);
            const body = { workspace: named, ...rest, ...(await placementIn(cheto, named, area, column)) };

            return cheto.call('/tasks', { method: 'POST', body, idempotencyKey: `mcp-task-${slug(String(rest.title ?? ''))}` });
        },
    },
];

/**
 * Which workspace, from the call or from how this server was started.
 *
 * `CHETO_WORKSPACE` is what makes "one MCP entry per workspace" a sensible way to
 * run this: point one at `appsi` and another at `savia`, and neither model has
 * to remember which room it is in. A call that names one wins over it.
 */
function workspaceFor(cheto, named) {
    const workspace = named ?? cheto.workspace;

    if (!workspace || String(workspace).trim() === '') {
        throw new Error(
            'Say which workspace. cheto_whoami lists the ones this credential reaches, or set CHETO_WORKSPACE on the server so every call defaults to one.',
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
async function placementIn(cheto, workspace, area, column) {
    if (isBlank(area)) {
        if (!isBlank(column)) {
            throw new Error('A column belongs to a board, so `column` needs `area` as well. cheto_areas lists both.');
        }

        return {};
    }

    const { data: areas = [] } = await cheto.call(`/areas?workspace=${encodeURIComponent(workspace)}`);
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
