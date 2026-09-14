/**
 * Where this server gets its credential.
 *
 * `CHETO_URL` and `CHETO_TOKEN` in the environment is the documented way, and it
 * stays the first answer: an MCP client launches a command with an env block and
 * has nowhere else to put them.
 *
 * It is also the wrong shape for a machine that already ran `cheto connect`. The
 * bridge put a credential in the OS keychain precisely so it would not have to
 * live in a config file, and asking somebody to issue a *second* token and paste
 * it into `mcps.json` undoes that — the token ends up in a JSON file, in a
 * backup, and in whatever syncs the home directory.
 *
 * So when `CHETO_TOKEN` is absent this reads what the bridge already stored:
 * `~/.config/cheto/session.json` says which agents are connected and where, and
 * the keychain holds the token under `cheto-bridge` / `<url>#agent:<handle>`.
 * Same store, same key, read-only — nothing here writes a credential.
 *
 * `CHETO_AGENT=<handle>` picks between several. With several connected and
 * nothing to pick, this **refuses and names them** rather than choosing: acting
 * as the wrong agent puts one agent's comment under another's name, and there is
 * no taking that back from here.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SERVICE = 'cheto-bridge';
const SESSION_FILE = join(homedir(), '.config', 'cheto', 'session.json');
const FALLBACK_FILE = join(homedir(), '.config', 'cheto', 'credentials.json');

/**
 * The credential this server acts with.
 *
 * @returns {Promise<{url: string, token: string, handle: string|null, source: string}>}
 */
export async function resolveCredential(env = process.env) {
    if (env.CHETO_TOKEN) {
        if (!env.CHETO_URL) {
            throw new Error('CHETO_TOKEN was given without CHETO_URL. Both are needed, or neither — drop both to use the credential this machine already stored.');
        }

        return { url: env.CHETO_URL, token: env.CHETO_TOKEN, handle: env.CHETO_AGENT ?? null, source: 'environment' };
    }

    // `CHETO_AS=user` asks for the person's credential rather than an agent's,
    // and it is stored the same way `cheto login` left it: same keychain, same
    // service, a `#user` suffix on the URL. Asking somebody to open the panel,
    // find the token they cannot see twice and paste it into a config file is
    // how a credential ends up in a JSON file, in a backup, and in whatever
    // syncs the home directory — which is the thing the keychain was for.
    if (String(env.CHETO_AS ?? '').toLowerCase() === 'user') {
        return userCredential(env);
    }

    const sessions = await connectedAgents(env.CHETO_URL ?? null);

    if (sessions.length === 0) {
        throw new Error(
            'No credential. Either set CHETO_URL and CHETO_TOKEN (the panel issues one: Agents → the agent → Issue token), ' +
                'or connect this machine once with `cheto connect <pairing-code>` and leave both unset.',
        );
    }

    const wanted = env.CHETO_AGENT;

    if (wanted) {
        const match = sessions.find((entry) => String(entry.handle ?? '').toLowerCase() === String(wanted).toLowerCase());

        if (!match) {
            throw new Error(`No agent called "${wanted}" is connected on this machine. Connected: ${sessions.map((entry) => `@${entry.handle}`).join(', ')}.`);
        }

        return { ...match, source: 'keychain' };
    }

    if (sessions.length > 1) {
        throw new Error(
            `Several agents are connected on this machine and nothing says which one to act as: ${sessions
                .map((entry) => `@${entry.handle} (${entry.workspace ?? '?'})`)
                .join(', ')}. Set CHETO_AGENT=<handle>.`,
        );
    }

    return { ...sessions[0], source: 'keychain' };
}

/**
 * The person's own credential, from where `cheto login` put it.
 *
 * One URL or none: unlike an agent, a person is not scoped to a workspace, so
 * there is nothing here to disambiguate between — only which Cheto. `CHETO_URL`
 * names it; without one, the URL the bridge last connected an agent against
 * answers, because a machine that has one Cheto on it has one Cheto on it.
 *
 * @returns {Promise<{url: string, token: string, handle: string|null, source: string}>}
 */
async function userCredential(env) {
    const url = trimSlashes(env.CHETO_URL ?? (await knownUrl()) ?? '');

    if (!url) {
        throw new Error('CHETO_AS=user needs CHETO_URL as well: nothing on this machine says which Cheto to sign in to.');
    }

    const token = await readSecret(`${url}#user`);

    if (!token) {
        throw new Error(
            `No credential of yours for ${url} on this machine. Run \`cheto login --url ${url}\` once — it authorizes this terminal in your browser and stores the result in the keychain, so nothing has to be pasted anywhere.`,
        );
    }

    return { url, token, handle: null, source: 'keychain' };
}

/** The Cheto this machine already talks to, from the bridge's own notes. */
async function knownUrl() {
    try {
        const file = JSON.parse(await readFile(SESSION_FILE, 'utf8'));

        return Array.isArray(file.agents) && file.agents[0]?.url ? file.agents[0].url : null;
    } catch {
        return null;
    }
}

/**
 * Every agent the bridge connected here, with its token.
 *
 * An entry whose credential has gone — revoked in Cheto, or deleted from the
 * keychain by hand — is dropped rather than reported as connected. The session
 * file is a note about what happened; the credential is what is true.
 */
async function connectedAgents(url) {
    let file;

    try {
        file = JSON.parse(await readFile(SESSION_FILE, 'utf8'));
    } catch {
        return [];
    }

    const entries = Array.isArray(file.agents) ? file.agents : [];
    const found = [];

    for (const entry of entries) {
        if (url && trimSlashes(entry.url) !== trimSlashes(url)) {
            continue;
        }

        const token = await readSecret(`${trimSlashes(entry.url)}#agent:${String(entry.handle ?? 'default').toLowerCase()}`);

        if (token) {
            found.push({ url: trimSlashes(entry.url), token, handle: entry.handle ?? null, workspace: entry.workspace ?? null });
        }
    }

    return found;
}

/**
 * The same three stores the bridge writes to, in the same order, read-only.
 *
 * Kept as a copy rather than an import because the bridge and this server are
 * separate packages that people install separately — and a hard dependency on
 * the bridge would make an MCP server that is meant to work without one.
 */
async function readSecret(account) {
    if (platform() === 'darwin') {
        try {
            const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);

            return stdout.trim() || null;
        } catch {
            // Fall through: this machine may be using the file store.
        }
    }

    if (platform() === 'linux') {
        try {
            const { stdout } = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);

            return stdout.trim() || null;
        } catch {
            // Same.
        }
    }

    try {
        const raw = JSON.parse(await readFile(FALLBACK_FILE, 'utf8'));

        return raw[account] ?? null;
    } catch {
        return null;
    }
}

function trimSlashes(url) {
    return String(url ?? '').replace(/\/+$/, '');
}
