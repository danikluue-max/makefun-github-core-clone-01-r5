import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, type Repo } from './store.ts';
import { VIEWER } from './viewer.ts';
import { issueView, pullView, repoView, isRecord } from './rest.ts';
import { isAuthorized, readBody, sendJson } from './wire.ts';

type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
};

type ToolSpec = {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, unknown>;
};

const TOOL_SPECS: ToolSpec[] = [
  { name: 'repo_create', description: 'Create a repository.', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } } },
  { name: 'repo_get', description: 'Get a repository by owner and name.', required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } } },
  { name: 'repo_list', description: 'List repositories for an owner.', required: ['owner'], properties: { owner: { type: 'string' } } },
  { name: 'issue_create', description: 'Create an issue.', required: ['owner', 'repo', 'title'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } } },
  { name: 'issue_get', description: 'Get an issue by number.', required: ['owner', 'repo', 'issue_number'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, issue_number: { type: 'integer' } } },
  { name: 'issue_list', description: 'List issues.', required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string' } } },
  { name: 'issue_update', description: 'Update an issue.', required: ['owner', 'repo', 'issue_number'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, issue_number: { type: 'integer' }, title: { type: 'string' }, body: { type: 'string' }, state: { type: 'string' } } },
  { name: 'pr_create', description: 'Create a pull request.', required: ['owner', 'repo', 'title', 'head', 'base'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } } },
  { name: 'pr_get', description: 'Get a pull request.', required: ['owner', 'repo', 'pull_number'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, pull_number: { type: 'integer' } } },
  { name: 'pr_list', description: 'List pull requests.', required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string' } } },
  { name: 'pr_merge', description: 'Merge a pull request.', required: ['owner', 'repo', 'pull_number'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, pull_number: { type: 'integer' }, merge_method: { type: 'string' } } },
  { name: 'comment_add', description: 'Add an issue comment.', required: ['owner', 'repo', 'issue_number', 'body'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, issue_number: { type: 'integer' }, body: { type: 'string' } } },
  { name: 'search_repos', description: 'Search repositories.', required: ['query'], properties: { query: { type: 'string' } } },
  { name: 'search_issues', description: 'Search issues.', required: ['query'], properties: { query: { type: 'string' } } },
  { name: 'git_ls_refs', description: 'List git refs.', required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } } },
  { name: 'git_clone', description: 'Get clone URL and refs.', required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } } },
];

const TOOLS: ToolDef[] = TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  inputSchema: { type: 'object', properties: spec.properties, required: spec.required },
}));

const TOOLS_JSON = JSON.stringify({ jsonrpc: '2.0', id: null, result: { tools: TOOLS } });
const SUPPORTED = ['2025-06-18', '2025-03-26'];

function okResult(id: unknown, value: unknown): unknown {
  return { jsonrpc: '2.0', id, result: value };
}

function errResult(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function textResult(value: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): unknown {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function normalizeArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  if (typeof out.full_name === 'string') {
    const [owner, repo] = out.full_name.split('/', 2);
    out.owner ??= owner;
    out.repo ??= repo;
  }
  return out;
}

function resolveToolName(raw: string): string {
  const squashed = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = TOOL_SPECS.map((spec) => spec.name);
  return names.find((name) => squashed.endsWith(name.replace(/_/g, '')) || squashed.endsWith(name.replace('_', ''))) ?? '';
}

function missingArg(name: string, args: Record<string, unknown>): string | undefined {
  const spec = TOOL_SPECS.find((item) => item.name === name);
  return spec?.required.find((key) => args[key] === undefined || args[key] === null || args[key] === '');
}

function repoLocation(args: Record<string, unknown>): { owner: string; repoName: string } {
  return { owner: String(args.owner ?? VIEWER.login), repoName: String(args.repo ?? '') };
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repo | undefined {
  const { owner, repoName } = repoLocation(args);
  if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return undefined;
  return forge.getRepo(owner, repoName);
}

function callTool(forge: Forge, rawName: string, input: Record<string, unknown>): unknown {
  const name = resolveToolName(rawName);
  if (!name) return { errorRpc: true };
  const args = normalizeArgs(input);
  const miss = missingArg(name, args);
  if (miss) return toolError(`Missing required argument: ${miss}`);
  const { owner, repoName } = repoLocation(args);

  switch (name) {
    case 'repo_create': {
      const created = forge.createRepo(VIEWER.login, String(args.name), {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return 'error' in created ? toolError(created.error) : textResult(repoView(created));
    }
    case 'repo_list': {
      return textResult(forge.listRepos(owner).map(repoView));
    }
    case 'repo_get': {
      const found = findRepo(forge, args);
      return found ? textResult(repoView(found)) : toolError('Not Found');
    }
    case 'search_repos': {
      const query = String(args.query ?? '').toLowerCase();
      const rows = forge.listRepos(VIEWER.login)
        .filter((r) => `${r.owner}/${r.name} ${r.description}`.toLowerCase().includes(query));
      return textResult(rows.map(repoView));
    }
    case 'search_issues': {
      const query = String(args.query ?? '').toLowerCase();
      const rows: unknown[] = [];
      for (const r of forge.listRepos(VIEWER.login)) {
        for (const issue of r.issues.values()) {
          if (`${issue.title} ${issue.body}`.toLowerCase().includes(query)) rows.push(issueView(r, issue));
        }
      }
      return textResult(rows);
    }
    case 'git_ls_refs':
    case 'git_clone': {
      const found = findRepo(forge, args);
      if (!found) return toolError('Not Found');
      if (name === 'git_ls_refs') {
        return textResult(forge.allRefs(found).map(([ref, sha]) => ({ ref, object: { sha } })));
      }
      return textResult({
        clone_url: `https://example.invalid/${found.owner}/${found.name}.git`,
        refs: forge.allRefs(found).map(([ref, sha]) => ({ ref, sha })),
      });
    }
  }

  const found = findRepo(forge, args);
  if (!found) return toolError('Not Found');
  const number = Number(args.issue_number ?? args.pull_number);

  switch (name) {
    case 'issue_create': {
      const created = forge.createIssue(found, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return 'error' in created ? toolError(created.error) : textResult(issueView(found, created));
    }
    case 'issue_get': {
      const issue = found.issues.get(number);
      return issue ? textResult(issueView(found, issue)) : toolError('Not Found');
    }
    case 'issue_list': {
      const state = String(args.state ?? 'open');
      let rows = [...found.issues.values()];
      if (state !== 'all') rows = rows.filter((issue) => issue.state === state);
      rows.sort((a, b) => a.createdSeq - b.createdSeq);
      return textResult({ issues: rows.map((issue) => issueView(found, issue)) });
    }
    case 'issue_update': {
      const issue = found.issues.get(number);
      if (!issue) return toolError('Not Found');
      if (typeof args.title === 'string') issue.title = args.title;
      if (typeof args.body === 'string') issue.body = args.body;
      if (args.state === 'open' || args.state === 'closed') issue.state = args.state;
      issue.updatedAt = forge.timestamp();
      found.issueJson.delete(number);
      return textResult(issueView(found, issue));
    }
    case 'comment_add': {
      const added = forge.addComment(found, number, String(args.body));
      return 'error' in added ? toolError(added.error) : textResult({ id: added.id, body: added.body, created_at: added.createdAt });
    }
    case 'pr_create': {
      const created = forge.createPull(found, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
      return 'error' in created ? toolError(created.error) : textResult(pullView(found, created));
    }
    case 'pr_get': {
      const pull = found.pulls.get(number);
      return pull ? textResult(pullView(found, pull)) : toolError('Not Found');
    }
    case 'pr_list': {
      const state = String(args.state ?? 'open');
      let rows = [...found.pulls.values()];
      if (state !== 'all') rows = rows.filter((pull) => pull.state === state);
      return textResult(rows.map((pull) => pullView(found, pull)));
    }
    case 'pr_merge': {
      const pull = found.pulls.get(number);
      if (!pull) return toolError('Not Found');
      if (pull.state !== 'open') return toolError('Pull request is not open');
      if (!forge.pullMergesCleanly(found, pull)) return toolError('Merge conflict');
      const done = forge.mergePull(found, pull, String(args.merge_method ?? 'squash'));
      return 'error' in done ? toolError(done.error) : textResult(pullView(found, pull));
    }
  }
  return toolError('Method not found');
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, forge: Forge): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method not allowed' });
    return;
  }
  if (!req.headers.authorization) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  if (!isAuthorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  if (body.id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  const id = body.id;
  const params = isRecord(body.params) ? body.params : {};
  switch (body.method) {
    case 'server/discover': {
      sendJson(res, 200, okResult(id, {
        supportedVersions: SUPPORTED,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '1.0.0' } },
      }));
      return;
    }
    case 'initialize': {
      const requested = String(params.protocolVersion ?? '');
      const version = ['2025-11-25', ...SUPPORTED].includes(requested) ? requested : '2025-06-18';
      sendJson(res, 200, okResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      }));
      return;
    }
    case 'ping': {
      sendJson(res, 200, okResult(id, {}));
      return;
    }
    case 'tools/list': {
      const payload = JSON.parse(TOOLS_JSON) as Record<string, unknown>;
      payload.id = id;
      sendJson(res, 200, payload);
      return;
    }
    case 'tools/call': {
      const callParams = isRecord(params) ? params : {};
      const toolName = typeof callParams.name === 'string' ? callParams.name : '';
      const toolArgs = isRecord(callParams.arguments) ? callParams.arguments : {};
      const value = callTool(forge, toolName, toolArgs);
      if (isRecord(value) && value.errorRpc) {
        sendJson(res, 200, errResult(id, -32602, `Unknown tool: ${toolName}`));
        return;
      }
      sendJson(res, 200, okResult(id, value));
      return;
    }
    default: {
      sendJson(res, 200, errResult(id, -32601, `Method not found: ${body.method}`));
      return;
    }
  }
}
