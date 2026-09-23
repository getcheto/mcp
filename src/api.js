/**
 * The Cheto agent API, as a handful of calls.
 *
 * Deliberately thin. Everything an agent may do is already an HTTP endpoint
 * with a bearer token; an MCP server that added its own rules would be a second
 * place for them to be wrong. What this file owns is the shape of a failure:
 * a refusal has to arrive as a sentence the model can act on, not as a status
 * code it will paper over.
 */
const TIMEOUT_MS = 30000;

export class ChetoError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'ChetoError';
        this.status = status;
    }
}

export class Cheto {
    /**
     * Which kind of credential this is, from the credential.
     *
     * `cheto_ak_…` is an agent: one workspace, fixed by the token, and no say in
     * how the room is arranged. `cheto_ut_…` is a person from a terminal: several
     * workspaces, which is why those tools ask which one, and the authority to
     * create a board — which an agent credential does not have and is not going
     * to be given.
     *
     * `surface` is where a call goes when it does not say: `/api/v1/cli` for a
     * person, `/api/v1/agent` for an agent. A person's credential can also reach
     * the agent surface, as one of their own agents — see `actingAs`.
     */
    constructor({ url, token, workspace = null }) {
        this.kind = String(token ?? '').startsWith('cheto_ut_') ? 'user' : 'agent';
        this.surface = this.kind === 'user' ? 'cli' : 'agent';
        this.root = String(url).replace(/\/+$/, '') + '/api/v1/';
        this.token = token;

        // A default for `workspace`, so an MCP entry pointed at one workspace
        // does not make the model repeat its name in every call. One server per
        // workspace is a reasonable way to run this.
        this.workspace = workspace;
    }

    /**
     * The same credential, speaking on the agent surface as one agent.
     *
     * Only a person's credential does this, and only for an agent that person
     * owns: the server checks both, on every request, and answers 404 for
     * anybody else's. What this adds is the header that names the agent, so
     * the call is attributed to it — never to the person — and an idempotency
     * key that carries the agent too, because two agents filing the same title
     * are two tasks, not a retry.
     *
     * The returned object has the same `call` the agent tools already use, so
     * they run unchanged against it.
     */
    actingAs(agent, workspace = null) {
        const named = String(agent ?? '').trim();

        if (named === '') {
            throw new ChetoError('Say which agent to act as. Pass `agent`: its Cheto address (rocky.a7f3@cheto) or its @handle. cheto_agents lists them.', 0);
        }

        const where = String(workspace ?? this.workspace ?? '').trim();
        const headers = { 'X-Cheto-Agent': named, ...(where ? { 'X-Cheto-Workspace': where } : {}) };
        const suffix = `-as-${keyPart(named)}${where ? `-in-${keyPart(where)}` : ''}`;

        return {
            kind: this.kind,
            surface: 'agent',
            agent: named,
            workspace: where || null,
            call: (path, options = {}) =>
                this.call(path, {
                    ...options,
                    surface: 'agent',
                    headers: { ...headers, ...(options.headers ?? {}) },
                    idempotencyKey: options.idempotencyKey ? options.idempotencyKey + suffix : null,
                }),
        };
    }

    async call(path, { method = 'GET', body = null, idempotencyKey = null, timeoutMs = TIMEOUT_MS, surface = this.surface, headers: extra = {} } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const headers = {
            ...extra,
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
        };

        if (body !== null) {
            headers['Content-Type'] = 'application/json';
        }

        // Opt-in, so a read is never charged for a retry it did not ask for.
        if (idempotencyKey) {
            headers['Idempotency-Key'] = idempotencyKey;
        }

        let response;

        try {
            response = await fetch(this.root + surface + path, {
                method,
                headers,
                body: body === null ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (error) {
            throw new ChetoError(
                error?.name === 'AbortError' ? `Cheto did not answer within ${timeoutMs / 1000}s.` : `Could not reach Cheto: ${error.message}`,
                0,
            );
        } finally {
            clearTimeout(timer);
        }

        const text = await response.text();
        const payload = text ? safeParse(text) : null;

        if (response.ok) {
            return payload;
        }

        throw new ChetoError(
            explain(response.status, payload, { surface, kind: this.kind, agent: extra['X-Cheto-Agent'] ?? null, method, path }),
            response.status,
        );
    }
}

/** An agent or workspace name as a piece of an idempotency key. */
function keyPart(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
}

/** The sentence the server answers a missing scope with, in English and Spanish. */
const MISSING_SCOPE = /not granted that|no tiene ese permiso/i;

/**
 * Which scope a call on the person's surface needs, mirroring routes/api.php.
 *
 * Only used to name it in a refusal, so a person knows what to grant rather
 * than which command to rerun blind. The server remains the one that decides.
 */
function cliScopeFor(method, path) {
    const route = String(path).split('?')[0];
    const reading = String(method).toUpperCase() === 'GET';
    const first = route.split('/').filter(Boolean)[0] ?? '';

    if (['me', 'agents'].includes(first)) {
        return reading ? 'agents:read' : 'agents:write';
    }

    if (['memberships', 'connections'].includes(first)) {
        return 'machines:write';
    }

    if (first === 'areas') {
        return reading ? 'work:read' : 'work:write';
    }

    if (['tasks', 'reviews', 'inbox'].includes(first)) {
        return reading ? 'tasks:read' : 'tasks:write';
    }

    if (['channels', 'memory', 'search'].includes(first)) {
        return reading ? 'talk:read' : 'talk:write';
    }

    return null;
}

function safeParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return { message: text.slice(0, 200) };
    }
}

/**
 * Why the call was refused, in words the caller can use.
 *
 * A model handed `403` will try again with different arguments. A model handed
 * "an agent may never close a task; move it to review and ask somebody" stops
 * and does the right thing, so the rule is stated where the refusal happens.
 *
 * Only a 401 means the credential is dead. The codes for naming an agent —
 * `agent_required`, `agent_mismatch`, `no_such_agent`, `ambiguous_agent` — and
 * `missing_scope` are about this one call, and are explained as such: telling
 * somebody to log in again because they misspelled a handle sends them the
 * wrong way.
 */
function explain(status, payload, { surface = 'agent', kind = 'agent', agent = null, method = 'GET', path = '' } = {}) {
    const said = payload?.message ?? '';
    const code = payload?.error ?? null;

    if (status === 401) {
        if (kind === 'user') {
            return (
                'This credential is no longer valid (revoked or expired; a `cheto login` token lasts 90 days). ' +
                'Run `cheto login` again, then restart this MCP server so it reads the new one.' +
                (agent ? ` If only calls as ${agent} are refused this way, the connection for that agent was disconnected in the panel; the next call as it opens a new one once the credential is valid.` : '')
            );
        }

        return 'This credential is no longer valid (revoked or expired). Connect this machine again with a new pairing code (`cheto connect <code>`), or issue a new token in the panel under Agents, and restart this MCP server.';
    }

    if (code === 'agent_required') {
        return `${said || 'This call needs an agent to act as.'} Pass \`agent\`: the agent's full Cheto address (rocky.a7f3@cheto). cheto_agents lists the ones you can act as.`;
    }

    if (code === 'agent_address_required') {
        return `${said || 'Name the agent by its full address.'} A bare handle can belong to more than one agent. cheto_agents lists each address.`;
    }

    if (code === 'agent_mismatch') {
        return `${said || 'This credential is a different agent.'} An agent credential already is one agent; it cannot act as another. Use a person's credential (\`cheto login\`) to act as several.`;
    }

    if (code === 'no_such_agent') {
        return `${said || 'No such agent.'} Only an agent you own, with an active place in a workspace, can be acted as — named by its full Cheto address (rocky.a7f3@cheto). cheto_agents lists them.`;
    }

    if (code === 'ambiguous_agent') {
        return `${said || 'That agent works in several workspaces.'} Pass \`workspace\` (uuid or slug) to say which one. cheto_agents shows the workspace of each of its handles.`;
    }

    // The CLI surface refuses a missing scope with a plain 403 and a sentence,
    // no code — so it is recognised by that sentence, in either locale the
    // server ships, as well as by the code the delegated agent path sends.
    if (code === 'missing_scope' || (surface === 'cli' && status === 403 && MISSING_SCOPE.test(said))) {
        const scope = surface === 'cli' ? cliScopeFor(method, path) : null;
        const talk = scope?.startsWith('talk:');

        return (
            `${said || 'This credential lacks a scope this needs.'}` +
            (scope ? ` This call needs the \`${scope}\` permission.` : '') +
            (talk
                ? ' Channels, memory and search became reachable from a terminal after many tokens were minted, so an older token does not have it:'
                : ' A credential minted before that scope existed does not have it:') +
            " run `cheto login` again, or edit the token's permissions in the panel, then restart this MCP server."
        );
    }

    if (status === 403) {
        return surface === 'cli'
            ? `${said || 'Refused.'} A terminal credential reaches the workspaces you are a member of, the agents the token covers, and only what \`cheto login\` granted it — one minted before a scope existed does not have that scope, and running \`cheto login\` again (or editing the token in the panel) is how it gets one.`
            : `${said || 'Refused.'} Two things cause these. First, an agent may never set a task to done — move it to review and ask somebody. Second, everything else an agent may do is its membership's capabilities (membership.capabilities in cheto_whoami, or cheto_agent_whoami on a person's token: tasks.create, tasks.edit_any, tasks.delete, boards.manage, channels.post, memory.write); without tasks.edit_any it may only act on work it created or holds. Only the agent's owner changes them, in the panel or with cheto_agent_update.`;
    }

    if (status === 404) {
        return surface === 'cli'
            ? 'No such thing you can reach. A terminal credential sees the workspaces you belong to, and a board is named by uuid or id here — never by slug, which would be ambiguous across two of them.'
            : 'No such thing in this workspace. An agent reaches exactly one workspace, and anything outside it looks like it does not exist.';
    }

    if (status === 422) {
        const fields = Object.entries(payload?.errors ?? {})
            .map(([field, problems]) => `${field}: ${[].concat(problems).join(' ')}`)
            .join('; ');

        return fields ? `Validation failed — ${fields}` : said || 'Validation failed.';
    }

    if (status === 429) {
        return 'Rate limited. Wait and try again; the polling endpoints allow 240 a minute and the rest 120.';
    }

    return said || `Cheto answered ${status}.`;
}
