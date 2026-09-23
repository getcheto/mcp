/**
 * What a **person** may do from a terminal, as tools.
 *
 * The other half of Cheto's machine surface. A person's credential
 * (`cheto_ut_…`, from `cheto login`) reaches `/api/v1/cli`, and everything
 * here is the person acting under their own name: the administrative half —
 * boards and their columns, the agents, arming and disarming machines — and,
 * since the person is a participant like any other, the work itself: reading a
 * task whole, filing, editing, moving, assigning, scheduling (`due_on`),
 * deleting, commenting, reviews, channels, memory and search.
 *
 * An agent can now do most of the same on its own surface, as far as its
 * membership's capabilities say (`tasks.edit_any`, `boards.manage`, …, all on
 * by default and set by its owner with cheto_agent_update). What stays the
 * person's alone is administering agents and machines, and closing work: an
 * agent is refused `done` always, a person is not.
 *
 * The job that made the board tools worth building is **importing**: eighty
 * projects from another tracker, each with its own sections, is eighty boards
 * and four hundred columns — a day of clicking in the panel, or a loop from
 * here. Work brought over that way was written by people, so it is filed under
 * the person rather than under whichever machine ran the loop.
 *
 * Acting as one of the person's own agents is not in this file. The same token
 * can do it — the work tools in tools.js, each run with a required `agent`, on
 * the agent surface, where the server checks that the agent is the person's own
 * and attributes the work to it and records the person beside it (toolset.js).
 * Nothing here writes under an agent's name, and nothing there writes under the
 * person's. **Nothing here touches an account** — no passwords, no roles, no
 * invitations, no deleting a person. Removing a task is
 * not that: it is a card off a board, soft-deleted, and something the same
 * person does in the panel with one click.
 *
 * What a credential may do beyond that is not decided here at all. It is the
 * person's own authority, checked by the same policies the panel uses: an agent
 * is administered by whoever owns it, and a token belonging to somebody who owns
 * none of them can list boards and file work and nothing else.
 */
import { CAPABILITIES, SEARCH_KIND, searchQuery } from './tools.js';

/** What an agent's membership may be allowed to do. Mirrors App\\Enums\\AgentCapability. */
const CAPABILITY_VALUES = Object.keys(CAPABILITIES);

/**
 * Who holds a task, the two ways a person can say it.
 *
 * The person's surface has no participant list: it can name the person and
 * the person's own agents, which is what `assignee` resolves. Anybody else —
 * a colleague, somebody else's agent — is `assignee_type` and `assignee_id`,
 * with the id read off a task (its creator and assignee carry one) or a
 * channel message's author.
 */
const ASSIGNEE_PROPERTIES = {
    assignee: {
        type: ['string', 'null'],
        description:
            '"me", or one of your own agents by @handle, Cheto address or name (cheto_agents lists them). null unassigns. For anybody else use assignee_type and assignee_id.',
    },
    assignee_type: { type: ['string', 'null'], enum: ['user', 'agent', null], description: 'With assignee_id, for a participant `assignee` cannot name.' },
    assignee_id: { type: ['number', 'null'], description: 'The participant\'s id, from a task\'s creator or assignee, or a message\'s author.' },
};

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
            'The agents you own: each one\'s Cheto address, what it is called in each workspace, its charter, its board, and which machines are armed for it. `act_as` is the short answer to "which id do I pass": the value for `agent` on the agent tools — the address, or the @handle in a workspace — and the workspace each handle belongs to. Somebody else\'s agent is not yours to administer or act as, and is not here.',
        inputSchema: { type: 'object', properties: {} },
        run: async (cheto) => withActAs(await cheto.call('/agents')),
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
            'Change an agent. `name` and `description` follow it into every workspace; `handle`, `charter`, `area` and `capabilities` belong to one workspace (`workspace`, or CHETO_WORKSPACE) and change nothing elsewhere. `area` is the board its work lands on when it does not say — a default, not a fence — and `area: "none"` clears it. `capabilities` is what it may do there: any of tasks.create, tasks.edit_any, tasks.delete, boards.manage, channels.post, memory.write — the complete set, replacing the current one — or null for the defaults (all of them). Closing work is never among them.',
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
                capabilities: {
                    type: ['array', 'null'],
                    items: { type: 'string', enum: CAPABILITY_VALUES },
                    description: 'The complete set it may do in that workspace, or null to go back to the defaults (all six).',
                },
            },
            required: ['agent'],
        },
        run: (cheto, { agent, workspace, area, capabilities, ...rest }) => {
            const body = { ...rest };
            const perWorkspace = ['handle', 'charter'].some((field) => !isBlank(rest[field])) || area !== undefined || capabilities !== undefined;

            if (!isBlank(workspace) || perWorkspace) {
                body.workspace = workspaceFor(cheto, workspace);
            }

            if (capabilities !== undefined) {
                body.capabilities = capabilities === null || ['default', 'defaults'].includes(String(capabilities).trim().toLowerCase()) ? null : [].concat(capabilities);
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
                due_on: { type: 'string', description: 'When it is due, YYYY-MM-DD — how work is scheduled. Nothing else parses.' },
                requires_human: { type: 'boolean' },
                ...ASSIGNEE_PROPERTIES,
            },
            required: ['title'],
        },
        run: async (cheto, { workspace, area, column, assignee, assignee_type: type, assignee_id: id, ...rest }) => {
            const named = workspaceFor(cheto, workspace);
            const who = await actorFields(cheto, named, { who: assignee, type, id }, { explicit: false });
            const body = { workspace: named, ...rest, ...who, ...(await placementIn(cheto, named, area, column)) };

            return cheto.call('/tasks', { method: 'POST', body, idempotencyKey: `mcp-task-${slug(String(rest.title ?? ''))}` });
        },
    },
    {
        name: 'cheto_task_update',
        description:
            'Change a task as you, the person: what it says about itself — title, description, type, priority, due date (`due_on`: scheduling it), tags, requires_human — which column it sits in, and who holds it. `column` moves the card by the name the board shows; `assignee` hands it to "me" or one of your agents by @handle or address, and null unassigns. This is the tool for triage: sorting a backlog somebody else filled. `tags` REPLACES the whole set.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid.' },
                id: {
                    type: ['number', 'string'],
                    description: 'The task\'s number, which cheto_tasks returns as `id`. Not the "TASK-402" key a board prints on the card.',
                },
                title: { type: 'string' },
                description: { type: 'string' },
                type: { type: 'string', enum: ['task', 'feature', 'bug', 'chore', 'epic', 'idea'] },
                priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
                status: { type: 'string', enum: ['inbox', 'ready', 'in_progress', 'review', 'done'] },
                column: {
                    type: ['string', 'number'],
                    description:
                        'Move it to this column, by name, key or id. Preferred over `status`: a column names where the card actually goes, while a status leaves the choice to the server. `area` is only needed when two boards of this workspace have a column by the same name.',
                },
                area: { type: 'string', description: 'Which board `column` belongs to, when the name alone is ambiguous.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'The complete set, replacing whatever is there.' },
                due_on: { type: ['string', 'null'], description: 'When it is due, YYYY-MM-DD, or null to clear it.' },
                requires_human: { type: 'boolean' },
                ...ASSIGNEE_PROPERTIES,
            },
            required: ['id'],
        },
        run: async (cheto, { workspace, id, area, column, assignee, assignee_type: type, assignee_id: who, ...rest }) => {
            const named = workspaceFor(cheto, workspace);
            const task = taskRef(id);
            const assignment = await actorFields(cheto, named, { who: assignee, type, id: who }, { explicit: true });
            const placement = await columnFor(cheto, named, area, column);
            const body = { ...rest, ...assignment, ...placement };

            if (Object.keys(body).length === 0) {
                throw new Error('Nothing to change. Besides `id` this needs at least one thing to say: a column, a status, or something the task says about itself.');
            }

            // The column wins over a status when both arrive, so only one goes
            // out: two ways of naming the same move is two chances to disagree.
            if (placement.work_area_status_id !== undefined) {
                delete body.status;
            }

            return cheto.call(`/tasks/${task}`, { method: 'PATCH', body, idempotencyKey: `mcp-update-${task}-${slug(JSON.stringify(body))}` });
        },
    },
    {
        name: 'cheto_task_delete',
        description:
            'Take a task off the board for good. The counterpart of triage: a backlog where ideas can only ever be added fills up, and one nobody can clear stops being a backlog. It is a soft delete — the activity trail can still name what it refers to — but it does not come back through this API, so prefer moving a card to a column that means "discarded" when the team has one. Acts as you; an agent can do the same with its own tool only when its membership has the tasks.delete capability.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid.' },
                id: { type: ['number', 'string'], description: 'The task\'s number, as cheto_tasks returns it.' },
            },
            required: ['id'],
        },
        run: async (cheto, { workspace, id }) => {
            workspaceFor(cheto, workspace);

            return cheto.call(`/tasks/${taskRef(id)}`, { method: 'DELETE' });
        },
    },
    {
        name: 'cheto_task',
        description: 'One task in full, as you see it: where it sits, who holds it, its due date, its comments and its reviews. The ids of its creator and assignee are what assignee_id and reviewer_id take for somebody `assignee` cannot name.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: ['number', 'string'], description: 'The task\'s number, as cheto_tasks returns it.' } },
            required: ['id'],
        },
        run: (cheto, { id }) => cheto.call(`/tasks/${taskRef(id)}`),
    },
    {
        name: 'cheto_task_comment',
        description: 'Say something on a task, as you. Commenting does not move it.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: ['number', 'string'] }, body: { type: 'string' } },
            required: ['id', 'body'],
        },
        run: (cheto, { id, body }) =>
            cheto.call(`/tasks/${taskRef(id)}/comments`, { method: 'POST', body: { body }, idempotencyKey: `mcp-comment-${taskRef(id)}-${slug(String(body ?? ''))}` }),
    },
    {
        name: 'cheto_inbox',
        description:
            'What is waiting on you, the person: open tasks you hold, reviews you owe, and how many notifications are unread. In one workspace, or every one this credential reaches when none is named. Reading marks nothing read.',
        inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace slug or uuid. Defaults to CHETO_WORKSPACE, then to all.' } } },
        run: (cheto, { workspace }) => cheto.call(`/inbox${scopedQuery(cheto, workspace)}`),
    },
    {
        name: 'cheto_reviews',
        description: 'Reviews waiting on your answer, each with the task it is about. cheto_review_answer answers one.',
        inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace slug or uuid. Defaults to CHETO_WORKSPACE, then to all.' } } },
        run: (cheto, { workspace }) => cheto.call(`/reviews${scopedQuery(cheto, workspace)}`),
    },
    {
        name: 'cheto_review_request',
        description:
            'Ask somebody to look at a task, as you. Name the reviewer with `reviewer` — "me" or one of your agents — or with reviewer_type and reviewer_id for anybody else (ids from cheto_task).',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid, for resolving `reviewer` by handle.' },
                task_id: { type: ['number', 'string'] },
                reviewer: { type: 'string', description: '"me", or one of your agents by @handle, address or name.' },
                reviewer_type: { type: 'string', enum: ['user', 'agent'] },
                reviewer_id: { type: 'number' },
                note: { type: 'string' },
            },
            required: ['task_id'],
        },
        run: async (cheto, { workspace, task_id: taskId, reviewer, reviewer_type: type, reviewer_id: id, note }) => {
            if (isBlank(reviewer) && (isBlank(type) || isBlank(id))) {
                throw new Error('Say who reviews it: `reviewer` ("me" or one of your agents), or reviewer_type with reviewer_id. Nothing was sent.');
            }

            const who = isBlank(reviewer) ? { assignee_type: type, assignee_id: Number(id) } : await actorFields(cheto, workspace ?? cheto.workspace, { who: reviewer });
            const task = taskRef(taskId);

            return cheto.call(`/tasks/${task}/reviews`, {
                method: 'POST',
                body: { reviewer_type: who.assignee_type, reviewer_id: who.assignee_id, ...(isBlank(note) ? {} : { note }) },
                idempotencyKey: `mcp-review-${task}-${who.assignee_type}-${who.assignee_id}`,
            });
        },
    },
    {
        name: 'cheto_review_answer',
        description: 'Answer a review asked of you: approved, or changes_requested. Only the named reviewer may answer, and only once.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: 'The review id, from cheto_reviews or cheto_inbox.' },
                status: { type: 'string', enum: ['approved', 'changes_requested'] },
                note: { type: 'string' },
            },
            required: ['id', 'status'],
        },
        run: (cheto, { id, ...rest }) => cheto.call(`/reviews/${Number(id)}`, { method: 'PATCH', body: rest, idempotencyKey: `mcp-answer-${Number(id)}` }),
    },
    {
        name: 'cheto_channels',
        description: 'The channels of a workspace.',
        inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace slug or uuid.' } } },
        run: (cheto, { workspace }) => cheto.call(`/channels?workspace=${encodeURIComponent(workspaceFor(cheto, workspace))}`),
    },
    {
        name: 'cheto_channel_read',
        description:
            'What is being said in a channel, bounded: the last folded summaries plus the messages after them, an amount that does not grow with the channel. cheto_search reaches further back.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid; needed to find a channel by name.' },
                channel: { type: ['string', 'number'], description: 'Channel id, slug or name. cheto_channels lists them.' },
            },
            required: ['channel'],
        },
        run: async (cheto, { workspace, channel }) => cheto.call(`/channels/${await channelRef(cheto, workspace, channel)}/context`),
    },
    {
        name: 'cheto_channel_post',
        description: 'Say something in a channel, as you. Write @handle to name somebody. `parent_id` answers a message in its thread.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid; needed to find a channel by name.' },
                channel: { type: ['string', 'number'], description: 'Channel id, slug or name.' },
                body: { type: 'string' },
                parent_id: { type: 'number' },
            },
            required: ['channel', 'body'],
        },
        run: async (cheto, { workspace, channel, body, parent_id: parent }) => {
            const id = await channelRef(cheto, workspace, channel);

            return cheto.call(`/channels/${id}/messages`, {
                method: 'POST',
                body: { body, ...(isBlank(parent) ? {} : { parent_id: Number(parent) }) },
                idempotencyKey: `mcp-post-${id}-${slug(String(body ?? ''))}`,
            });
        },
    },
    {
        name: 'cheto_memory',
        description: 'What a workspace worked out, as against what it said. Read it before asking a question somebody already answered. Each entry has the `id` cheto_memory_update and cheto_memory_forget take.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid.' },
                key: { type: 'string' },
                q: { type: 'string', description: 'Only entries whose title or body contains this.' },
                limit: { type: 'number', minimum: 1, maximum: 100 },
            },
        },
        run: (cheto, { workspace, key, q, limit }) => {
            const query = new URLSearchParams({ workspace: workspaceFor(cheto, workspace) });

            for (const [name, value] of Object.entries({ key, q, limit })) {
                if (!isBlank(value)) {
                    query.set(name, String(value));
                }
            }

            return cheto.call(`/memory?${query}`);
        },
    },
    {
        name: 'cheto_memory_write',
        description: 'Write something down for the workspace, as you. `key` makes it addressable by name later.',
        inputSchema: {
            type: 'object',
            properties: { workspace: { type: 'string', description: 'Workspace slug or uuid.' }, title: { type: 'string' }, body: { type: 'string' }, key: { type: 'string' } },
            required: ['title', 'body'],
        },
        run: (cheto, { workspace, ...rest }) =>
            cheto.call('/memory', {
                method: 'POST',
                body: { workspace: workspaceFor(cheto, workspace), ...rest },
                idempotencyKey: `mcp-memory-${slug(String(rest.key ?? rest.title ?? ''))}`,
            }),
    },
    {
        name: 'cheto_memory_update',
        description: 'Correct a memory entry: its title, body or key. Changes only what you send.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'number' }, title: { type: 'string' }, body: { type: 'string' }, key: { type: ['string', 'null'] } },
            required: ['id'],
        },
        run: (cheto, { id, ...rest }) => {
            if (Object.keys(rest).length === 0) {
                throw new Error('Nothing to change. Send a title, a body or a key along with `id`.');
            }

            return cheto.call(`/memory/${Number(id)}`, { method: 'PATCH', body: rest });
        },
    },
    {
        name: 'cheto_memory_forget',
        description: 'Remove a memory entry that has become wrong. Prefer cheto_memory_update when it only needs correcting.',
        inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        run: (cheto, { id }) => cheto.call(`/memory/${Number(id)}`, { method: 'DELETE' }),
    },
    {
        name: 'cheto_search',
        description: 'Search a workspace: messages, tasks, comments, folded summaries and memory — everything older than a bounded read.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: { type: 'string', description: 'Workspace slug or uuid.' },
                q: { type: 'string', description: 'At least two characters.' },
                kind: { ...SEARCH_KIND, description: 'Only these kinds. One, or a list.' },
                limit: { type: 'number', minimum: 1, maximum: 50 },
            },
            required: ['q'],
        },
        run: (cheto, { workspace, q, kind, limit }) => cheto.call(`/search?${searchQuery({ workspace: workspaceFor(cheto, workspace), q, kind, limit })}`),
    },
];

/**
 * `?workspace=` for the reads that may span every workspace: the one named,
 * else the server's default, else nothing — which the server reads as all of
 * them.
 */
function scopedQuery(cheto, named) {
    const workspace = isBlank(named) ? cheto.workspace : named;

    return isBlank(workspace) ? '' : `?workspace=${encodeURIComponent(String(workspace).trim())}`;
}

/**
 * A channel as the id the person's surface takes.
 *
 * A number goes straight through. A slug or a name is looked up in the one
 * workspace named: a slug is unique only inside a workspace, and a person
 * reaches several, so sending it bare would reach whichever matched first.
 */
async function channelRef(cheto, workspace, channel) {
    const raw = String(channel ?? '').trim();

    if (/^\d+$/.test(raw)) {
        return Number(raw);
    }

    const named = workspaceFor(cheto, workspace);
    const { data: channels = [] } = await cheto.call(`/channels?workspace=${encodeURIComponent(named)}`);
    const wanted = raw.replace(/^#/, '').toLowerCase();
    const match =
        channels.find((one) => String(one.slug ?? '').toLowerCase() === wanted) ?? channels.find((one) => String(one.name ?? '').toLowerCase() === wanted);

    if (!match) {
        throw new Error(`"${named}" has no channel called "${channel}". It has: ${channels.map((one) => one.slug ?? one.name).join(', ') || 'none'}.`);
    }

    return match.id;
}

/**
 * A participant, as the `{assignee_type, assignee_id}` pair the API takes.
 *
 * `who` is "me" (resolved through /me) or one of the person's own agents —
 * by Cheto address, by @handle in the workspace named, or by name — resolved
 * through /agents, which lists exactly the agents this token may name. There
 * is no participant list on this surface, so anybody else is `type` + `id`,
 * passed through as given.
 *
 * `explicit` separates "unassign" from "leave it alone", as on the agent side:
 * a null `assignee` on an update means nobody; on a create, nothing asked.
 */
async function actorFields(cheto, workspace, { who, type, id } = {}, { explicit = false } = {}) {
    if (who !== undefined && type !== undefined) {
        throw new Error('Name the assignee one way: `assignee`, or assignee_type with assignee_id. Not both.');
    }

    if (type !== undefined) {
        return type === null ? { assignee_type: null, assignee_id: null } : { assignee_type: type, assignee_id: Number(id) };
    }

    if (who === undefined || (who === null && !explicit)) {
        return {};
    }

    if (who === null || String(who).trim() === '') {
        return { assignee_type: null, assignee_id: null };
    }

    const raw = String(who).trim();

    if (['me', '@me'].includes(raw.toLowerCase())) {
        const { user } = await cheto.call('/me');

        return { assignee_type: 'user', assignee_id: user.id };
    }

    const wanted = raw.replace(/^@/, '').toLowerCase();
    const where = isBlank(workspace) ? null : String(workspace).trim().toLowerCase();
    const { data: agents = [] } = await cheto.call('/agents');

    const inWorkspace = (membership) =>
        where === null || [membership.workspace?.uuid, membership.workspace?.slug, membership.workspace?.id].some((field) => String(field ?? '').toLowerCase() === where);

    const match =
        agents.find((agent) => String(agent.address ?? '').toLowerCase() === wanted) ??
        agents.find((agent) => (agent.memberships ?? []).some((membership) => String(membership.handle ?? '').toLowerCase() === wanted && inWorkspace(membership))) ??
        agents.find((agent) => String(agent.slug ?? '').toLowerCase() === wanted || String(agent.name ?? '').toLowerCase() === wanted);

    if (!match) {
        throw new Error(
            `"${who}" is not you or one of your agents${where ? ` in "${workspace}"` : ''}. Yours are: ${agents.map((agent) => agent.address ?? agent.name).join(', ') || 'none'}. For anybody else pass assignee_type and assignee_id (reviewer_type and reviewer_id for a review), with the id from cheto_task.`,
        );
    }

    return { assignee_type: 'agent', assignee_id: match.id };
}

/**
 * The agent list, with the one thing an agent reading it is looking for.
 *
 * An agent run on a person's token has to say who it is on every call, and the
 * raw list buries the answer in memberships and connections. `act_as` puts it
 * first: the address, which is unique across Cheto and never ambiguous, and
 * each handle with the workspace it belongs to — a handle alone is ambiguous
 * the moment the agent works in two. The raw list stays, for administering.
 */
function withActAs(answer) {
    const agents = Array.isArray(answer?.data) ? answer.data : [];

    return {
        how_to_act_as:
            'Pass `agent` to an agent tool with the address below (preferred: unique everywhere) or with an @handle. When the agent works in more than one workspace and you name it by handle, pass `workspace` too.',
        act_as: agents.map((agent) => ({
            name: agent.name,
            agent: agent.address ?? null,
            handles: (agent.memberships ?? []).map((membership) => ({
                agent: membership.mention ?? (membership.handle ? `@${membership.handle}` : null),
                workspace: membership.workspace?.uuid ?? membership.workspace?.slug ?? null,
                workspace_name: membership.workspace?.name ?? null,
                workspace_slug: membership.workspace?.slug ?? null,
            })),
        })),
        ...answer,
    };
}

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

/**
 * A task id, and nothing that merely looks like one.
 *
 * The "TASK-402" a card prints is its key, not its id, and a model that sends
 * one gets a sentence saying so rather than a 404 it will retry.
 */
function taskRef(id) {
    const wanted = String(id ?? '').trim();

    if (/^\d+$/.test(wanted)) {
        return Number(wanted);
    }

    throw new Error(
        `"${id}" is not a task id. A task is addressed by its number — the \`id\` cheto_tasks returns — never by the "${wanted || 'TASK-402'}" key a board prints on the card, and never by a uuid, which a task does not have.`,
    );
}

/**
 * The column a move names, as the field the API takes.
 *
 * Unlike creating, a move usually does not need to say which board: the card is
 * already on one, and "Aprobadas pendientes" means a single column in almost
 * every workspace. So the board is optional here and the name is resolved
 * across all of them — but an ambiguous name **fails**, naming the boards that
 * matched, rather than picking the first. Guessing is how three hundred rows
 * once landed somewhere nobody asked for, and a move is no safer than a create.
 */
async function columnFor(cheto, workspace, area, column) {
    if (isBlank(column)) {
        return {};
    }

    const { data: areas = [] } = await cheto.call(`/areas?workspace=${encodeURIComponent(workspace)}`);
    const wanted = String(column).trim().toLowerCase();

    const boards = isBlank(area)
        ? areas
        : areas.filter((candidate) =>
              [candidate.id, candidate.uuid, candidate.slug, candidate.name].some(
                  (field) => String(field ?? '').toLowerCase() === String(area).trim().toLowerCase(),
              ),
          );

    if (boards.length === 0) {
        throw new Error(
            `"${workspace}" has no board called "${area}". It has: ${areas.map((one) => `${one.name} (${one.slug})`).join(', ') || 'none'}.`,
        );
    }

    const matches = boards.flatMap((board) =>
        (board.statuses ?? [])
            .filter(
                (one) =>
                    String(one.id) === wanted ||
                    String(one.name ?? '').toLowerCase() === wanted ||
                    String(one.key ?? '').toLowerCase() === wanted,
            )
            .map((one) => ({ board, column: one })),
    );

    if (matches.length === 0) {
        const columns = boards.flatMap((board) => (board.statuses ?? []).map((one) => `${one.name} (${board.name})`));

        throw new Error(`No column called "${column}" here. There is: ${columns.join(', ') || 'none'}.`);
    }

    if (matches.length > 1) {
        throw new Error(
            `"${column}" is a column on ${matches.length} boards — ${matches.map((one) => one.board.name).join(', ')}. Say which with \`area\`.`,
        );
    }

    return { work_area_status_id: matches[0].column.id };
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
