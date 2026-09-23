/**
 * Cheto over MCP, on stdio.
 *
 * JSON-RPC by hand rather than through an SDK, for the same reason the CLI has
 * no dependencies: this is a thing somebody downloads and points their agent at,
 * and every package in it is a package they have to trust and update. The
 * protocol surface an stdio server needs is three methods.
 *
 * Settings come from the environment, because an MCP client launches this with a
 * command and an env block and has nowhere else to put them:
 *
 *   CHETO_URL        where Cheto is
 *   CHETO_TOKEN      the credential — `cheto_ak_…` for an agent, `cheto_ut_…` for a
 *                   person from `cheto login`
 *   CHETO_AS         `user` reads the person's own credential from the keychain
 *   CHETO_AGENT      which connected agent to act as, when the bridge armed several
 *   CHETO_WORKSPACE  with a human credential, the workspace to act in by default,
 *                   so one MCP entry per workspace needs no argument repeated
 *
 * **The token decides which tools exist.** An agent credential gets the work
 * tools, as the one agent the token is. A human one gets the tools that shape
 * the boards, which an agent credential may not have and is not going to be
 * given — and the work tools as well, each requiring `agent`: one of the
 * person's own agents to act as, checked by the server on every call. That is
 * how one server and one token serve a team of agents, each under its own name.
 * See toolset.js for how the two sets are kept from being mistaken for each
 * other.
 *
 * All three are optional together: on a machine that has run `cheto connect`,
 * leaving them unset reads the credential the bridge already put in the OS
 * keychain, so no token has to be pasted into a config file. See credentials.js.
 *
 * The token is never logged. Errors go to stderr, which the client shows and
 * the model does not read.
 */
import { Cheto, ChetoError } from './api.js';
import { resolveCredential } from './credentials.js';
import { toolsFor } from './toolset.js';

const PROTOCOL_VERSION = '2024-11-05';

export async function serve({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
    const credential = await resolveCredential(env);
    const { url, token } = credential;

    const cheto = new Cheto({ url, token, workspace: env.CHETO_WORKSPACE ?? null });
    const tools = toolsFor(cheto.kind);

    // Where the credential came from, who it is and which half of the API it
    // reaches — never what it is. A person debugging "why is it commenting as
    // Rocky", or "why is there no cheto_inbox", needs this line; a screen
    // recording must not capture a bearer token.
    process.stderr.write(
        cheto.kind === 'user'
            ? `cheto-mcp: ${url} (human credential from ${credential.source}; agent tools act as the agent each call names)\n`
            : `cheto-mcp: ${url}${credential.handle ? ` as @${credential.handle}` : ''} (agent credential from ${credential.source})\n`,
    );

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

        const answer = await handle(cheto, tools, request);

        // A notification has no id and expects no reply. Answering one is a
        // protocol error, not a harmless extra.
        if (answer !== null && request.id !== undefined) {
            write({ jsonrpc: '2.0', id: request.id, ...answer });
        }
    }
}

async function handle(cheto, tools, request) {
    const { method, params } = request;

    if (method === 'initialize') {
        return {
            result: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'cheto', version: '0.1.0' },
            },
        };
    }

    if (method === 'tools/list') {
        return {
            result: {
                tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
            },
        };
    }

    if (method === 'tools/call') {
        const tool = tools.find((candidate) => candidate.name === params?.name);

        if (!tool) {
            return { error: { code: -32602, message: `No tool called ${params?.name}.` } };
        }

        try {
            const result = await tool.run(cheto, params.arguments ?? {});

            return { result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
        } catch (error) {
            // A refusal is an answer, not a transport failure: returned as tool
            // content with isError so the model reads the reason and adapts,
            // rather than as a protocol error it never sees.
            return {
                result: {
                    content: [{ type: 'text', text: error instanceof ChetoError ? error.message : String(error?.message ?? error) }],
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
