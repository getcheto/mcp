/**
 * What an agent may do in Knot, as tools.
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
        name: 'knot_whoami',
        description:
            'Who this credential is, which workspace it acts in, and who else is there. Call it once at the start: it answers everything needed to begin, so nothing has to be configured in advance. `participants` is how you resolve an @handle without guessing ids.',
        inputSchema: { type: 'object', properties: {} },
        run: (knot) => knot.call('/me'),
    },
    {
        name: 'knot_inbox',
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
        run: (knot, { wait }) => knot.call(`/inbox${wait ? `?wait=${Math.min(Number(wait), 25)}` : ''}`, { timeoutMs: (Number(wait || 0) + 20) * 1000 }),
    },
    {
        name: 'knot_tasks',
        description: 'List tasks. Without arguments: the open ones. `assigned` "me" narrows to work you hold, review included — which knot_inbox deliberately omits.',
        inputSchema: {
            type: 'object',
            properties: {
                assigned: { type: 'string', enum: ['me'] },
                status: { type: 'string', enum: ['inbox', 'ready', 'in_progress', 'review', 'done'] },
                open: { type: 'boolean' },
            },
        },
        run: (knot, args) => {
            const query = new URLSearchParams();
            for (const [key, value] of Object.entries(args ?? {})) {
                if (value !== undefined && value !== null) {
                    query.set(key, String(value));
                }
            }

            return knot.call(`/tasks${query.toString() ? `?${query}` : ''}`);
        },
    },
    {
        name: 'knot_task',
        description: 'One task in full, with its comments and reviews. `allowed_transitions` tells you what it may move to next, so you do not have to reimplement the state machine.',
        inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        run: (knot, { id }) => knot.call(`/tasks/${id}`),
    },
    {
        name: 'knot_task_create',
        description: 'Put a new task on the board. Use type "idea" for something that is not work yet — an idea stops being handed to whoever holds it, which is how you file a thought without it nagging somebody every five minutes.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                type: { type: 'string', enum: ['task', 'feature', 'bug', 'chore', 'epic', 'idea'] },
                priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
            },
            required: ['title'],
        },
        run: (knot, args) => knot.call('/tasks', { method: 'POST', body: args, idempotencyKey: `mcp-create-${slug(args.title)}` }),
    },
    {
        name: 'knot_task_update',
        description:
            'Change what a task says about itself: title, description, type, priority, due date. Saying what a thing IS is allowed; saying it is done is not — status "done" is refused for every agent, always.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number' },
                title: { type: 'string' },
                description: { type: 'string' },
                type: { type: 'string', enum: ['task', 'feature', 'bug', 'chore', 'epic', 'idea'] },
                priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
                status: { type: 'string', enum: ['inbox', 'ready', 'in_progress', 'review'] },
            },
            required: ['id'],
        },
        run: (knot, { id, ...rest }) => knot.call(`/tasks/${id}`, { method: 'PATCH', body: rest, idempotencyKey: `mcp-update-${id}-${slug(JSON.stringify(rest))}` }),
    },
    {
        name: 'knot_task_claim',
        description: 'Take work nobody holds, and start it. Refuses anything already held — it cannot take a task away from somebody.',
        inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        run: (knot, { id }) => knot.call(`/tasks/${id}/claim`, { method: 'POST', idempotencyKey: `mcp-claim-${id}` }),
    },
    {
        name: 'knot_task_accept',
        description: 'Say yes to work already assigned to you. An assignment is an offer, not an instruction: it arrives unaccepted and waits for this.',
        inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        run: (knot, { id }) => knot.call(`/tasks/${id}/accept`, { method: 'POST', idempotencyKey: `mcp-accept-${id}` }),
    },
    {
        name: 'knot_task_comment',
        description: 'Say something on a task. Where you report what you did — commenting does not move the task, so it will not wake you again.',
        inputSchema: { type: 'object', properties: { id: { type: 'number' }, body: { type: 'string' } }, required: ['id', 'body'] },
        run: (knot, { id, body }) => knot.call(`/tasks/${id}/comments`, { method: 'POST', body: { body }, idempotencyKey: `mcp-comment-${id}-${slug(body)}` }),
    },
    {
        name: 'knot_review_request',
        description: 'Ask somebody to look at a task. This is how work gets finished: you cannot close it, a reviewer decides. Pick the reviewer from knot_whoami participants.',
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
        run: (knot, { task_id: taskId, ...rest }) => knot.call(`/tasks/${taskId}/reviews`, { method: 'POST', body: rest, idempotencyKey: `mcp-review-${taskId}` }),
    },
    {
        name: 'knot_review_answer',
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
        run: (knot, { id, ...rest }) => knot.call(`/reviews/${id}`, { method: 'PATCH', body: rest, idempotencyKey: `mcp-answer-${id}` }),
    },
    {
        name: 'knot_channels',
        description: 'The rooms in this workspace.',
        inputSchema: { type: 'object', properties: {} },
        run: (knot) => knot.call('/channels'),
    },
    {
        name: 'knot_channel_read',
        description:
            'What is being said in a channel, bounded. Returns the last few folded summaries plus the handful of messages after them — an amount of text whose size does not grow as the channel does. Prefer this over reading every message.',
        inputSchema: { type: 'object', properties: { channel: { type: 'string', description: 'slug or id' } }, required: ['channel'] },
        run: (knot, { channel }) => knot.call(`/channels/${encodeURIComponent(channel)}/context`),
    },
    {
        name: 'knot_channel_post',
        description: 'Say something in a channel. Write @handle to name somebody — people and agents alike, resolved server-side.',
        inputSchema: { type: 'object', properties: { channel: { type: 'string' }, body: { type: 'string' } }, required: ['channel', 'body'] },
        run: (knot, { channel, body }) =>
            knot.call(`/channels/${encodeURIComponent(channel)}/messages`, { method: 'POST', body: { body }, idempotencyKey: `mcp-post-${channel}-${slug(body)}` }),
    },
    {
        name: 'knot_search',
        description: 'Reach past the bounded read, into everything that was said before it. Use it instead of asking for a bigger window.',
        inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' }, kind: { type: 'string', enum: ['message', 'task', 'comment', 'compact'] } },
            required: ['q'],
        },
        run: (knot, { q, kind }) => knot.call(`/search?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ''}`),
    },
    {
        name: 'knot_memory',
        description: 'What this workspace worked out, as against what it said. Read it before asking somebody a question they have already answered.',
        inputSchema: { type: 'object', properties: {} },
        run: (knot) => knot.call('/memory'),
    },
    {
        name: 'knot_memory_write',
        description: 'Write something down for everybody, so it is not rediscovered next week. `key` makes it addressable by name later.',
        inputSchema: {
            type: 'object',
            properties: { title: { type: 'string' }, body: { type: 'string' }, key: { type: 'string' } },
            required: ['title', 'body'],
        },
        run: (knot, args) => knot.call('/memory', { method: 'POST', body: args, idempotencyKey: `mcp-memory-${slug(args.key ?? args.title)}` }),
    },
    {
        name: 'knot_heartbeat',
        description:
            'Say you are still here. Presence is derived from this and nothing else: a connection that goes quiet for ten minutes stops counting, and the agent shows as offline. Send one while you work.',
        inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['online', 'busy', 'offline'] } } },
        run: (knot, { status }) => knot.call('/heartbeat', { method: 'POST', body: status ? { status } : {} }),
    },
];

/** A stable key from what the work is, so a retry is a retry and not a second write. */
function slug(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 48);
}
