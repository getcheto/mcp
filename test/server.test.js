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

    it('offers a person the tools that shape a board, and an agent none of them', async () => {
        const asHuman = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }], { env: human });
        const asAgent = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);

        const names = (answers) => answers[0].result.tools.map((tool) => tool.name);

        assert.ok(names(asHuman).includes('cheto_area_create'));
        assert.ok(names(asHuman).includes('cheto_column_add'));

        // The wall, in the one place a model could have walked through it: an
        // agent credential is never handed a tool that redraws the room.
        assert.ok(!names(asAgent).includes('cheto_area_create'));
        assert.ok(!names(asAgent).includes('cheto_column_add'));

        // And the reverse, so neither set is quietly a superset of the other:
        // a person's credential is not an agent and has no inbox of its own.
        assert.ok(names(asAgent).includes('cheto_inbox'));
        assert.ok(!names(asHuman).includes('cheto_inbox'));
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

    it('administers agents without ever being able to speak as one', async () => {
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
});
