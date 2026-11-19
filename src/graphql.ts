import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './viewer.ts';
import { Forge, type Repo, type Issue, type PullRequest, type Comment, decodeGlobalId, repoGlobalId, issueGlobalId, pullGlobalId, commentGlobalId } from './store.ts';
import { isAuthorized, readBody, sendJson } from './wire.ts';
import { isRecord } from './rest.ts';

// --- Parsed query tree -------------------------------------------------

type GqlValue = {
  kind: string;
  literal?: unknown;
  items?: GqlValue[];
  fields?: Record<string, GqlValue>;
};

type Selection = {
  name: string;
  alias?: string;
  args: Record<string, GqlValue>;
  selections: Selection[];
  fragment?: string;
  directives: Record<string, GqlValue>;
};

type Operation = {
  kind: string;
  name?: string;
  vars: Record<string, { type: string; def?: GqlValue }>;
  selections: Selection[];
};

type GqlToken = { kind: string; text: string };

// --- Lexer ---------------------------------------------------------------

const PUNCTUATION = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '=', '$', '@']);
const BLANK = new Set([' ', '\n', '\r', '\t', ',']);

function isDigitStart(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || ch === '-';
}

function isNameStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isNameChar(ch: string): boolean {
  return isNameStart(ch) || (ch >= '0' && ch <= '9');
}

function tokenize(source: string): GqlToken[] {
  const out: GqlToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (BLANK.has(ch)) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      out.push({ kind: 'spread', text: '...' });
      i += 3;
      continue;
    }
    if (PUNCTUATION.has(ch)) {
      out.push({ kind: 'punct', text: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') j += 2;
        else if (source[j] === '"') break;
        else j += 1;
      }
      if (j >= source.length) throw Error('unterminated string');
      out.push({ kind: 'str', text: JSON.parse(source.slice(i, j + 1)) as string });
      i = j + 1;
      continue;
    }
    if (isDigitStart(ch)) {
      let j = i + 1;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      out.push({ kind: 'num', text: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      out.push({ kind: 'name', text: source.slice(i, j) });
      i = j;
      continue;
    }
    throw Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  out.push({ kind: 'eof', text: '' });
  return out;
}

// --- Parser --------------------------------------------------------------

class QueryParser {
  private pos = 0;
  private readonly tokens: GqlToken[];

  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
  }

  private peek(): GqlToken {
    return this.tokens[this.pos] as GqlToken;
  }

  private take(): GqlToken {
    return this.tokens[this.pos++] as GqlToken;
  }

  private expectPunct(mark: string): void {
    const got = this.take();
    if (got.text !== mark) {
      throw Error(`expected "${mark}" but got ${got.kind} ${JSON.stringify(got.text)}`);
    }
  }

  private expectName(): string {
    const got = this.take();
    if (got.kind !== 'name') {
      throw Error(`expected name but got ${got.kind} ${JSON.stringify(got.text)}`);
    }
    return got.text;
  }

  parseValue(): GqlValue {
    const tok = this.take();
    if (tok.text === '$') return { kind: 'var', literal: this.expectName() };
    if (tok.kind === 'str') return { kind: 'lit', literal: tok.text };
    if (tok.kind === 'num') return { kind: 'lit', literal: Number(tok.text) };
    if (tok.kind === 'name') {
      const literal = tok.text === 'true' ? true : tok.text === 'false' ? false : tok.text === 'null' ? null : tok.text;
      return { kind: 'lit', literal };
    }
    if (tok.text === '[') {
      const items: GqlValue[] = [];
      while (this.peek().text !== ']') items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (tok.text === '{') {
      const fields: Record<string, GqlValue> = {};
      while (this.peek().text !== '}') {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'obj', fields };
    }
    throw Error(`unexpected value token ${tok.kind} ${JSON.stringify(tok.text)}`);
  }

  parseArgs(): Record<string, GqlValue> {
    const found: Record<string, GqlValue> = {};
    if (this.peek().text === '(') {
      this.take();
      while (this.peek().text !== ')') {
        const key = this.expectName();
        this.expectPunct(':');
        found[key] = this.parseValue();
      }
      this.expectPunct(')');
    }
    return found;
  }

  private parseDirectiveArg(): GqlValue {
    this.expectPunct('(');
    this.expectName();
    this.expectPunct(':');
    const value = this.parseValue();
    this.expectPunct(')');
    return value;
  }

  parseDirectives(): Record<string, GqlValue> {
    const found: Record<string, GqlValue> = {};
    while (this.peek().text === '@') {
      this.take();
      found[this.expectName()] = this.parseDirectiveArg();
    }
    return found;
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const picked: Selection[] = [];
    while (this.peek().text !== '}' && this.peek().kind !== 'eof') {
      if (this.peek().kind === 'spread') {
        this.take();
        if (this.peek().text === 'on') {
          this.take();
          const typeName = this.expectName();
          picked.push({ name: '', args: {}, selections: this.parseSelectionSet(), fragment: typeName, directives: {} });
        } else {
          picked.push({ name: this.expectName(), args: {}, selections: [], fragment: 'fragment', directives: {} });
        }
        continue;
      }
      let fieldName = this.expectName();
      let alias: string | undefined;
      if (this.peek().text === ':') {
        this.take();
        alias = fieldName;
        fieldName = this.expectName();
      }
      const args = this.parseArgs();
      const directives = this.parseDirectives();
      const selections = this.peek().text === '{' ? this.parseSelectionSet() : [];
      picked.push({ name: fieldName, alias, args, directives, selections });
    }
    this.expectPunct('}');
    return picked;
  }

  parseDocument(): { ops: Operation[]; frags: Record<string, { type: string; selections: Selection[] }> } {
    const ops: Operation[] = [];
    const frags: Record<string, { type: string; selections: Selection[] }> = {};
    while (this.peek().kind !== 'eof') {
      if (this.peek().text === '{') {
        ops.push({ kind: 'query', vars: {}, selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const fragName = this.expectName();
        this.expectPunct('on');
        const typeName = this.expectName();
        frags[fragName] = { type: typeName, selections: this.parseSelectionSet() };
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
        throw Error(`unexpected keyword ${keyword}`);
      }
      let opName: string | undefined;
      if (this.peek().kind === 'name') opName = this.take().text;
      const vars: Operation['vars'] = {};
      if (this.peek().text === '(') {
        this.take();
        while (this.peek().text !== ')') {
          this.expectPunct('$');
          const varName = this.expectName();
          this.expectPunct(':');
          let varType = '';
          if (this.peek().text === '[') {
            this.take();
            varType = this.expectName();
            this.expectPunct(']');
          } else {
            varType = this.expectName();
          }
          if (this.peek().text === '!') {
            this.take();
            varType += '!';
          }
          let def: GqlValue | undefined;
          if (this.peek().text === '=') {
            this.take();
            def = this.parseValue();
          }
          vars[varName] = { type: varType, def };
        }
        this.expectPunct(')');
      }
      ops.push({ kind: keyword, name: opName, vars, selections: this.parseSelectionSet() });
    }
    return { ops, frags };
  }
}

// --- Value resolution and ids --------------------------------------------

function resolveValue(node: GqlValue, vars: Record<string, unknown>): unknown {
  if (node.kind === 'var') return vars[String(node.literal)];
  if (node.kind === 'list') return node.items!.map((item) => resolveValue(item, vars));
  if (node.kind === 'obj') {
    return Object.fromEntries(Object.entries(node.fields!).map(([key, item]) => [key, resolveValue(item, vars)]));
  }
  return node.literal;
}

const encodeId = (plain: string): string => Buffer.from(plain).toString('base64url');

function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`).toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString();
    if (!text.startsWith('cursor:')) return null;
    const num = Number(text.slice(7));
    return Number.isInteger(num) ? num : null;
  } catch {
    return null;
  }
}

type Wrapped = { type: string; [key: string]: any };

function wrapUser(login: string = VIEWER.login): Wrapped {
  return { type: 'User', login, id: login === VIEWER.login ? VIEWER.id : 1001 };
}

function wrapIssue(repo: Repo, issue: Issue): Wrapped {
  return { type: 'Issue', repo, issue };
}

function wrapPull(repo: Repo, pull: PullRequest): Wrapped {
  return { type: 'PullRequest', repo, pull };
}

const TYPE_DEFS: Record<string, { kind: string; fields: string[]; enums?: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'merged', 'mergeable', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'files'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'url', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'forks', 'stargazers', 'watchers'] },
  SearchType: { kind: 'ENUM', fields: [], enums: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
};

// --- Root fields -----------------------------------------------------------

function rootValue(type: string, field: Selection, args: Record<string, unknown>, forge: Forge): unknown {
  const input = isRecord(args.input) ? args.input : {};
  const key = `${type}.${field.name}`;
  if (key === 'Query.viewer') {
    return { type: 'Viewer', login: VIEWER.login };
  }
  if (key === 'Query.repository') {
    const found = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    return found ? { type: 'Repository', repo: found } : null;
  }
  if (key === 'Query.node') {
    const decoded = decodeGlobalId(String(args.id ?? ''));
    if (!decoded) return null;
    const found = forge.repoById(decoded.repoId);
    if (!found) return null;
    if (decoded.kind === 'repo') return { type: 'Repository', repo: found };
    if (decoded.kind === 'issue') {
      const issue = found.issues.get(decoded.number!);
      return issue ? wrapIssue(found, issue) : null;
    }
    if (decoded.kind === 'pr') {
      const pull = found.pulls.get(decoded.number!);
      return pull ? wrapPull(found, pull) : null;
    }
    return null;
  }
  if (key === 'Query.search') return { type: 'Search', items: [] };
  if (key === 'Query.__type') {
    return TYPE_DEFS[String(args.name)] ? { type: '__Type', name: String(args.name) } : null;
  }
  if (key === 'Mutation.createIssue' || key === 'Mutation.createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const found = decoded ? forge.repoById(decoded.repoId) : undefined;
    if (!found) return null;
    if (field.name === 'createIssue') {
      const created = forge.createIssue(found, String(input.title ?? ''), String(input.body ?? ''), []);
      return 'error' in created ? null : { type: 'CreateIssuePayload', issue: wrapIssue(found, created) };
    }
    const created = forge.createPull(found, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? 'main'));
    return 'error' in created ? null : { type: 'CreatePullRequestPayload', pullRequest: wrapPull(found, created) };
  }
  if (key === 'Mutation.closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    const found = decoded ? forge.repoById(decoded.repoId) : undefined;
    if (!found || decoded?.kind !== 'issue') return null;
    const issue = found.issues.get(decoded.number!);
    if (!issue) return null;
    issue.state = 'closed';
    issue.updatedAt = forge.timestamp();
    found.issueJson.delete(issue.number);
    return { type: 'CloseIssuePayload', issue: wrapIssue(found, issue) };
  }
  if (key === 'Mutation.mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    const found = decoded ? forge.repoById(decoded.repoId) : undefined;
    if (!found || decoded?.kind !== 'pr') return null;
    const pull = found.pulls.get(decoded.number!);
    if (!pull) return null;
    const done = forge.mergePull(found, pull, String(input.mergeMethod ?? 'squash').toLowerCase());
    if ('error' in done) return null;
    return { type: 'MergePullRequestPayload', pullRequest: wrapPull(found, pull) };
  }
  if (key === 'Mutation.addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    const found = decoded ? forge.repoById(decoded.repoId) : undefined;
    if (!found || decoded?.kind !== 'issue') return null;
    const added = forge.addComment(found, decoded.number!, String(input.body ?? ''));
    if ('error' in added) return null;
    return { type: 'AddCommentPayload', commentEdge: { type: 'CommentEdge', node: { type: 'IssueComment', repo: found, comment: added } } };
  }
  return undefined;
}

// --- Non-root fields ---------------------------------------------------------

function fieldValue(parent: Wrapped, field: Selection, args: Record<string, unknown>, forge: Forge): unknown {
  const repo = parent.repo as Repo | undefined;
  const issue = parent.issue as Issue | undefined;
  const pull = parent.pull as PullRequest | undefined;

  if (parent.type === 'Query' || parent.type === 'Mutation') {
    return rootValue(parent.type, field, args, forge);
  }

  if (parent.type === 'Viewer' || parent.type === 'User') {
    if (field.name === 'url') return `https://example.invalid/${parent.login}`;
    const own = parent[field.name];
    if (own !== undefined) return own;
    return field.name === 'avatarUrl' ? '' : undefined;
  }

  if (parent.type === 'Repository') {
    if (!repo) return null;
    switch (field.name) {
      case 'id': return repoGlobalId(repo);
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return wrapUser(repo.owner);
      case 'description': return repo.description;
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'defaultBranchRef': {
        return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { type: 'Ref', name: repo.defaultBranch } : null;
      }
      case 'databaseId': return repo.id;
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const found = repo.issues.get(Number(args.number));
        return found ? wrapIssue(repo, found) : null;
      }
      case 'pullRequest': {
        const found = repo.pulls.get(Number(args.number));
        return found ? wrapPull(repo, found) : null;
      }
      case 'issues': {
        let rows = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? args.states.map((item) => String(item).toLowerCase()) : [];
        if (states.length) rows = rows.filter((row) => states.includes(row.state));
        const desc = isRecord(args.orderBy) && String(args.orderBy.direction ?? 'ASC').toUpperCase() === 'DESC';
        rows.sort((a, b) => desc ? (b.createdSeq - a.createdSeq || b.number - a.number) : (a.createdSeq - b.createdSeq || a.number - b.number));
        const total = rows.length;
        if (typeof args.after === 'string' && args.after !== '') {
          const seq = decodeCursor(args.after);
          if (seq !== null) rows = rows.filter((row) => desc ? row.createdSeq < seq : row.createdSeq > seq);
        }
        const first = typeof args.first === 'number' ? Math.max(0, args.first) : rows.length;
        const page = rows.slice(0, first);
        return {
          type: 'Connection',
          nodes: page.map((row) => wrapIssue(repo, row)),
          totalCount: total,
          pageInfo: { type: 'PageInfo', hasNextPage: rows.length > page.length, endCursor: page.length ? encodeCursor(page[page.length - 1]!.createdSeq) : '' },
        };
      }
      case 'pullRequests': {
        let rows = [...repo.pulls.values()];
        const states = Array.isArray(args.states) ? args.states.map((item) => String(item).toLowerCase()) : [];
        if (states.length) rows = rows.filter((row) => states.includes(row.merged ? 'merged' : row.state));
        const first = typeof args.first === 'number' ? args.first : rows.length;
        const page = rows.slice(0, first);
        return {
          type: 'Connection',
          nodes: page.map((row) => wrapPull(repo, row)),
          totalCount: rows.length,
          pageInfo: { type: 'PageInfo', hasNextPage: rows.length > page.length, endCursor: page.length ? encodeCursor(page[page.length - 1]!.createdSeq) : '' },
        };
      }
      case 'labels': return [...repo.labels.values()];
      case 'forks':
      case 'stargazers':
      case 'watchers': return { type: 'Connection', nodes: [], totalCount: 0 };
    }
    return undefined;
  }

  if (parent.type === 'Issue') {
    if (!repo || !issue) return null;
    switch (field.name) {
      case 'id': return issueGlobalId(repo, issue);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state.toUpperCase();
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'author': return wrapUser(issue.userLogin);
      case 'labels': return issue.labels;
      case 'comments': {
        const all = repo.comments.get(issue.number) ?? [];
        const first = typeof args.first === 'number' ? args.first : Infinity;
        return {
          type: 'Connection',
          nodes: all.slice(0, first).map((c) => ({ type: 'IssueComment', repo, comment: c })),
          totalCount: all.length,
        };
      }
      case 'repository': return { type: 'Repository', repo };
    }
    return undefined;
  }

  if (parent.type === 'PullRequest') {
    if (!repo || !pull) return null;
    switch (field.name) {
      case 'id': return pullGlobalId(repo, pull);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'merged': return pull.merged;
      case 'mergeable': return pull.state !== 'open' ? 'UNKNOWN' : forge.pullMergesCleanly(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'createdAt': return pull.createdAt;
      case 'updatedAt': return pull.updatedAt;
      case 'author': return wrapUser(pull.userLogin);
      case 'labels': return [];
      case 'comments': return { type: 'Connection', nodes: [], totalCount: 0 };
      case 'files': {
        const files = forge.pullFiles(repo, pull);
        return { type: 'Connection', nodes: files.map((f) => ({ type: 'File', path: f.filename })), totalCount: files.length };
      }
    }
    return undefined;
  }

  if (parent.type === 'Connection') {
    if (field.name === 'nodes') return parent.nodes;
    if (field.name === 'totalCount') return parent.totalCount;
    if (field.name === 'pageInfo') return parent.pageInfo;
    return undefined;
  }

  if (parent.type === 'PageInfo') {
    if (field.name === 'hasNextPage') return parent.hasNextPage;
    if (field.name === 'endCursor') return parent.endCursor;
    return undefined;
  }

  if (parent.type === 'IssueComment') {
    const comment = parent.comment as Comment;
    if (field.name === 'id') return commentGlobalId(parent.repo as Repo, comment);
    if (field.name === 'body') return comment.body;
    if (field.name === 'author') return wrapUser(comment.userLogin);
    return undefined;
  }

  if (parent.type === 'CommentEdge') {
    return field.name === 'node' ? parent.node : undefined;
  }
  if (parent.type === 'CreateIssuePayload') {
    return field.name === 'issue' ? parent.issue : undefined;
  }
  if (parent.type === 'CreatePullRequestPayload') {
    return field.name === 'pullRequest' ? parent.pullRequest : undefined;
  }
  if (parent.type === 'CloseIssuePayload') {
    return field.name === 'issue' ? parent.issue : undefined;
  }
  if (parent.type === 'MergePullRequestPayload') {
    return field.name === 'pullRequest' ? parent.pullRequest : undefined;
  }
  if (parent.type === 'AddCommentPayload') {
    return field.name === 'commentEdge' ? parent.commentEdge : undefined;
  }

  if (parent.type === '__Type') {
    const def = TYPE_DEFS[parent.name];
    if (!def) return null;
    if (field.name === 'name') return parent.name;
    if (field.name === 'kind') return def.kind;
    if (field.name === 'fields') return def.fields.map((name) => ({ type: '__Field', name }));
    if (field.name === 'enumValues') return (def.enums ?? []).map((name) => ({ type: '__EnumValue', name }));
    return undefined;
  }

  if (parent.type === '__Field') {
    if (field.name === 'name') return parent.name;
    if (field.name === 'type') {
      return { type: '__TypeRef', name: parent.name === 'state' ? 'IssueState' : 'String', kind: 'SCALAR' };
    }
    return null;
  }

  if (parent.type === '__EnumValue') {
    return field.name === 'name' ? parent.name : undefined;
  }
  if (parent.type === '__TypeRef') {
    return parent[field.name];
  }
  if (parent.type === 'Ref') {
    return field.name === 'name' ? parent.name : undefined;
  }
  if (parent.type === 'File') {
    return field.name === 'path' ? parent.path : undefined;
  }
  if (parent.type === 'Search') {
    if (field.name === 'nodes') return [];
    if (field.name === 'issueCount') return 0;
    return undefined;
  }

  return undefined;
}

// --- Execution -------------------------------------------------------------

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'Array';
  if (isRecord(value) && typeof value.type === 'string') return value.type;
  if (isRecord(value) && 'name' in value && 'kind' in value) return '__TypeRef';
  if (isRecord(value) && 'name' in value) return '__EnumValue';
  if (isRecord(value) && 'nodes' in value) return 'Connection';
  if (isRecord(value) && 'name' in value) return 'Label';
  if (typeof value === 'string') return 'String';
  if (typeof value === 'number') return 'Int';
  return 'Unknown';
}

type GqlError = { message: string; path: (string | number)[] };

function execute(
  parent: Wrapped,
  selections: Selection[],
  vars: Record<string, unknown>,
  forge: Forge,
  frags: Record<string, { type: string; selections: Selection[] }>,
  errors: GqlError[],
  path: (string | number)[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.fragment) {
      if (sel.fragment === 'fragment') {
        const frag = frags[sel.name];
        if (frag) Object.assign(out, execute(parent, frag.selections, vars, forge, frags, errors, path));
        continue;
      }
      if (sel.fragment !== parent.type && sel.fragment !== 'Node') continue;
      Object.assign(out, execute(parent, sel.selections, vars, forge, frags, errors, path));
      continue;
    }
    const skipped = sel.directives.skip ? resolveValue(sel.directives.skip, vars) === true : false;
    const excluded = sel.directives.include ? resolveValue(sel.directives.include, vars) !== true : false;
    if (skipped || excluded) continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = parent.type;
      continue;
    }
    const args = Object.fromEntries(Object.entries(sel.args).map(([name, node]) => [name, resolveValue(node, vars)]));
    const got = fieldValue(parent, sel, args, forge);
    if (got === undefined) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${parent.type}"`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    if (got === null) {
      out[key] = null;
      continue;
    }
    if (sel.selections.length) {
      const descend = (value: unknown, index: number): unknown => {
        if (value === null || value === undefined) return null;
        if (Array.isArray(value)) return value.map((item, n) => descend(item, n));
        if (!isRecord(value)) {
          errors.push({
            message: `Field "${sel.name}" must have a selection of subfields`,
            path: [...path, key, index].filter((part) => typeof part !== 'number' || Array.isArray(got)),
          });
          return null;
        }
        const childPath = [...path, key, ...(Array.isArray(got) ? [index] : [])];
        return execute(value as Wrapped, sel.selections, vars, forge, frags, errors, childPath);
      };
      out[key] = descend(got, 0);
    } else {
      out[key] = got;
    }
  }
  return out;
}

function runSingle(body: unknown, forge: Forge): unknown {
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { data: {}, errors: [{ message: 'A query string is required' }] };
  }
  let doc: { ops: Operation[]; frags: Record<string, { type: string; selections: Selection[] }> };
  try {
    doc = new QueryParser(tokenize(body.query)).parseDocument();
  } catch (e) {
    return { data: {}, errors: [{ message: (e as Error).message }] };
  }
  if (!doc.ops.length) return { data: {}, errors: [{ message: 'Empty query' }] };
  let op: Operation | undefined;
  if (typeof body.operationName === 'string') {
    op = doc.ops.find((item) => item.name === body.operationName);
  } else if (doc.ops.length === 1) {
    op = doc.ops[0];
  }
  if (!op) {
    return { data: {}, errors: [{ message: doc.ops.length > 1 ? 'Operation name is required' : 'Unknown operation' }] };
  }
  const vars: Record<string, unknown> = isRecord(body.variables) ? { ...body.variables } : {};
  for (const [name, declared] of Object.entries(op.vars)) {
    if (vars[name] === undefined && declared.def) vars[name] = resolveValue(declared.def, vars);
  }
  const errors: GqlError[] = [];
  const data = execute({ type: op.kind === 'mutation' ? 'Mutation' : 'Query' }, op.selections, vars, forge, doc.frags, errors);
  return errors.length ? { data, errors } : { data };
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, forge: Forge): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method not allowed' });
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
    sendJson(res, 400, { message: 'Invalid JSON' });
    return;
  }
  sendJson(res, 200, Array.isArray(body) ? body.map((item) => runSingle(item, forge)) : runSingle(body, forge));
}
