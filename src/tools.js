/**
 * What an agent may do in Cheto, as tools.
 *
 * The set is small on purpose. `GET /inbox` answers "is there anything for me"
 * in one call, and almost every pass needs nothing else — a catalogue of thirty
 * tools teaches a model to go looking, which costs a turn and finds the same
 * answer. Everything here is either that question or an action following from
 * its answer.
 *
 * Two things are absent and cannot be added: closing a task, and creating a
 * participant. Both are refused by the server, so exposing them would only
 * teach a model to try.
 */
export const TOOLS = [
    {
        name: 'cheto_whoami',
        description:
            'Who this credential is, which workspace it acts in, who else is there and which boards exist. Call it once at the start: it answers everything needed to begin, so nothing has to be configured in advance. `participants` is how you resolve an @handle without guessing ids; `areas` is every board with its columns, and `membership.area` is your own — where the work you create lands when you do not say.',
        inputSchema: { type: 'object', properties: {} },
        run: (cheto) => cheto.call('/me'),
    },
    {
        name: 'cheto_inbox',
        description:
            'Everything waiting for you right now — mentions, work you hold, reviews you owe, notifications — in one call. Branch on summary.has_work: it is false most of the time and is the only field most passes need. Reading does not mark anything read.',
        inputSchema: {
            type: 'object',
            properties: {
                wait: {
                    type: 'number',
                    description: 'Hold the connection open up to this many seconds (max 25) until something arrives. Returns at once if there is already work.',
                },
            },
        },
        run: (cheto, { wait }) => cheto.call(`/inbox${wait ? `?wait=${Math.min(Number(wait), 25)}` : ''}`, { timeoutMs: (Number(wait || 0) + 20) * 1000 }),
    },
    {
        name: 'cheto_tasks',
        description:
            'List tasks. Without arguments: the open ones. `assigned` "me" narrows to work you hold, review included — which cheto_inbox deliberately omits. Supports cursor pagination, limit, status, created_after and optional count. `tag` narrows to the tasks carrying ALL of the tags named, not any of them. Returns newest first.',
        inputSchema: {
            type: 'object',
            properties: {
                assigned: { type: 'string', enum: ['me'] },
                area: { type: 'string', description: 'One board only, by name, slug or id. cheto_whoami lists them.' },
                cursor: { type: 'string', description: 'Cursor returned as next_cursor by a previous page.' },
                limit: { type: 'number', minimum: 1, maximum: 100, description: 'Maximum rows to return (default 100).' },
                status: { type: 'string', enum: ['inbox', 'ready', 'in_progress', 'review', 'done'] },
                created_after: { type: 'string', description: 'Only tasks created after this ISO date/time.' },
                count: { type: 'boolean', description: 'Include the total matching count.' },
                open: { type: 'boolean', description: 'Default true. Pass false to include finished work.' },
                tag: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Tag names or slugs. Every one must be present on a task for it to be listed.',
                },
            },
        },
        run: async (cheto, { area, ...args }) => {
            const query = new URLSearchParams();

            // A board is named in words here and by slug on the wire. Resolved
            // against what this credential can actually see, so "Marketing"
            // fails with the list of boards rather than silently listing every
            // one of them.
            if (area !== undefined && area !== null && String(area).trim() !== '') {
                query.set('area', (await areaFor(cheto, area)).slug);
            }

            for (const [key, value] of Object.entries(args ?? {})) {
                if (value === undefined || value === null) {
                    continue;
                }

                // `tag` repeats rather than joining: the server reads it as a
                // list, and a comma-joined string would be one tag with a comma
                // in its name.
                if (key === 'tag') {
                    for (const tag of [].concat(value)) {
                        query.append('tag[]', String(tag));
                    }

                    continue;
                }

                query.set(key, String(value));
            }

            return cheto.call(`/tasks${query.toString() ? `?${query}` : ''}`);
        },
    },
    {
        name: 'cheto_task',
        description: 'One task in full, with its comments and reviews. `allowed_transitions` tells you what it may move to next, so you do not have to reimplement the state machine.',
        inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        run: (cheto, { id }) => cheto.call(`/tasks/${id}`),
    },
    {
        name: 'cheto_task_create',
        description:
            'Put a new task on the board. Use type "idea" for something that is not work yet — an idea stops being handed to whoever holds it, which is how you file a thought without it nagging somebody every five minutes. `assignee` offers it to somebody by @handle; they still have to accept.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                type: { type: 'string', enum: ['task', 'feature', 'bug', 'chore', 'epic', 'idea'] },
                priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
                status: { type: 'string', enum: ['inbox', 'ready', 'in_progress'], description: 'Where it lands. Default inbox.' },
                assignee: { type: 'string', description: 'A participant, by @handle or slug. cheto_whoami lists who is here.' },
                area: {
                    type: 'string',
                    description:
                        'Which board it goes on, by name, slug or id — cheto_whoami lists them. Without this it lands on your own board when your membership has one (`membership.area` in cheto_whoami), and on the workspace\'s first board when it does not — which is rarely the one you meant.',
                },
                column: {
                    type: 'string',
                    description:
                        'A column of that board, by name or key, for a board whose team renamed or added one ("Waiting on customer"). Needs `area`. The column decides the status, so do not send both.',
                },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tag names. A tag that does not exist yet is created by being used. At most 12.' },
                due_on: { type: 'string', description: 'A date, YYYY-MM-DD. Nothing else parses.' },
                requires_human: { type: 'boolean', description: 'A person has to look at this before a machine does.' },
            },
            required: ['title'],
        },
        run: async (cheto, { assignee, area, column, ...rest }) => {
            const body = { ...rest, ...(await assigneeFields(cheto, assignee)), ...(await placementFields(cheto, area, column)) };

            return cheto.call('/tasks', { method: 'POST', body, idempotencyKey: `mcp-create-${slug(rest.title)}` });
        },
    },
    {
        name: 'cheto_task_update',
        description:
            'Change one task: what it says about itself — title, description, type, priority, due date, tags, requires_human — and which column it sits in. `column` moves the card, by the name the board shows, and says what `status` says in the board\'s own words, so send one or the other. Saying what a thing IS is allowed; saying it is done is not — status "done", and any column that MEANS done, are refused for every agent, always: move it to review and ask somebody with cheto_review_request. `tags` REPLACES the whole set — cheto_task_tag adds one without disturbing the others.',
        inputSchema: {
            type: 'object',
            properties: {
                id: {
                    type: ['number', 'string'],
                    description:
                        'The task\'s number, which cheto_tasks, cheto_task and cheto_inbox all return. A task has no uuid, and the "MKT-12" a board shows is its key, not an id this takes.',
                },
                title: { type: 'string' },
                description: { type: 'string' },
                type: { type: 'string', enum: ['task', 'feature', 'bug', 'chore', 'epic', 'idea'] },
                priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
                status: { type: 'string', enum: ['inbox', 'ready', 'in_progress', 'review'] },
                column: {
                    type: ['string', 'number'],
                    description:
                        'Move it to this column of the board it is already on, by name, key or id — cheto_whoami lists every board with its columns. A column of another board is refused rather than moved somewhere nobody asked for, and so is sending this together with `status`.',
                },
                tags: { type: 'array', items: { type: 'string' }, description: 'The complete set, replacing whatever is there. At most 12.' },
                due_on: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear it.' },
                requires_human: { type: 'boolean', description: 'A person has to look at this before a machine does.' },
            },
            required: ['id'],
        },
        run: async (cheto, { id, column, ...rest }) => {
            const task = taskRef(id);
            const body = { ...rest, ...(await moveFields(cheto, task, column, rest)) };

            if (Object.keys(body).length === 0) {
                throw new Error('Nothing to change. Besides `id` this needs at least one thing to say: a column, a status, or something the task says about itself.');
            }

            const answer = await cheto.call(`/tasks/${task}`, { method: 'PATCH', body, idempotencyKey: `mcp-update-${task}-${slug(JSON.stringify(body))}` });

            return confirmApplied(answer, body);
        },
    },
    {
        name: 'cheto_task_status',
        description:
            'Move a task along the board: inbox → ready → in_progress → review, and back where that makes sense. "done" is NOT here and cannot be added: an agent may never close its own work. Finish by moving it to review and asking somebody with cheto_review_request. cheto_task reports allowed_transitions for the one you are looking at.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number' },
                status: { type: 'string', enum: ['inbox', 'ready', 'in_progress', 'review'] },
            },
            required: ['id', 'status'],
        },
        run: (cheto, { id, status }) => cheto.call(`/tasks/${id}`, { method: 'PATCH', body: { status }, idempotencyKey: `mcp-status-${id}-${status}` }),
    },
    {
        name: 'cheto_task_assign',
        description:
            'Hand a task to somebody — a person or another agent — by @handle, or take it off whoever holds it with `to: null`. Assigning is an OFFER, not an instruction: the other side still has to accept, and nothing starts on their machine because of this. To take unheld work for yourself use cheto_task_claim, which also starts it.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number' },
                to: {
                    type: ['string', 'null'],
                    description: 'A participant by @handle, slug or name — cheto_whoami lists them. Explicit null unassigns.',
                },
            },
            required: ['id', 'to'],
        },
        run: async (cheto, { id, to }) => {
            const fields = await assigneeFields(cheto, to, { explicit: true });

            return cheto.call(`/tasks/${id}`, { method: 'PATCH', body: fields, idempotencyKey: `mcp-assign-${id}-${slug(to ?? 'nobody')}` });
        },
    },
    {
        name: 'cheto_task_tag',
        description:
            'Add or remove tags without disturbing the rest. Both lists are names; a tag nobody has used yet is created by naming it. Reads the task first and writes back the whole set, because that is the only shape the server takes — so prefer this over cheto_task_update when you mean "also tag it X".',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number' },
                add: { type: 'array', items: { type: 'string' } },
                remove: { type: 'array', items: { type: 'string' } },
            },
            required: ['id'],
        },
        run: async (cheto, { id, add = [], remove = [] }) => {
            const { data } = await cheto.call(`/tasks/${id}`);

            // Matched on the slug, like the server does, so "Backend" removes a
            // tag somebody first typed as "backend".
            const dropped = new Set([].concat(remove).map((name) => slugOf(name)));
            const current = (data.tags ?? []).map((tag) => tag.name).filter((name) => !dropped.has(slugOf(name)));

            const tags = [...current];

            for (const name of [].concat(add)) {
                if (!tags.some((existing) => slugOf(existing) === slugOf(name))) {
                    tags.push(name);
                }
            }

            return cheto.call(`/tasks/${id}`, { method: 'PATCH', body: { tags }, idempotencyKey: `mcp-tag-${id}-${slug(tags.join('-'))}` });
        },
    },
    {
        name: 'cheto_task_claim',
        description: 'Take work nobody holds, and start it. Refuses anything already held — it cannot take a task away from somebody.',
        inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        run: (cheto, { id }) => cheto.call(`/tasks/${id}/claim`, { method: 'POST', idempotencyKey: `mcp-claim-${id}` }),
    },
    {
        name: 'cheto_task_accept',
        description: 'Say yes to work already assigned to you. An assignment is an offer, not an instruction: it arrives unaccepted and waits for this.',
        inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        run: (cheto, { id }) => cheto.call(`/tasks/${id}/accept`, { method: 'POST', idempotencyKey: `mcp-accept-${id}` }),
    },
    {
        name: 'cheto_task_comment',
        description: 'Say something on a task. Where you report what you did — commenting does not move the task, so it will not wake you again.',
        inputSchema: { type: 'object', properties: { id: { type: 'number' }, body: { type: 'string' } }, required: ['id', 'body'] },
        run: (cheto, { id, body }) => cheto.call(`/tasks/${id}/comments`, { method: 'POST', body: { body }, idempotencyKey: `mcp-comment-${id}-${slug(body)}` }),
    },
    {
        name: 'cheto_capacity',
        description: 'Workspace workload snapshot by board. Reports derived open, in-progress, review, and unassigned work; it does not invent a throughput limit or availability budget.',
        inputSchema: { type: 'object', properties: {} },
        run: (cheto) => cheto.call('/capacity'),
    },
    {
        name: 'cheto_reviews',
        description: 'Reviews you owe somebody an answer on. cheto_inbox counts them; this is the list, with the task each one is about.',
        inputSchema: { type: 'object', properties: {} },
        run: (cheto) => cheto.call('/reviews'),
    },
    {
        name: 'cheto_review_request',
        description: 'Ask somebody to look at a task. This is how work gets finished: you cannot close it, a reviewer decides. Pick the reviewer from cheto_whoami participants.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'number' },
                reviewer_type: { type: 'string', enum: ['user', 'agent'] },
                reviewer_id: { type: 'number' },
                note: { type: 'string' },
            },
            required: ['task_id', 'reviewer_type', 'reviewer_id'],
        },
        run: (cheto, { task_id: taskId, ...rest }) => cheto.call(`/tasks/${taskId}/reviews`, { method: 'POST', body: rest, idempotencyKey: `mcp-review-${taskId}` }),
    },
    {
        name: 'cheto_review_answer',
        description: 'Answer a review somebody asked of you: approved, or changes_requested. Only the named reviewer may answer, and only once. Approving records that you were satisfied; it does not close the task.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number' },
                status: { type: 'string', enum: ['approved', 'changes_requested'] },
                note: { type: 'string' },
            },
            required: ['id', 'status'],
        },
        run: (cheto, { id, ...rest }) => cheto.call(`/reviews/${id}`, { method: 'PATCH', body: rest, idempotencyKey: `mcp-answer-${id}` }),
    },
    {
        name: 'cheto_channels',
        description: 'The rooms in this workspace.',
        inputSchema: { type: 'object', properties: {} },
        run: (cheto) => cheto.call('/channels'),
    },
    {
        name: 'cheto_channel_read',
        description:
            'What is being said in a channel, bounded. Returns the last few folded summaries plus the handful of messages after them — an amount of text whose size does not grow as the channel does. Prefer this over reading every message.',
        inputSchema: { type: 'object', properties: { channel: { type: 'string', description: 'slug or id' } }, required: ['channel'] },
        run: (cheto, { channel }) => cheto.call(`/channels/${encodeURIComponent(channel)}/context`),
    },
    {
        name: 'cheto_channel_post',
        description: 'Say something in a channel. Write @handle to name somebody — people and agents alike, resolved server-side.',
        inputSchema: { type: 'object', properties: { channel: { type: 'string' }, body: { type: 'string' } }, required: ['channel', 'body'] },
        run: (cheto, { channel, body }) =>
            cheto.call(`/channels/${encodeURIComponent(channel)}/messages`, { method: 'POST', body: { body }, idempotencyKey: `mcp-post-${channel}-${slug(body)}` }),
    },
    {
        name: 'cheto_search',
        description: 'Reach past the bounded read, into everything that was said before it. Use it instead of asking for a bigger window.',
        inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' }, kind: { type: 'string', enum: ['message', 'task', 'comment', 'compact'] } },
            required: ['q'],
        },
        run: (cheto, { q, kind }) => cheto.call(`/search?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ''}`),
    },
    {
        name: 'cheto_memory',
        description: 'What this workspace worked out, as against what it said. Read it before asking somebody a question they have already answered.',
        inputSchema: { type: 'object', properties: {} },
        run: (cheto) => cheto.call('/memory'),
    },
    {
        name: 'cheto_memory_write',
        description: 'Write something down for everybody, so it is not rediscovered next week. `key` makes it addressable by name later.',
        inputSchema: {
            type: 'object',
            properties: { title: { type: 'string' }, body: { type: 'string' }, key: { type: 'string' } },
            required: ['title', 'body'],
        },
        run: (cheto, args) => cheto.call('/memory', { method: 'POST', body: args, idempotencyKey: `mcp-memory-${slug(args.key ?? args.title)}` }),
    },
    {
        name: 'cheto_heartbeat',
        description:
            'Say you are still here. Presence is derived from this and nothing else: a connection that goes quiet for ten minutes stops counting, and the agent shows as offline. Send one while you work.',
        inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['online', 'busy', 'offline'] } } },
        run: (cheto, { status }) => cheto.call('/heartbeat', { method: 'POST', body: status ? { status } : {} }),
    },
];

/** A stable key from what the work is, so a retry is a retry and not a second write. */
function slug(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 48);
}

/** The server's own tag key, so "Backend" and "backend" compare equal here too. */
function slugOf(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * A name somebody wrote, as the `{assignee_type, assignee_id}` pair the API takes.
 *
 * The API wants ids, and a model holding a conversation has handles — so the
 * lookup happens here rather than being pushed back at the caller as "call
 * cheto_whoami first, then read the list, then call me again". Three round trips
 * for a thing the server already answered.
 *
 * Resolved against **this workspace's participants only**, which is the same
 * boundary the server enforces on the way in: a handle belonging to somebody in
 * another workspace simply is not found.
 *
 * `explicit` is what separates "assign nobody" from "do not touch the assignee".
 * cheto_task_assign says null to unassign and means it; cheto_task_create leaving
 * it out means nothing was asked for, and sending `assignee_type: null` there
 * would be the same request with a different meaning.
 */
/**
 * A board, and optionally one of its columns, as the ids the API takes.
 *
 * The same trade `assigneeFields` makes for people. A model reads "Marketing &
 * Reels" off `cheto_whoami` and should be able to send that back; ids are what
 * the server takes, and the translation belongs here rather than in a prompt
 * telling a model to remember a number.
 *
 * Naming a board we cannot find **fails**, with the list. The server used to
 * accept `work_area_id` and quietly put the task on the first board instead,
 * which is how a fleet of agents filed three hundred tasks in the wrong place
 * without anybody noticing. A wrong board is worse than a refusal.
 */
async function placementFields(cheto, area, column) {
    if (isBlank(area)) {
        if (!isBlank(column)) {
            throw new Error('A column belongs to a board, so `column` needs `area` as well. cheto_whoami lists both.');
        }

        return {};
    }

    const board = await areaFor(cheto, area);

    if (isBlank(column)) {
        return { work_area_id: board.id };
    }

    // Only the column: it names its own board, and sending both is two chances
    // to disagree — which the server refuses rather than guesses at.
    return { work_area_status_id: columnOf(board, column).id };
}

/** One board of this workspace, by name, slug or id. */
async function areaFor(cheto, area) {
    const wanted = String(area).trim().toLowerCase();
    const { areas = [] } = await cheto.call('/me');

    const match =
        areas.find((candidate) => String(candidate.id) === wanted) ??
        areas.find((candidate) => String(candidate.slug ?? '').toLowerCase() === wanted) ??
        areas.find((candidate) => String(candidate.name ?? '').toLowerCase() === wanted);

    if (!match) {
        throw new Error(
            `This workspace has no board called "${area}". It has: ${areas.map((candidate) => `${candidate.name} (${candidate.slug})`).join(', ') || 'none'}.`,
        );
    }

    return match;
}

/**
 * A task, as the API addresses one: its number.
 *
 * Refused in words rather than by the schema, because the two things a model
 * reaches for instead are both plausible and both wrong. "MKT-12" is the key a
 * board *prints* on the card — the only identifier a person ever sees — and a
 * uuid is what every other object in Cheto uses. A task has neither, so the
 * refusal names what to send and where the number is.
 */
function taskRef(id) {
    const wanted = String(id ?? '').trim();

    if (/^\d+$/.test(wanted)) {
        return Number(wanted);
    }

    throw new Error(
        `"${id}" is not a task id. A task is addressed by its number — the \`id\` that cheto_tasks, cheto_task and cheto_inbox all return — never by the "${wanted || 'MKT-12'}" key a board prints on the card, and never by a uuid, which a task does not have.`,
    );
}

/**
 * A column somebody named, as the fields that move the card there.
 *
 * The board is the task's own: `column` moves a card along the board it is
 * already on, which is the thing a model means by "move it to Waiting on
 * customer". Putting a task on a *different* board is a different act with
 * different consequences, and it is not this.
 *
 * Both fields go out. `work_area_status_id` is the exact column and is what the
 * panel sends; `status` is what the column *means*, and is what the agent API
 * reads today — {@see TaskController::update}, which resolves a status and
 * ignores the column. The server takes whichever it understands, so the day the
 * agent endpoint grows the column branch the panel already has, this gets more
 * precise without changing.
 */
async function moveFields(cheto, task, column, rest) {
    if (isBlank(column)) {
        return {};
    }

    if (!isBlank(rest.status)) {
        throw new Error('`column` and `status` are one instruction in two vocabularies — a column\'s category IS the status — so send one of them. `column` is the board\'s own words; `status` is the five states underneath.');
    }

    const { data } = await cheto.call(`/tasks/${task}`);

    if (data?.work_area_id === null || data?.work_area_id === undefined) {
        throw new Error(`Task ${task} is not on any board, so it has no columns to move between. Move it by \`status\` instead, or ask somebody to put it on a board.`);
    }

    const board = await areaFor(cheto, data.work_area_id);
    const match = columnOf(board, column);
    const category = categoryOf(match);

    // The same refusal as `status: done`, in the board's own words. A team that
    // renamed Done to "Shipped" has not created a way around the rule, and a
    // model that found one would believe it had closed its own work.
    if (category === 'done') {
        throw new Error(
            `"${match.name}" is a done column of "${board.name}", and an agent may never close its own work — whatever the column is called. Move it to review and ask somebody with cheto_review_request.`,
        );
    }

    const landing = landingColumn(board, category);

    // Where a move by status actually lands, worked out the way the server
    // works it out. With one column per meaning — the ordinary board, and the
    // renamed one — that is the column asked for and the move is exact. With
    // two, it is not, and the card would go one column over while this reported
    // success. A wrong column is worse than a refusal, the same way a wrong
    // board is. Delete this guard on the day the agent endpoint reads
    // `work_area_status_id`; until then it is the only thing that makes the
    // answer true.
    if (landing && String(landing.id) !== String(match.id)) {
        throw new Error(
            `"${board.name}" has more than one column meaning ${category}, and the agent API moves a card by what a column means rather than by which one it is — so this would land in "${landing.name}", not "${match.name}". Refused rather than moved one column over and reported as done. Name "${landing.name}", or ask somebody to drag it.`,
        );
    }

    return { work_area_status_id: Number(match.id), status: category };
}

/** One column of a board, by name, key or id — the three cheto_whoami shows. */
function columnOf(board, column) {
    const wanted = String(column).trim().toLowerCase();
    const columns = board.statuses ?? [];

    const match =
        columns.find((candidate) => String(candidate.id) === wanted) ??
        columns.find((candidate) => String(candidate.key ?? '').toLowerCase() === wanted) ??
        columns.find((candidate) => String(candidate.name ?? '').toLowerCase() === wanted);

    if (!match) {
        throw new Error(`"${board.name}" has no column called "${column}". It has: ${columns.map((candidate) => candidate.name).join(', ')}.`);
    }

    return match;
}

/**
 * What a column means, as one of the five states.
 *
 * `category` arrives as `{value, key}` because the board draws both. A column
 * nobody renamed carries its meaning in `key` as well, which is what answers
 * for a payload that predates the pair.
 */
function categoryOf(column) {
    const category = column?.category;
    const value = typeof category === 'string' ? category : category?.value;

    return String(value ?? column?.key ?? '').toLowerCase();
}

/** Where a move by status lands: the board's first column of that meaning. */
function landingColumn(board, category) {
    return (
        (board.statuses ?? [])
            .filter((candidate) => categoryOf(candidate) === category)
            .sort((one, other) => (one.position ?? 0) - (other.position ?? 0) || (one.id ?? 0) - (other.id ?? 0))[0] ?? null
    );
}

/**
 * That what was asked for actually happened.
 *
 * `requires_human` is the field this exists for. The agent endpoint validates
 * it and then writes it only when a descriptive field travels with it, so
 * `{id, requires_human: true}` on its own comes back 200 with the gate still
 * open. Reporting that as success would teach a model that a task is held for a
 * person when nothing is holding it — which is the one thing the flag is for.
 */
function confirmApplied(answer, body) {
    const task = answer?.data;

    if (!('requires_human' in body) || task?.requires_human === undefined || task.requires_human === Boolean(body.requires_human)) {
        return answer;
    }

    throw new Error(
        `The rest of the change went through, but requires_human is still ${task.requires_human}: this Cheto writes it only alongside a descriptive field. Send it again together with title, description, type, priority, due_on or tags.`,
    );
}

function isBlank(value) {
    return value === undefined || value === null || String(value).trim() === '';
}

async function assigneeFields(cheto, who, { explicit = false } = {}) {
    if (who === undefined || (who === null && !explicit)) {
        return {};
    }

    if (who === null || String(who).trim() === '') {
        return { assignee_type: null, assignee_id: null };
    }

    const wanted = String(who).trim().replace(/^@/, '').toLowerCase();
    const { participants = [] } = await cheto.call('/me');

    const match =
        participants.find((person) => String(person.slug ?? '').toLowerCase() === wanted) ??
        participants.find((person) => String(person.name ?? '').toLowerCase() === wanted);

    if (!match) {
        throw new Error(
            `Nobody here answers to "${who}". This workspace has: ${participants.map((person) => `@${person.slug} (${person.type})`).join(', ')}.`,
        );
    }

    return { assignee_type: match.type, assignee_id: match.id };
}
