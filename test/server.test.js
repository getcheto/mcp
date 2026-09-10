/**
 * The protocol, and the one decision worth pinning.
 *
 * A refusal from Knot is an answer, not a transport failure. Returned as tool
 * content with `isError`, the model reads why and adapts; returned as a JSON-RPC
 * error it never sees the reason and retries the same call with different
 * arguments. Everything else here is protocol shape.
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { serve } from '../src/server.js';
import { TOOLS } from '../src/tools.js';

async function exchange(requests, { fetchImpl } = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];

    output.on('data', (chunk) => chunks.push(chunk.toString()));

    const original = globalThis.fetch;

    if (fetchImpl) {
        globalThis.fetch = fetchImpl;
    }

    const running = serve({ input, output, env: { KNOT_URL: 'http://knot.test', KNOT_TOKEN: 'knot_ak_x' } });

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

        assert.equal(answers[0].result.serverInfo.name, 'knot');
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
        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knot_task_update', arguments: { id: 1, status: 'done' } } }], {
            fetchImpl: ok({ message: 'This action is unauthorized.' }, 403),
        });

        const [answer] = answers;

        assert.equal(answer.error, undefined, 'a refusal must not arrive as a protocol error');
        assert.equal(answer.result.isError, true);
        assert.match(answer.result.content[0].text, /never set a task to done/);
    });

    it('explains a dead credential instead of repeating the number', async () => {
        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knot_whoami', arguments: {} } }], {
            fetchImpl: ok({ message: 'Unauthenticated.' }, 401),
        });

        assert.match(answers[0].result.content[0].text, /revoked or expired/);
    });

    it('refuses a tool it does not have', async () => {
        const answers = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knot_delete_everything', arguments: {} } }]);

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
        const update = TOOLS.find((tool) => tool.name === 'knot_task_update');

        assert.ok(!update.inputSchema.properties.status.enum.includes('done'));
    });
});
