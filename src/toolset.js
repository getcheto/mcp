/**
 * Which tools exist, from the credential.
 *
 * An agent credential (`cheto_ak_…`) is one agent in one workspace. It gets the
 * work tools and nothing else, and none of them asks who it is: the token
 * already says.
 *
 * A person's credential (`cheto_ut_…`) gets two sets. Its own — the boards, the
 * columns, the agents, work filed under the person's name — on `/api/v1/cli`.
 * And the work tools, each of which **requires** `agent`: the person's own agent
 * to act as, by its Cheto address or its handle. That is how one MCP server with
 * one token serves a team of agents, each working under its own name: every
 * agent's system prompt says which one it is, and it passes that on every call.
 *
 * Two rules keep the two sets from being mistaken for one another, because
 * acting as the person when an agent was meant would put the person's name on
 * an agent's work, and there is no taking that back from here:
 *
 * - A work tool called without `agent` is refused before anything is sent. It
 *   never falls back to the person.
 * - Four tools exist in both sets with the same name — whoami, tasks,
 *   task_create, task_update. The person keeps the plain name; the agent's
 *   variant is `cheto_agent_…`. And a person's tool handed an `agent` argument
 *   is refused, naming the variant, rather than quietly running as the person
 *   with the argument ignored.
 */
import { HUMAN_TOOLS } from './human-tools.js';
import { TOOLS } from './tools.js';

const AGENT_ARGUMENT = {
    type: 'string',
    description: 'The agent you act as: its Cheto address like rocky.a7f3@cheto or its @handle. cheto_agents lists them.',
};

const WORKSPACE_ARGUMENT = {
    type: 'string',
    description:
        'Workspace uuid or slug, only needed when the agent works in more than one (Cheto then answers ambiguous_agent). Defaults to CHETO_WORKSPACE when the server was started with one.',
};

export function toolsFor(kind) {
    if (kind !== 'user') {
        return TOOLS;
    }

    const human = new Set(HUMAN_TOOLS.map((tool) => tool.name));
    const renamed = new Map(TOOLS.filter((tool) => human.has(tool.name)).map((tool) => [tool.name, agentName(tool.name)]));

    return [...HUMAN_TOOLS.map((tool) => asPerson(tool, renamed)), ...TOOLS.map((tool) => asAgent(tool, renamed))];
}

/** `cheto_whoami` → `cheto_agent_whoami`. */
function agentName(name) {
    return name.replace(/^cheto_/, 'cheto_agent_');
}

/**
 * A work tool, run as one of the person's agents.
 *
 * The tool itself is untouched: it receives a client whose `call` goes to the
 * agent surface with the agent named in a header, so every rule it already
 * enforces — no closing, no board it cannot see — holds exactly as it does
 * under the agent's own token.
 */
function asAgent(tool, renamed) {
    const name = renamed.get(tool.name) ?? tool.name;
    const schema = tool.inputSchema ?? { type: 'object', properties: {} };
    const twin = renamed.has(tool.name) ? ` ${tool.name} without "agent_" acts as you, the person, instead.` : '';

    return {
        name,
        description: `As one of your agents: pass \`agent\` (required). ${mentionRenamed(tool.description, renamed)}${twin}`,
        inputSchema: {
            ...schema,
            properties: { agent: AGENT_ARGUMENT, workspace: WORKSPACE_ARGUMENT, ...(schema.properties ?? {}) },
            required: ['agent', ...(schema.required ?? [])],
        },
        run: (cheto, { agent, workspace, ...rest } = {}) => {
            if (isBlank(agent)) {
                throw new Error(
                    `${name} acts as one of your agents, and nothing said which. Pass \`agent\`: its Cheto address (rocky.a7f3@cheto) or its @handle — the one your instructions give you. cheto_agents lists them. Nothing was sent.`,
                );
            }

            return tool.run(cheto.actingAs(String(agent).trim(), isBlank(workspace) ? null : String(workspace).trim()), rest);
        },
    };
}

/**
 * A person's tool, refusing to be mistaken for an agent's.
 *
 * `agent` is only meaningful to the tools that administer one, where it is the
 * agent's id. Anywhere else, an `agent` argument means somebody wanted to act
 * as that agent and reached for the wrong tool.
 */
function asPerson(tool, renamed) {
    const takesAgent = Object.hasOwn(tool.inputSchema?.properties ?? {}, 'agent');
    const twin = renamed.get(tool.name) ?? null;

    if (takesAgent) {
        return tool;
    }

    return {
        ...tool,
        description: twin ? `${tool.description} Acts as you, the person. To act as one of your agents, use ${twin} with \`agent\`.` : tool.description,
        run: (cheto, args = {}) => {
            if (!isBlank(args.agent)) {
                throw new Error(
                    twin
                        ? `${tool.name} acts as you, the person, and takes no \`agent\`. To do this as ${args.agent}, call ${twin} with the same arguments. Nothing was sent.`
                        : `${tool.name} is one of your own tools as a person and takes no \`agent\`: call it without one. No agent has this tool. Nothing was sent.`,
                );
            }

            return tool.run(cheto, args);
        },
    };
}

/** Point an agent tool's own cross-references at the names it has in this set. */
function mentionRenamed(text, renamed) {
    return String(text ?? '').replace(/\bcheto_[a-z_]+\b/g, (name) => renamed.get(name) ?? name);
}

function isBlank(value) {
    return value === undefined || value === null || String(value).trim() === '';
}
