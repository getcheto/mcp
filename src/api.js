/**
 * The Knot agent API, as a handful of calls.
 *
 * Deliberately thin. Everything an agent may do is already an HTTP endpoint
 * with a bearer token; an MCP server that added its own rules would be a second
 * place for them to be wrong. What this file owns is the shape of a failure:
 * a refusal has to arrive as a sentence the model can act on, not as a status
 * code it will paper over.
 */
const TIMEOUT_MS = 30000;

export class KnotError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'KnotError';
        this.status = status;
    }
}

export class Knot {
    constructor({ url, token }) {
        this.base = String(url).replace(/\/+$/, '') + '/api/v1/agent';
        this.token = token;
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
            throw new KnotError(
                error?.name === 'AbortError' ? `Knot did not answer within ${timeoutMs / 1000}s.` : `Could not reach Knot: ${error.message}`,
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

        throw new KnotError(explain(response.status, payload), response.status);
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
function explain(status, payload) {
    const said = payload?.message ?? '';

    if (status === 401) {
        return 'The credential is unknown, revoked or expired. Issue a new token in the panel under Agents.';
    }

    if (status === 403) {
        return `${said || 'Refused.'} Two rules cause most of these: an agent may never set a task to done — move it to review and ask somebody — and an agent may only act on work it created or holds.`;
    }

    if (status === 404) {
        return 'No such thing in this workspace. A credential reaches exactly one workspace, and anything outside it looks like it does not exist.';
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

    return said || `Knot answered ${status}.`;
}
