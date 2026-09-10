/**
 * Knot over MCP, on stdio.
 *
 * JSON-RPC by hand rather than through an SDK, for the same reason the CLI has
 * no dependencies: this is a thing somebody downloads and points their agent at,
 * and every package in it is a package they have to trust and update. The
 * protocol surface an stdio server needs is three methods.
 *
 * Two settings, both from the environment, because an MCP client launches this
 * with a command and an env block and has nowhere else to put them:
 *
 *   KNOT_URL     where Knot is
 *   KNOT_TOKEN   the agent credential, from the panel under Agents
 *
 * The token is never logged. Errors go to stderr, which the client shows and
 * the model does not read.
 */
import { Knot, KnotError } from './api.js';
import { TOOLS } from './tools.js';

const PROTOCOL_VERSION = '2024-11-05';

export async function serve({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
    const url = env.KNOT_URL;
    const token = env.KNOT_TOKEN;

    if (!url || !token) {
        throw new Error('KNOT_URL and KNOT_TOKEN are both required. The token comes from the panel: Agents → the agent → Issue token.');
    }

    const knot = new Knot({ url, token });
    const write = (message) => output.write(JSON.stringify(message) + '\n');

    for await (const line of lines(input)) {
        if (line.trim() === '') {
            continue;
        }

        let request;

        try {
            request = JSON.parse(line);
        } catch {
            // No id to answer to, so there is nobody to tell.
            continue;
        }

        const answer = await handle(knot, request);

        // A notification has no id and expects no reply. Answering one is a
        // protocol error, not a harmless extra.
        if (answer !== null && request.id !== undefined) {
            write({ jsonrpc: '2.0', id: request.id, ...answer });
        }
    }
}

async function handle(knot, request) {
    const { method, params } = request;

    if (method === 'initialize') {
        return {
            result: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'knot', version: '0.1.0' },
            },
        };
    }

    if (method === 'tools/list') {
        return {
            result: {
                tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
            },
        };
    }

    if (method === 'tools/call') {
        const tool = TOOLS.find((candidate) => candidate.name === params?.name);

        if (!tool) {
            return { error: { code: -32602, message: `No tool called ${params?.name}.` } };
        }

        try {
            const result = await tool.run(knot, params.arguments ?? {});

            return { result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
        } catch (error) {
            // A refusal is an answer, not a transport failure: returned as tool
            // content with isError so the model reads the reason and adapts,
            // rather than as a protocol error it never sees.
            return {
                result: {
                    content: [{ type: 'text', text: error instanceof KnotError ? error.message : String(error?.message ?? error) }],
                    isError: true,
                },
            };
        }
    }

    if (method === 'ping') {
        return { result: {} };
    }

    // Notifications from the client, which are not questions.
    if (String(method).startsWith('notifications/')) {
        return null;
    }

    return { error: { code: -32601, message: `Unsupported method: ${method}` } };
}

async function* lines(stream) {
    let buffer = '';

    for await (const chunk of stream) {
        buffer += chunk.toString('utf8');

        let index = buffer.indexOf('\n');

        while (index !== -1) {
            yield buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
        }
    }

    if (buffer.trim() !== '') {
        yield buffer;
    }
}
