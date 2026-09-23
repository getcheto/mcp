/**
 * The protocol, and the one decision worth pinning.
 *
 * A refusal from Cheto is an answer, not a transport failure. Returned as tool
 * content with `isError`, the model reads why and adapts; returned as a JSON-RPC
 * error it never sees the reason and retries the same call with different
 * arguments. Everything else here is protocol shape.
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { serve } from '../src/server.js';
import { TOOLS } from '../src/tools.js';

async function exchange(requests, { fetchImpl, env = {} } = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];

    output.on('data', (chunk) => chunks.push(chunk.toString()));

    const original = globalThis.fetch;

    if (fetchImpl) {
        globalThis.fetch = fetchImpl;
    }

    const running = serve({ input, output, env: { CHETO_URL: 'http://cheto.test', CHETO_TOKEN: 'cheto_ak_x', ...env } });

    for (const request of requests) {
        input.write(JSON.stringify(request) + '\n');
    }

    input.end();
    await running;
    globalThis.fetch = original;

    return chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

const ok = (body, status = 200) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

describe('the MCP surface', () => {
    it('announces itself and its tools', async () => {
        const answers = await exchange([
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ]);

        assert.equal(answers[0].result.serverInfo.name, 'cheto');
        assert.equal(answers[1].result.tools.length, TOOLS.length);
        assert.ok(answers[1].result.tools.every((tool) => tool.description && tool.inputSchema));
    });

    it('does not answer a notification', async () => {
        // It has no id. Replying to one is a protocol error, not a harmless extra.
        const answers = await exchange([
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { jsonrpc: '2.0', id: 9, method: 'ping' },
        ]);

        assert.equal(answers.length, 1);
        assert.equal(answers[0].id, 9);
    });

    it('hands a refusal back as something the model can read', async () => {
        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 1, status: 'done' } } }], {
            fetchImpl: ok({ message: 'This action is unauthorized.' }, 403),
        });

        const [answer] = answers;

        assert.equal(answer.error, undefined, 'a refusal must not arrive as a protocol error');
        assert.equal(answer.result.isError, true);
        assert.match(answer.result.content[0].text, /never set a task to done/);
    });

    it('explains a dead credential instead of repeating the number', async () => {
        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_whoami', arguments: {} } }], {
            fetchImpl: ok({ message: 'Unauthenticated.' }, 401),
        });

        assert.match(answers[0].result.content[0].text, /revoked or expired/);
    });

    it('refuses a tool it does not have', async () => {
        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_delete_everything', arguments: {} } }]);

        assert.equal(answers[0].error.code, -32602);
    });
});

describe('capacity tool', () => {
    it('exposes cheto_capacity and calls the agent capacity endpoint', async () => {
        const sent = [];
        const answers = await exchange([
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cheto_capacity', arguments: {} } },
        ], {
            fetchImpl: async (url) => {
                sent.push(url);
                return { ok: true, status: 200, text: async () => JSON.stringify({ semantics: 'derived_workload', data: [], summary: {} }) };
            },
        });

        assert.ok(answers[0].result.tools.some((tool) => tool.name === 'cheto_capacity'));
        assert.equal(answers[1].result.isError, undefined);
        assert.equal(sent[0], 'http://cheto.test/api/v1/agent/capacity');
    });
});

describe('the tool set', () => {
    it('offers nothing the server would refuse', () => {
        // Closing a task and creating a participant are refused for every agent,
        // always. A tool for either would only teach a model to try.
        const names = TOOLS.map((tool) => tool.name).join(' ');

        assert.doesNotMatch(names, /complete|close|done/);
        assert.doesNotMatch(names, /agent_create|credential|pair/);
    });

    it('never lets `done` into a status the caller can pick', () => {
        // Every tool that *moves* a task, not just the first one that had one:
        // the day somebody adds a second way to move one is the day this rule
        // gets re-implemented, and it has to be re-checked with it.
        //
        // `cheto_tasks` is excluded because it reads. Filtering on done is how
        // you find finished work, and refusing that would not stop an agent
        // closing anything — it would only stop it looking.
        const pickable = TOOLS.filter((tool) => tool.name !== 'cheto_tasks')
            .map((tool) => tool.inputSchema?.properties?.status?.enum)
            .filter(Boolean);

        assert.ok(pickable.length >= 2, 'expected the update and status tools to both offer one');
        pickable.forEach((statuses) => assert.ok(!statuses.includes('done')));
    });
});

describe('naming somebody', () => {
    it('turns an @handle into the pair the API takes', async () => {
        const sent = [];

        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_assign', arguments: { id: 7, to: '@magui' } } }], {
            fetchImpl: async (url, options) => {
                sent.push({ url, body: options.body ? JSON.parse(options.body) : null });

                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify(
                            url.endsWith('/me')
                                ? { participants: [{ type: 'agent', id: 6, name: 'Magui', slug: 'magui' }] }
                                : { data: { id: 7 } },
                        ),
                };
            },
        });

        assert.equal(answers[0].result.isError, undefined);
        assert.deepEqual(sent.at(-1).body, { assignee_type: 'agent', assignee_id: 6 });
    });

    it('says who is actually here when the handle is wrong', async () => {
        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_assign', arguments: { id: 7, to: 'nobody' } } }], {
            fetchImpl: ok({ participants: [{ type: 'agent', id: 6, name: 'Magui', slug: 'magui' }] }),
        });

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /@magui/);
    });

    it('unassigns on an explicit null', async () => {
        const sent = [];

        await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_assign', arguments: { id: 7, to: null } } }], {
            fetchImpl: async (url, options) => {
                sent.push(options.body ? JSON.parse(options.body) : null);

                return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 7 } }) };
            },
        });

        // And without asking who is here: there is nobody to look up.
        assert.deepEqual(sent, [{ assignee_type: null, assignee_id: null }]);
    });
});

describe('naming a board', () => {
    const workspace = {
        areas: [
            { id: 2, name: 'General', slug: 'general', statuses: [{ id: 5, name: 'Inbox', key: 'inbox' }] },
            {
                id: 16,
                name: 'Marketing & Reels',
                slug: 'marketing-reels',
                statuses: [
                    { id: 60, name: 'Inbox', key: 'inbox' },
                    { id: 64, name: 'Waiting on customer', key: 'waiting_on_customer' },
                ],
            },
        ],
    };

    const spy = (sent) => async (url, options) => {
        sent.push({ url, body: options.body ? JSON.parse(options.body) : null });

        return {
            ok: true,
            status: 201,
            text: async () => JSON.stringify(url.endsWith('/me') ? workspace : { data: { id: 391 } }),
        };
    };

    it('turns a board name into the id the API takes', async () => {
        const sent = [];

        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_create', arguments: { title: 'A reel', area: 'Marketing & Reels' } } }],
            { fetchImpl: spy(sent) },
        );

        assert.equal(answers[0].result.isError, undefined);
        assert.deepEqual(sent.at(-1).body, { title: 'A reel', work_area_id: 16 });
    });

    it('takes a slug or an id just as well', async () => {
        for (const area of ['marketing-reels', 16, '16']) {
            const sent = [];

            await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_create', arguments: { title: 'A reel', area } } }], {
                fetchImpl: spy(sent),
            });

            assert.deepEqual(sent.at(-1).body, { title: 'A reel', work_area_id: 16 });
        }
    });

    it('sends the column alone, because a column names its own board', async () => {
        const sent = [];

        await exchange(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'cheto_task_create', arguments: { title: 'Chase it', area: 'marketing-reels', column: 'Waiting on customer' } },
                },
            ],
            { fetchImpl: spy(sent) },
        );

        // Both would be two chances to disagree, and the server refuses a
        // disagreement rather than guessing which one was meant.
        assert.deepEqual(sent.at(-1).body, { title: 'Chase it', work_area_status_id: 64 });
    });

    it('lists the boards there are when the name is wrong, rather than filing it anywhere', async () => {
        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_create', arguments: { title: 'A reel', area: 'Marketng' } } }],
            { fetchImpl: ok(workspace) },
        );

        // The whole point of the refusal: the server used to take an unknown
        // board and quietly file the task on the first one instead.
        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /Marketing & Reels \(marketing-reels\)/);
    });

    it('says which columns a board has when the column is wrong', async () => {
        const answers = await exchange(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'cheto_task_create', arguments: { title: 'A reel', area: 'marketing-reels', column: 'Blocked' } },
                },
            ],
            { fetchImpl: ok(workspace) },
        );

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /Waiting on customer/);
    });

    it('refuses a column with no board, because a column belongs to one', async () => {
        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_create', arguments: { title: 'A reel', column: 'Waiting on customer' } } }],
            { fetchImpl: ok(workspace) },
        );

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /needs `area`/);
    });

    it('narrows a listing to one board, by slug', async () => {
        const sent = [];

        await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_tasks', arguments: { area: 'Marketing & Reels', status: 'ready' } } }], {
            fetchImpl: spy(sent),
        });

        assert.match(sent.at(-1).url, /\/tasks\?area=marketing-reels&status=ready$/);
    });

    it('leaves a listing alone when no board is named', async () => {
        const sent = [];

        await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_tasks', arguments: {} } }], { fetchImpl: spy(sent) });

        // And without asking which boards exist: there is nothing to resolve.
        assert.equal(sent.length, 1);
        assert.match(sent[0].url, /\/tasks$/);
    });
});

describe('tagging', () => {
    it('adds one without dropping the others', async () => {
        const sent = [];

        await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_tag', arguments: { id: 7, add: ['urgent'], remove: ['Backend'] } } }], {
            fetchImpl: async (url, options) => {
                if (options.method === 'PATCH') {
                    sent.push(JSON.parse(options.body));
                }

                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify({
                            data: { id: 7, tags: [{ name: 'backend', slug: 'backend' }, { name: 'agro', slug: 'agro' }] },
                        }),
                };
            },
        });

        // `backend` goes because removal matches on the slug, not the casing.
        assert.deepEqual(sent, [{ tags: ['agro', 'urgent'] }]);
    });
});

describe('moving a card between columns', () => {
    // One board with two columns meaning the same thing, which is the case the
    // whole guard exists for, plus a done column somebody renamed.
    const workspace = {
        areas: [
            {
                id: 16,
                name: 'Marketing & Reels',
                slug: 'marketing-reels',
                statuses: [
                    { id: 60, name: 'Inbox', key: 'inbox', category: { value: 'inbox' }, position: 0 },
                    { id: 62, name: 'In progress', key: 'in_progress', category: { value: 'in_progress' }, position: 1 },
                    { id: 64, name: 'Waiting on customer', key: 'waiting_on_customer', category: { value: 'in_progress' }, position: 2 },
                    { id: 66, name: 'Review', key: 'review', category: { value: 'review' }, position: 3 },
                    { id: 68, name: 'Shipped', key: 'done', category: { value: 'done' }, position: 4 },
                ],
            },
        ],
    };

    const spy = (sent, { task = { id: 391, work_area_id: 16 }, patched = { id: 391 } } = {}) => async (url, options) => {
        sent.push({ url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });

        const answer = url.endsWith('/me') ? workspace : { data: options.method === 'PATCH' ? patched : task };

        return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
    };

    it('names the column and what it means, along the board the task is already on', async () => {
        const sent = [];

        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 391, column: 'Review' } } }],
            { fetchImpl: spy(sent) },
        );

        assert.equal(answers[0].result.isError, undefined);

        // Both: the id is the exact column and is what the panel sends, the
        // status is what the agent endpoint reads today. Whichever the server
        // understands, the card ends up in the same place.
        assert.deepEqual(sent.at(-1), {
            url: 'http://cheto.test/api/v1/agent/tasks/391',
            method: 'PATCH',
            body: { work_area_status_id: 66, status: 'review' },
        });
    });

    it('takes a column key or id just as well as its name', async () => {
        for (const column of ['review', 66, '66']) {
            const sent = [];

            await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 391, column } } }], {
                fetchImpl: spy(sent),
            });

            assert.deepEqual(sent.at(-1).body, { work_area_status_id: 66, status: 'review' });
        }
    });

    it('edits the text without asking the board anything', async () => {
        const sent = [];

        await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 391, title: 'Chase the customer', priority: 'high' } } }],
            { fetchImpl: spy(sent) },
        );

        // One call. Naming no column means there is nothing to resolve, and
        // reading /me and the task to find that out would cost two round trips
        // on the commonest edit there is.
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].body, { title: 'Chase the customer', priority: 'high' });
    });

    it('refuses a column and a status together, because they say the same thing', async () => {
        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 391, column: 'Review', status: 'in_progress' } } }],
            { fetchImpl: spy([]) },
        );

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /two vocabularies/);
    });

    it('refuses a done column however the team spelled it', async () => {
        const sent = [];

        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 391, column: 'Shipped' } } }],
            { fetchImpl: spy(sent) },
        );

        // Renaming Done is not a way around the rule, and a model that found
        // one would believe it had closed its own work.
        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /never close its own work/);
        assert.ok(!sent.some((call) => call.method === 'PATCH'), 'nothing may be written on the way to that refusal');
    });

    it('refuses a column a move by status would not actually reach', async () => {
        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 391, column: 'Waiting on customer' } } }],
            { fetchImpl: spy([]) },
        );

        // "Waiting on customer" and "In progress" mean the same thing, and the
        // agent endpoint moves by meaning — so this would land one column over
        // and report success. A wrong column is worse than a refusal.
        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /would land in "In progress"/);
    });

    it('says which columns the board has when the column is wrong', async () => {
        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 391, column: 'Blocked' } } }],
            { fetchImpl: spy([]) },
        );

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /Waiting on customer/);
    });

    it('says a task off every board has no columns to move between', async () => {
        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 391, column: 'Review' } } }],
            { fetchImpl: spy([], { task: { id: 391, work_area_id: null } }) },
        );

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /not on any board/);
    });

    it('refuses the key a board prints, and says where the number is', async () => {
        const sent = [];

        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 'MKT-12', title: 'Chase it' } } }],
            { fetchImpl: spy(sent) },
        );

        // `/tasks/MKT-12` would be a 404 the model reads as "no such task",
        // when the task is right there and it addressed it by the one
        // identifier a person ever sees.
        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /cheto_tasks, cheto_task and cheto_inbox/);
        assert.equal(sent.length, 0);
    });

    it('refuses a call with nothing to change', async () => {
        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 391 } } }], {
            fetchImpl: spy([]),
        });

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /Nothing to change/);
    });

    it('does not report success when requires_human did not take', async () => {
        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 391, requires_human: true } } }],
            { fetchImpl: spy([], { patched: { id: 391, requires_human: false } }) },
        );

        // A 200 with the gate still open is the one answer a model must not
        // read as "a person is holding this now".
        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /requires_human is still false/);
    });

    it('is satisfied when it did', async () => {
        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { id: 391, requires_human: true, title: 'Chase it' } } }],
            { fetchImpl: spy([], { patched: { id: 391, requires_human: true } }) },
        );

        assert.equal(answers[0].result.isError, undefined);
    });
});

describe('the credential decides the surface', () => {
    const human = { CHETO_TOKEN: 'cheto_ut_x' };

    const board = {
        data: [
            {
                id: 16,
                uuid: '0199a0de-0000-7000-8000-000000000001',
                name: 'Marketing & Reels',
                slug: 'marketing-reels',
                statuses: [{ id: 64, name: 'Esperando al cliente', key: 'esperando_al_cliente' }],
            },
        ],
    };

    it('offers both a person and an agent the board tools, and a person their own inbox', async () => {
        const asHuman = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }], { env: human });
        const asAgent = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);

        const names = (answers) => answers[0].result.tools.map((tool) => tool.name);

        assert.ok(names(asHuman).includes('cheto_area_create'));
        assert.ok(names(asHuman).includes('cheto_column_add'));

        // An agent reshapes a board when its membership has boards.manage; the
        // server refuses it otherwise. The tool is offered either way, under
        // its plain name, because an agent token is one agent.
        assert.ok(names(asAgent).includes('cheto_area_create'));
        assert.ok(names(asAgent).includes('cheto_column_add'));

        // A person has an inbox of their own now; the agent's is the twin, and
        // it cannot be called without naming which agent.
        assert.ok(names(asAgent).includes('cheto_inbox'));
        const own = asHuman[0].result.tools.find((tool) => tool.name === 'cheto_inbox');
        assert.equal(own.inputSchema.properties.agent, undefined);
        const twin = asHuman[0].result.tools.find((tool) => tool.name === 'cheto_agent_inbox');
        assert.ok(twin.inputSchema.required.includes('agent'));
    });

    it('talks to the human half of the API, not the agent half', async () => {
        const sent = [];

        await exchange(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                        name: 'cheto_area_create',
                        arguments: {
                            workspace: 'appsi',
                            name: 'Marketing & Reels',
                            columns: [{ name: 'Ideas', category: 'inbox' }],
                        },
                    },
                },
            ],
            {
                env: human,
                fetchImpl: async (url, options) => {
                    sent.push({ url, body: options.body ? JSON.parse(options.body) : null });

                    return { ok: true, status: 201, text: async () => JSON.stringify({ data: { id: 16 } }) };
                },
            },
        );

        assert.equal(sent[0].url, 'http://cheto.test/api/v1/cli/areas');
        assert.deepEqual(sent[0].body, {
            workspace: 'appsi',
            name: 'Marketing & Reels',
            columns: [{ name: 'Ideas', category: 'inbox' }],
        });
    });

    it('falls back to the workspace the server was started for', async () => {
        const sent = [];

        await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_areas', arguments: {} } }], {
            env: { ...human, CHETO_WORKSPACE: 'savia' },
            fetchImpl: async (url) => {
                sent.push(url);

                return { ok: true, status: 200, text: async () => JSON.stringify(board) };
            },
        });

        assert.equal(sent[0], 'http://cheto.test/api/v1/cli/areas?workspace=savia');
    });

    it('asks which workspace when nothing says', async () => {
        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_areas', arguments: {} } }], {
            env: human,
            fetchImpl: ok(board),
        });

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /CHETO_WORKSPACE/);
    });

    it('administers agents without any tool named for impersonating one', async () => {
        const names = (await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }], { env: human }))[0].result.tools.map(
            (tool) => tool.name,
        );

        // Everything `cheto agent …` does from a terminal, as tools.
        for (const tool of ['cheto_agents', 'cheto_agent_create', 'cheto_agent_update', 'cheto_agent_join', 'cheto_agent_pair', 'cheto_agent_token', 'cheto_agent_disconnect']) {
            assert.ok(names.includes(tool), `expected ${tool}`);
        }

        // And nothing that writes under an agent's name, or touches an account.
        assert.ok(!names.some((name) => /as_agent|impersonat|password|invite|role/.test(name)));
    });

    it('mints an agent credential against the membership, not the agent', async () => {
        const sent = [];

        await exchange(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'cheto_agent_token', arguments: { membership: 6, name: 'mcp' } },
                },
            ],
            {
                env: human,
                fetchImpl: async (url, options) => {
                    sent.push({ url, body: options.body ? JSON.parse(options.body) : null });

                    return { ok: true, status: 201, text: async () => JSON.stringify({ token: 'cheto_ak_x' }) };
                },
            },
        );

        // A credential is scoped to one membership — one agent in one workspace
        // — so that is what it is asked of.
        assert.equal(sent[0].url, 'http://cheto.test/api/v1/cli/memberships/6/credentials');
        assert.deepEqual(sent[0].body, { name: 'mcp' });
    });

    it('clears an agent\'s board on "none" rather than dropping the field', async () => {
        const sent = [];

        await exchange(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'cheto_agent_update', arguments: { agent: 6, workspace: 'appsi', area: 'none' } },
                },
            ],
            {
                env: human,
                fetchImpl: async (url, options) => {
                    sent.push({ url, body: options.body ? JSON.parse(options.body) : null });

                    return { ok: true, status: 200, text: async () => JSON.stringify({ agent: {}, membership: {} }) };
                },
            },
        );

        // Present and null is a value — "no board of its own". An absent field
        // would mean "leave it alone", which is the opposite instruction.
        assert.deepEqual(sent[0].body, { workspace: 'appsi', area: null });
    });

    it('reads a board back before writing to it again', async () => {
        const sent = [];

        await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_tasks', arguments: { area: 'Marketing & Reels' } } }], {
            env: { ...human, CHETO_WORKSPACE: 'appsi' },
            fetchImpl: async (url) => {
                sent.push(url);

                return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('/areas') ? board : { data: [] }) };
            },
        });

        // The board is named in words and resolved to an id before the listing
        // is asked for, so "Marketing & Reels" never reaches the query string.
        assert.equal(sent.at(-1), 'http://cheto.test/api/v1/cli/tasks?workspace=appsi&area=16');
    });

    it('files a task on the board it was told to, by name', async () => {
        const sent = [];

        await exchange(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'cheto_task_create', arguments: { workspace: 'appsi', title: 'Un reel', area: 'Marketing & Reels' } },
                },
            ],
            {
                env: human,
                fetchImpl: async (url, options) => {
                    sent.push({ url, body: options.body ? JSON.parse(options.body) : null });

                    return { ok: true, status: 201, text: async () => JSON.stringify(url.includes('/areas') ? board : { data: { id: 391 } }) };
                },
            },
        );

        assert.deepEqual(sent.at(-1).body, { workspace: 'appsi', title: 'Un reel', work_area_id: 16 });
    });

    it('refuses a board it cannot find rather than filing the task anywhere', async () => {
        const answers = await exchange(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'cheto_task_create', arguments: { workspace: 'appsi', title: 'Un reel', area: 'Marketng' } },
                },
            ],
            { env: human, fetchImpl: ok(board) },
        );

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /Marketing & Reels \(marketing-reels\)/);
    });

    // Triage: sorting a backlog somebody else filled. It is the job the agent
    // surface refuses by construction — an agent may act only on work it
    // created or holds — so it lives here, on a person's credential, or nowhere.
    it('moves a card to a column by name without being told which board', async () => {
        const sent = [];

        await exchange(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'cheto_task_update', arguments: { workspace: 'appsi', id: 430, column: 'Esperando al cliente' } },
                },
            ],
            {
                env: human,
                fetchImpl: async (url, options) => {
                    sent.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });

                    return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('/areas') ? board : { data: { id: 430 } }) };
                },
            },
        );

        assert.equal(sent.at(-1).url, 'http://cheto.test/api/v1/cli/tasks/430');
        assert.equal(sent.at(-1).method, 'PATCH');
        assert.deepEqual(sent.at(-1).body, { work_area_status_id: 64 });
    });

    it('refuses a column name that two boards share rather than choosing one', async () => {
        const twoBoards = {
            data: [
                board.data[0],
                { id: 17, uuid: '0199a0de-0000-7000-8000-000000000002', name: 'Soporte', slug: 'soporte', statuses: [{ id: 91, name: 'Esperando al cliente', key: 'waiting' }] },
            ],
        };

        const answers = await exchange(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'cheto_task_update', arguments: { workspace: 'appsi', id: 430, column: 'Esperando al cliente' } },
                },
            ],
            { env: human, fetchImpl: ok(twoBoards) },
        );

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /Marketing & Reels, Soporte/);
        assert.match(answers[0].result.content[0].text, /`area`/);
    });

    it('sends the column alone when a status came with it', async () => {
        const sent = [];

        await exchange(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'cheto_task_update', arguments: { workspace: 'appsi', id: 430, column: 'Esperando al cliente', status: 'inbox' } },
                },
            ],
            {
                env: human,
                fetchImpl: async (url, options) => {
                    sent.push({ url, body: options.body ? JSON.parse(options.body) : null });

                    return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('/areas') ? board : { data: { id: 430 } }) };
                },
            },
        );

        // Two vocabularies for one move is two chances to disagree, and the
        // column is the precise one.
        assert.deepEqual(sent.at(-1).body, { work_area_status_id: 64 });
    });

    it('takes a rejected idea off the board', async () => {
        const sent = [];

        await exchange(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'cheto_task_delete', arguments: { workspace: 'appsi', id: 430 } },
                },
            ],
            {
                env: human,
                fetchImpl: async (url, options) => {
                    sent.push({ url, method: options.method });

                    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { key: 'TASK-402', deleted: true } }) };
                },
            },
        );

        assert.equal(sent.at(-1).url, 'http://cheto.test/api/v1/cli/tasks/430');
        assert.equal(sent.at(-1).method, 'DELETE');
    });

    it('says a board key is not a task id, rather than asking for one that does not exist', async () => {
        for (const tool of ['cheto_task_update', 'cheto_task_delete']) {
            const answers = await exchange(
                [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { workspace: 'appsi', id: 'TASK-402', title: 'x' } } }],
                { env: human, fetchImpl: ok(board) },
            );

            assert.equal(answers[0].result.isError, true, tool);
            assert.match(answers[0].result.content[0].text, /not a task id/, tool);
        }
    });

    it('will not send an update that says nothing', async () => {
        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_update', arguments: { workspace: 'appsi', id: 430 } } }],
            { env: human, fetchImpl: ok(board) },
        );

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /at least one thing to say/);
    });
});

describe('one person\'s token, a team of agents', () => {
    const human = { CHETO_TOKEN: 'cheto_ut_secret' };
    const list = async (env) => (await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }], { env }))[0].result.tools;
    const recording = (sent, body = { data: { id: 7 } }) => async (url, options) => {
        sent.push({ url, headers: options.headers, body: options.body ? JSON.parse(options.body) : null });

        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };

    it('offers both sets, with no name twice and the agent twins named for the agent', async () => {
        const tools = await list(human);
        const names = tools.map((tool) => tool.name);

        assert.equal(new Set(names).size, names.length, 'a name offered twice is a coin toss for the client');

        for (const name of ['cheto_areas', 'cheto_agents', 'cheto_whoami', 'cheto_tasks', 'cheto_task_create', 'cheto_task_update', 'cheto_task_delete']) {
            assert.ok(names.includes(name), `expected the person's ${name}`);
        }

        for (const name of ['cheto_agent_inbox', 'cheto_agent_task_comment', 'cheto_task_claim', 'cheto_agent_whoami', 'cheto_agent_tasks', 'cheto_agent_task_create', 'cheto_agent_task_update']) {
            assert.ok(names.includes(name), `expected the agent's ${name}`);
        }

        // Every tool that acts as an agent requires saying which.
        for (const tool of tools.filter((one) => ['cheto_agent_inbox', 'cheto_agent_task_comment', 'cheto_task_claim', 'cheto_agent_whoami', 'cheto_agent_task_create'].includes(one.name))) {
            assert.ok(tool.inputSchema.required.includes('agent'), `${tool.name} must require agent`);
            assert.equal(tool.inputSchema.properties.agent.type, 'string');
            assert.ok(tool.inputSchema.properties.workspace);
        }

        // And the person's own do not ask for one.
        assert.equal(tools.find((tool) => tool.name === 'cheto_whoami').inputSchema.properties.agent, undefined);
    });

    it('acts as the agent it names, on the agent surface, with the person\'s token', async () => {
        const sent = [];

        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_agent_task_comment', arguments: { agent: 'magui.x1y2@cheto', id: 7, body: 'Done, see PR' } } }],
            { env: human, fetchImpl: recording(sent) },
        );

        assert.equal(answers[0].result.isError, undefined);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].url, 'http://cheto.test/api/v1/agent/tasks/7/comments');
        assert.equal(sent[0].headers.Authorization, 'Bearer cheto_ut_secret');
        assert.equal(sent[0].headers['X-Cheto-Agent'], 'magui.x1y2@cheto');
        assert.equal(sent[0].headers['X-Cheto-Workspace'], undefined);
        assert.deepEqual(sent[0].body, { body: 'Done, see PR' });
    });

    it('names the workspace when asked, and keys a retry to the agent', async () => {
        const sent = [];

        await exchange(
            [
                { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_claim', arguments: { agent: '@magui', workspace: 'appsi', id: 7 } } },
                { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cheto_task_claim', arguments: { agent: '@rocky', workspace: 'appsi', id: 7 } } },
            ],
            { env: human, fetchImpl: recording(sent) },
        );

        assert.equal(sent[0].headers['X-Cheto-Workspace'], 'appsi');
        assert.equal(sent[0].headers['X-Cheto-Agent'], '@magui');

        // Two agents doing the same thing are two things, not one retried.
        assert.match(sent[0].headers['Idempotency-Key'], /magui/);
        assert.notEqual(sent[0].headers['Idempotency-Key'], sent[1].headers['Idempotency-Key']);
    });

    it('defaults the workspace to the one the server was started for', async () => {
        const sent = [];

        await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_agent_inbox', arguments: { agent: 'magui' } } }], {
            env: { ...human, CHETO_WORKSPACE: 'savia' },
            fetchImpl: recording(sent, { summary: { has_work: false } }),
        });

        assert.equal(sent[0].url, 'http://cheto.test/api/v1/agent/inbox');
        assert.equal(sent[0].headers['X-Cheto-Workspace'], 'savia');
    });

    it('runs a twin as the agent under its agent name', async () => {
        const sent = [];

        await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_agent_whoami', arguments: { agent: 'rocky.a7f3@cheto' } } }], {
            env: human,
            fetchImpl: recording(sent, { via: 'user_token' }),
        });

        assert.equal(sent[0].url, 'http://cheto.test/api/v1/agent/me');
        assert.equal(sent[0].headers['X-Cheto-Agent'], 'rocky.a7f3@cheto');
    });

    it('refuses an agent tool with no agent, and sends nothing', async () => {
        const sent = [];

        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_agent_task_comment', arguments: { id: 7, body: 'hi' } } }], {
            env: human,
            fetchImpl: recording(sent),
        });

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /Pass `agent`/);
        assert.equal(sent.length, 0, 'it must never fall back to acting as the person');
    });

    it('refuses the person\'s tool when an agent was named, rather than acting as the person', async () => {
        const sent = [];

        const answers = await exchange(
            [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_task_create', arguments: { agent: '@magui', workspace: 'appsi', title: 'x' } } }],
            { env: human, fetchImpl: recording(sent) },
        );

        assert.equal(answers[0].result.isError, true);
        assert.match(answers[0].result.content[0].text, /cheto_agent_task_create/);
        assert.equal(sent.length, 0);
    });

    it('lists each agent with the id to pass and the workspace of each handle', async () => {
        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_agents', arguments: {} } }], {
            env: human,
            fetchImpl: ok({
                data: [
                    {
                        id: 3,
                        name: 'Magui',
                        address: 'magui.x1y2@cheto',
                        memberships: [{ id: 6, handle: 'magui', mention: '@magui', workspace: { id: 1, uuid: 'w-uuid', name: 'Appsi', slug: 'appsi' } }],
                    },
                ],
            }),
        });

        const result = JSON.parse(answers[0].result.content[0].text);

        assert.equal(result.act_as[0].agent, 'magui.x1y2@cheto');
        assert.deepEqual(result.act_as[0].handles[0], { agent: '@magui', workspace: 'w-uuid', workspace_name: 'Appsi', workspace_slug: 'appsi' });
        assert.match(result.how_to_act_as, /Pass `agent`/);
        assert.equal(result.data[0].id, 3, 'the raw list stays, for administering');
    });

    it('offers an agent token no agent argument and sends no agent header', async () => {
        const tools = await list({});
        const sent = [];

        assert.ok(tools.every((tool) => !tool.inputSchema.properties?.agent));
        assert.ok(!tools.some((tool) => tool.name.startsWith('cheto_agent_')));

        await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_inbox', arguments: {} } }], { fetchImpl: recording(sent, {}) });

        assert.equal(sent[0].url, 'http://cheto.test/api/v1/agent/inbox');
        assert.equal(sent[0].headers.Authorization, 'Bearer cheto_ak_x');
        assert.equal(sent[0].headers['X-Cheto-Agent'], undefined);
    });

    it('says a dead person\'s credential needs `cheto login`, and a dead agent\'s a new pairing', async () => {
        const asPerson = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_agent_inbox', arguments: { agent: '@magui' } } }], {
            env: human,
            fetchImpl: ok({ message: 'Unauthenticated.' }, 401),
        });
        const asAgent = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_inbox', arguments: {} } }], {
            fetchImpl: ok({ message: 'Unauthenticated.' }, 401),
        });

        assert.match(asPerson[0].result.content[0].text, /no longer valid \(revoked or expired/);
        assert.match(asPerson[0].result.content[0].text, /cheto login/);
        assert.match(asAgent[0].result.content[0].text, /no longer valid \(revoked or expired/);
        assert.match(asAgent[0].result.content[0].text, /pairing code/);
    });

    const refusals = [
        [400, 'agent_required', /Pass `agent`/],
        [400, 'agent_mismatch', /already is one agent/],
        [404, 'no_such_agent', /cheto_agents lists them/],
        [409, 'ambiguous_agent', /Pass `workspace`/],
        [403, 'missing_scope', /run `cheto login` again/],
    ];

    for (const [status, code, pattern] of refusals) {
        it(`explains ${code} with the server's own words, and not as a dead credential`, async () => {
            const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cheto_agent_inbox', arguments: { agent: '@magui' } } }], {
                env: human,
                fetchImpl: ok({ message: `Server says ${code}.`, error: code }, status),
            });

            const text = answers[0].result.content[0].text;

            assert.equal(answers[0].result.isError, true);
            assert.match(text, new RegExp(`Server says ${code}`));
            assert.match(text, pattern);
            assert.doesNotMatch(text, /no longer valid/);
        });
    }
});

describe('the whole system, as a person and as every agent', () => {
    const human = { CHETO_TOKEN: 'cheto_ut_secret' };
    const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

    const me = {
        user: { id: 1, name: 'Manuel' },
        membership: { id: 6, handle: 'magui', capabilities: ['tasks.create', 'channels.post'] },
        areas: [
            {
                id: 16,
                uuid: '0199a0de-0000-7000-8000-000000000001',
                name: 'Marketing & Reels',
                slug: 'marketing-reels',
                statuses: [
                    { id: 5, name: 'Ideas', key: 'inbox', category: 'inbox' },
                    { id: 64, name: 'Blocked', key: 'blocked', category: 'in_progress' },
                ],
            },
        ],
        participants: [],
    };

    const agents = {
        data: [{ id: 3, name: 'Magui', slug: 'magui', address: 'magui.x1y2@cheto', memberships: [{ id: 6, handle: 'magui', workspace: { id: 1, uuid: 'w-uuid', slug: 'appsi' } }] }],
    };

    const channels = { data: [{ id: 12, name: 'General', slug: 'general' }] };

    /** Answers the lookups by path, and records every request. */
    const server = (sent) => async (url, options) => {
        sent.push({ url, method: options.method ?? 'GET', headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
        const path = new URL(url).pathname;
        const body = path.endsWith('/me') ? me : path.endsWith('/agents') ? agents : path.endsWith('/channels') ? channels : { data: { id: 1 } };

        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };

    const run = async (name, args, env = human) => {
        const sent = [];
        const answers = await exchange([call(name, args)], { env, fetchImpl: server(sent) });

        return { sent, answer: answers[0].result };
    };

    const personCalls = [
        ['cheto_task', { id: 7 }, 'GET', '/cli/tasks/7', null],
        ['cheto_task_comment', { id: 7, body: 'hi' }, 'POST', '/cli/tasks/7/comments', { body: 'hi' }],
        ['cheto_inbox', {}, 'GET', '/cli/inbox', null],
        ['cheto_inbox', { workspace: 'appsi' }, 'GET', '/cli/inbox?workspace=appsi', null],
        ['cheto_reviews', { workspace: 'appsi' }, 'GET', '/cli/reviews?workspace=appsi', null],
        [
            'cheto_review_request',
            { task_id: 7, reviewer_type: 'user', reviewer_id: 9, note: 'please' },
            'POST',
            '/cli/tasks/7/reviews',
            { reviewer_type: 'user', reviewer_id: 9, note: 'please' },
        ],
        ['cheto_review_answer', { id: 4, status: 'approved' }, 'PATCH', '/cli/reviews/4', { status: 'approved' }],
        ['cheto_channels', { workspace: 'appsi' }, 'GET', '/cli/channels?workspace=appsi', null],
        ['cheto_channel_read', { channel: 12 }, 'GET', '/cli/channels/12/context', null],
        ['cheto_channel_post', { channel: 12, body: 'hola' }, 'POST', '/cli/channels/12/messages', { body: 'hola' }],
        ['cheto_memory', { workspace: 'appsi', q: 'deploy' }, 'GET', '/cli/memory?workspace=appsi&q=deploy', null],
        ['cheto_memory_write', { workspace: 'appsi', title: 'T', body: 'B' }, 'POST', '/cli/memory', { workspace: 'appsi', title: 'T', body: 'B' }],
        ['cheto_memory_update', { id: 5, body: 'B2' }, 'PATCH', '/cli/memory/5', { body: 'B2' }],
        ['cheto_memory_forget', { id: 5 }, 'DELETE', '/cli/memory/5', null],
        ['cheto_search', { workspace: 'appsi', q: 'deploy', kind: ['task', 'memory'] }, 'GET', '/cli/search?workspace=appsi&q=deploy&kind%5B%5D=task&kind%5B%5D=memory', null],
        [
            'cheto_task_update',
            { workspace: 'appsi', id: 430, due_on: '2026-10-01', assignee_type: 'user', assignee_id: 9 },
            'PATCH',
            '/cli/tasks/430',
            { due_on: '2026-10-01', assignee_type: 'user', assignee_id: 9 },
        ],
        ['cheto_agent_update', { agent: 3, workspace: 'appsi', capabilities: ['tasks.create', 'memory.write'] }, 'PATCH', '/cli/agents/3', { workspace: 'appsi', capabilities: ['tasks.create', 'memory.write'] }],
        ['cheto_agent_update', { agent: 3, workspace: 'appsi', capabilities: null }, 'PATCH', '/cli/agents/3', { workspace: 'appsi', capabilities: null }],
    ];

    for (const [name, args, method, path, body] of personCalls) {
        it(`${name} ${JSON.stringify(args)} is ${method} ${path} as the person`, async () => {
            const { sent, answer } = await run(name, args);

            assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
            assert.equal(sent.at(-1).method, method);
            assert.equal(sent.at(-1).url, `http://cheto.test/api/v1${path}`);
            assert.deepEqual(sent.at(-1).body, body);
            assert.equal(sent.at(-1).headers['X-Cheto-Agent'], undefined, 'a person\'s tool never names an agent');
        });
    }

    it('fills a missing workspace from CHETO_WORKSPACE, including for an agent\'s capabilities', async () => {
        const { sent } = await run('cheto_agent_update', { agent: 3, capabilities: ['tasks.create'] }, { ...human, CHETO_WORKSPACE: 'savia' });

        assert.deepEqual(sent.at(-1).body, { workspace: 'savia', capabilities: ['tasks.create'] });
    });

    it('finds a channel by name inside the workspace, never by a bare slug', async () => {
        const { sent } = await run('cheto_channel_post', { workspace: 'appsi', channel: '#general', body: 'hola' });

        assert.equal(sent[0].url, 'http://cheto.test/api/v1/cli/channels?workspace=appsi');
        assert.equal(sent.at(-1).url, 'http://cheto.test/api/v1/cli/channels/12/messages');
    });

    it('assigns to "me", to one of the person\'s agents by handle, and to nobody', async () => {
        const toMe = await run('cheto_task_update', { workspace: 'appsi', id: 430, assignee: 'me' });
        const toAgent = await run('cheto_task_update', { workspace: 'appsi', id: 430, assignee: '@magui' });
        const toNobody = await run('cheto_task_update', { workspace: 'appsi', id: 430, assignee: null });

        assert.deepEqual(toMe.sent.at(-1).body, { assignee_type: 'user', assignee_id: 1 });
        assert.deepEqual(toAgent.sent.at(-1).body, { assignee_type: 'agent', assignee_id: 3 });
        assert.deepEqual(toNobody.sent.at(-1).body, { assignee_type: null, assignee_id: null });
        assert.equal(toNobody.sent.length, 1, 'unassigning looks nobody up');
    });

    it('says how to name somebody who is not the person or their agent', async () => {
        const { answer, sent } = await run('cheto_task_update', { workspace: 'appsi', id: 430, assignee: '@stranger' });

        assert.equal(answer.isError, true);
        assert.match(answer.content[0].text, /assignee_type and assignee_id/);
        assert.ok(!sent.some((one) => one.method === 'PATCH'));
    });

    it('asks a review of an agent by handle', async () => {
        const { sent } = await run('cheto_review_request', { workspace: 'appsi', task_id: 7, reviewer: '@magui' });

        assert.deepEqual(sent.at(-1).body, { reviewer_type: 'agent', reviewer_id: 3 });
    });

    const agentCalls = [
        ['cheto_task_delete', { id: 7 }, 'DELETE', '/agent/tasks/7', null],
        ['cheto_area_create', { name: 'Soporte', columns: [{ name: 'Nuevo', category: 'inbox' }] }, 'POST', '/agent/areas', { name: 'Soporte', columns: [{ name: 'Nuevo', category: 'inbox' }] }],
        ['cheto_area_update', { area: 'Marketing & Reels', name: 'Reels' }, 'PATCH', '/agent/areas/16', { name: 'Reels' }],
        ['cheto_column_add', { area: 'marketing-reels', name: 'Waiting', category: 'review' }, 'POST', '/agent/areas/16/columns', { name: 'Waiting', category: 'review' }],
        ['cheto_column_update', { area: 16, column: 'Blocked', name: 'Stuck' }, 'PATCH', '/agent/areas/16/columns/64', { name: 'Stuck' }],
        ['cheto_columns_reorder', { area: '16', order: ['Blocked', 'Ideas'] }, 'PUT', '/agent/areas/16/columns', { order: [64, 5] }],
        ['cheto_column_remove', { area: 'Marketing & Reels', column: 'Blocked', into: 'Ideas' }, 'DELETE', '/agent/areas/16/columns/64', { into: 5 }],
        ['cheto_memory_update', { id: 5, title: 'T2' }, 'PATCH', '/agent/memory/5', { title: 'T2' }],
        ['cheto_memory_forget', { id: 5 }, 'DELETE', '/agent/memory/5', null],
    ];

    for (const [name, args, method, path, body] of agentCalls) {
        it(`${name} is ${method} ${path} on an agent token, and ${name.replace(/^cheto_/, 'cheto_agent_')} on a person's`, async () => {
            const asAgent = await run(name, args, {});

            assert.equal(asAgent.answer.isError, undefined, asAgent.answer.content?.[0]?.text);
            assert.equal(asAgent.sent.at(-1).method, method);
            assert.equal(asAgent.sent.at(-1).url, `http://cheto.test/api/v1${path}`);
            assert.deepEqual(asAgent.sent.at(-1).body, body);
            assert.equal(asAgent.sent.at(-1).headers['X-Cheto-Agent'], undefined);

            const renamed = name.replace(/^cheto_/, 'cheto_agent_');
            const asPerson = await run(renamed, { agent: '@magui', ...args });

            assert.equal(asPerson.answer.isError, undefined, asPerson.answer.content?.[0]?.text);
            assert.equal(asPerson.sent.at(-1).method, method);
            assert.equal(asPerson.sent.at(-1).url, `http://cheto.test/api/v1${path}`);
            assert.deepEqual(asPerson.sent.at(-1).body, body);
            assert.equal(asPerson.sent.at(-1).headers['X-Cheto-Agent'], '@magui');
            assert.equal(asPerson.sent.at(-1).headers.Authorization, 'Bearer cheto_ut_secret');
        });
    }

    it('refuses the person\'s board tool when handed an agent, naming the agent\'s', async () => {
        const { answer, sent } = await run('cheto_column_add', { agent: '@magui', area: '16', name: 'x', category: 'inbox' });

        assert.equal(answer.isError, true);
        assert.match(answer.content[0].text, /cheto_agent_column_add/);
        assert.equal(sent.length, 0);
    });

    it('offers no name twice in person mode, and every shared tool as both', async () => {
        const tools = (await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }], { env: human }))[0].result.tools;
        const names = tools.map((tool) => tool.name);

        assert.equal(new Set(names).size, names.length);

        for (const name of ['cheto_task', 'cheto_task_comment', 'cheto_inbox', 'cheto_reviews', 'cheto_review_request', 'cheto_review_answer', 'cheto_channels', 'cheto_channel_read', 'cheto_channel_post', 'cheto_memory', 'cheto_memory_write', 'cheto_memory_update', 'cheto_memory_forget', 'cheto_search', 'cheto_task_delete', 'cheto_area_create', 'cheto_column_remove']) {
            const person = tools.find((tool) => tool.name === name);
            const agent = tools.find((tool) => tool.name === name.replace(/^cheto_/, 'cheto_agent_'));

            assert.ok(person, `expected the person's ${name}`);
            assert.equal(person.inputSchema.properties.agent, undefined, `${name} must not take agent`);
            assert.ok(agent?.inputSchema.required.includes('agent'), `expected the agent's twin of ${name}, requiring agent`);
        }

        // Every agent tool is reachable in person mode, under one name or the other.
        for (const tool of TOOLS) {
            const reachable = tools.find((one) => (one.name === tool.name || one.name === tool.name.replace(/^cheto_/, 'cheto_agent_')) && one.inputSchema.required?.includes('agent'));

            assert.ok(reachable, `${tool.name} has no agent variant in person mode`);
        }
    });

    it('spells out an agent\'s capabilities in whoami, and that closing is never one', async () => {
        const asAgent = JSON.parse((await run('cheto_whoami', {}, {})).answer.content[0].text);
        const asPerson = JSON.parse((await run('cheto_agent_whoami', { agent: '@magui' })).answer.content[0].text);

        for (const result of [asAgent, asPerson]) {
            assert.deepEqual(result.what_you_may_do.capabilities, ['tasks.create', 'channels.post']);
            assert.ok(result.what_you_may_do.allowed.some((line) => line.startsWith('tasks.create')));
            assert.ok(result.what_you_may_do.not_allowed.some((line) => line.startsWith('tasks.delete')));
            assert.ok(result.what_you_may_do.not_allowed.some((line) => line.startsWith('boards.manage')));
            assert.match(result.what_you_may_do.never, /done/);
            assert.deepEqual(result.membership, me.membership, 'the raw answer stays');
        }
    });

    it('sends an agent\'s search kinds as the list the server validates', async () => {
        const { sent } = await run('cheto_search', { q: 'deploy', kind: 'task' }, {});

        assert.equal(sent[0].url, 'http://cheto.test/api/v1/agent/search?q=deploy&kind%5B%5D=task');
    });

    it('names the talk permission when an older token lacks it', async () => {
        const answers = await exchange([call('cheto_channel_post', { channel: 12, body: 'hola' })], {
            env: human,
            fetchImpl: ok({ message: 'This credential was not granted that.' }, 403),
        });
        const text = answers[0].result.content[0].text;

        assert.match(text, /`talk:write`/);
        assert.match(text, /run `cheto login` again, or edit the token's permissions in the panel/);
    });

    it('explains an agent\'s refusal by its capabilities, and done as never allowed', async () => {
        const answers = await exchange([call('cheto_task_delete', { id: 7 })], { fetchImpl: ok({ message: 'This membership may not delete tasks.' }, 403) });
        const text = answers[0].result.content[0].text;

        assert.match(text, /may not delete tasks/);
        assert.match(text, /tasks\.delete/);
        assert.match(text, /never set a task to done/);
    });
});

describe('CHETO_TOOLS', () => {
    it('agents: only the agent tools under their plain names, each requiring agent, plus cheto_agents', async () => {
        const [answer] = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], { env: { CHETO_TOOLS: 'agents', CHETO_TOKEN: 'cheto_ut_x' } });
        const names = answer.result.tools.map((tool) => tool.name);

        assert.ok(names.includes('cheto_agents'));
        assert.ok(names.includes('cheto_inbox'));
        assert.ok(names.includes('cheto_task_create'));
        assert.ok(!names.some((name) => name.startsWith('cheto_agent_') && name !== 'cheto_agents'));
        assert.ok(!names.includes('cheto_area_create') || answer.result.tools.find((tool) => tool.name === 'cheto_area_create').inputSchema.required.includes('agent'));
        for (const tool of answer.result.tools.filter((tool) => tool.name !== 'cheto_agents')) {
            assert.ok(tool.inputSchema.required.includes('agent'), `${tool.name} must require agent`);
        }
        assert.equal(new Set(names).size, names.length);
    });

    it('person: only the person tools', async () => {
        const [answer] = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], { env: { CHETO_TOOLS: 'person', CHETO_TOKEN: 'cheto_ut_x' } });
        const names = answer.result.tools.map((tool) => tool.name);

        assert.ok(names.includes('cheto_areas'));
        assert.ok(!names.includes('cheto_heartbeat'));
    });
});
