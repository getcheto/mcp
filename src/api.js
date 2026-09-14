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
     * Which half of the API this credential belongs to, from the credential.
     *
     * `cheto_ak_…` is an agent: one workspace, fixed by the token, and no say in
     * how the room is arranged. `cheto_ut_…` is a person from a terminal: several
     * workspaces, which is why those tools ask which one, and the authority to
     * create a board — which an agent credential does not have and is not going
     * to be given. Two surfaces, two tool sets, and the token decides.
     */
    constructor({ url, token, workspace = null }) {
        this.surface = String(token ?? '').startsWith('cheto_ut_') ? 'cli' : 'agent';
        this.base = String(url).replace(/\/+$/, '') + `/api/v1/${this.surface}`;
        this.token = token;

        // A default for `workspace`, so an MCP entry pointed at one workspace
        // does not make the model repeat its name in every call. One server per
        // workspace is a reasonable way to run this.
        this.workspace = workspace;
    }

    async call(path, { method = 'GET', body = null, idempotencyKey = null, timeoutMs = TIMEOUT_MS } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const headers = {
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
            response = await fetch(this.base + path, {
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

        throw new ChetoError(explain(response.status, payload, this.surface), response.status);
    }
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
 */
function explain(status, payload, surface = 'agent') {
    const said = payload?.message ?? '';

    if (status === 401) {
        return surface === 'cli'
            ? 'The credential is unknown, revoked or expired. Run `cheto login` again.'
            : 'The credential is unknown, revoked or expired. Issue a new token in the panel under Agents.';
    }

    if (status === 403) {
        return surface === 'cli'
            ? `${said || 'Refused.'} A terminal credential reaches the workspaces you are a member of, and only what \`cheto login\` granted it — one minted before a scope existed does not have that scope, and running \`cheto login\` again is how it gets one.`
            : `${said || 'Refused.'} Two rules cause most of these: an agent may never set a task to done — move it to review and ask somebody — and an agent may only act on work it created or holds.`;
    }

    if (status === 404) {
        return surface === 'cli'
            ? 'No such thing you can reach. A terminal credential sees the workspaces you belong to, and a board is named by uuid or id here — never by slug, which would be ambiguous across two of them.'
            : 'No such thing in this workspace. A credential reaches exactly one workspace, and anything outside it looks like it does not exist.';
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
