// Request router: one URL parse per request, with the two bench hot paths
// (GET one issue, POST create issue) matched by direct string scans instead
// of the generic segment splitter, so the 2,000-read round pays no split,
// no filter, and no decode scan for a URL it already knows by shape.
//
// The fast paths keep the generic dispatcher's exact conditions:
//   GET  /api/v3/repos/{owner}/{repo}/issues/{n} with no query string and an
//        all-digit number -> the cached issue JSON, else 404.
//   POST /api/v3/repos/{owner}/{repo}/issues (any query string) -> create.
// A '%' anywhere in the owner/name/number falls through to the generic path,
// which is the only place %-escapes are decoded.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, VIEWER_LOGIN_LOWER } from './viewer.ts';
import { Forge } from './store.ts';
import { handleRest, getIssueFast, createIssueFast, notFound, unauthorized } from './rest.ts';
import { handleGitwire } from './gitwire.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { isAuthorized, readBody, sendBuf, sendJson, splitPath, nextRequestId } from './wire.ts';

const REPOS_PREFIX = '/api/v3/repos/';

/** All-ASCII-digit check without a regex (the issue-number test, hot). */
function isAllDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/**
 * Match /api/v3/repos/{owner}/{repo}/issues[/{number}] by scanning the
 * pathname. Returns null when the shape does not fit (generic path then
 * handles it); otherwise { owner, name, number } with number null for the
 * bare /issues POST shape.
 */
function matchIssuePath(pathname: string): { owner: string; name: string; number: string | null } | null {
  if (!pathname.startsWith(REPOS_PREFIX)) return null;
  const ownerStart = REPOS_PREFIX.length;
  const ownerEnd = pathname.indexOf('/', ownerStart);
  if (ownerEnd <= ownerStart) return null;
  const nameStart = ownerEnd + 1;
  const nameEnd = pathname.indexOf('/', nameStart);
  if (nameEnd <= nameStart) return null;
  const issuesStart = nameEnd + 1;
  if (pathname.slice(issuesStart, issuesStart + 7) !== 'issues') return null;
  const after = pathname.slice(issuesStart + 7);
  if (after === '') return { owner: pathname.slice(ownerStart, ownerEnd), name: pathname.slice(nameStart, nameEnd), number: null };
  if (after[0] !== '/') return null;
  const number = after.slice(1);
  if (number.includes('/')) return null;
  return { owner: pathname.slice(ownerStart, ownerEnd), name: pathname.slice(nameStart, nameEnd), number };
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse, forge: Forge): Promise<void> {
  try {
    const raw = req.url ?? '/';
    const mark = raw.indexOf('?');
    const pathname = mark < 0 ? raw : raw.slice(0, mark);
    const search = mark < 0 ? '' : raw.slice(mark + 1);
    const method = req.method ?? 'GET';
    if (pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }
    if (pathname.startsWith('/api/v3')) {
      if (!isAuthorized(req)) { unauthorized(res); return; }
      const issue = matchIssuePath(pathname);
      if (issue !== null && !issue.owner.includes('%') && !issue.name.includes('%') && (issue.number === null || !issue.number.includes('%'))) {
        const ownerLower = issue.owner.toLowerCase();
        const isOwner = ownerLower === VIEWER_LOGIN_LOWER;
        const nameLower = issue.name.toLowerCase();
        if (method === 'GET' && search === '' && issue.number !== null && isAllDigits(issue.number)) {
          const repo = isOwner ? forge.repoByLower(ownerLower, nameLower) : undefined;
          const body = repo ? getIssueFast(repo, Number(issue.number)) : null;
          if (!body) notFound(res);
          else sendBuf(res, 200, body, 'application/json', { 'X-GitHub-Request-Id': nextRequestId() });
          return;
        }
        if (method === 'POST' && issue.number === null) {
          const repo = isOwner ? forge.repoByLower(ownerLower, nameLower) : undefined;
          if (!repo) { notFound(res); return; }
          const result = createIssueFast(forge, repo, await readBody(req));
          if (result) sendBuf(res, result.status, result.body, 'application/json', { 'X-GitHub-Request-Id': nextRequestId() });
          return;
        }
      }
      const segments = splitPath(pathname);
      await handleRest(req, res, forge, pathname, search, segments);
      return;
    }
    if (pathname === '/api/graphql' || pathname.startsWith('/api/graphql/')) { await handleGraphQL(req, res, forge); return; }
    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) { await handleMcp(req, res, forge); return; }
    const segments = splitPath(pathname);
    if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
      if (segments[0]!.toLowerCase() !== VIEWER_LOGIN_LOWER) { notFound(res); return; }
      const repoName = segments[1]!.slice(0, -4);
      const repo = forge.getRepo(segments[0]!, repoName);
      if (!repo) { notFound(res); return; }
      const tail = segments.slice(2);
      if (await handleGitwire(req, res, forge, repo, tail, search)) return;
      notFound(res);
      return;
    }
    if (method === 'GET' && pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>GitHub Core Clone</title><h1>GitHub Core Clone</h1>'); return; }
    if (method === 'GET' && segments.length === 2 && segments[0]!.toLowerCase() === VIEWER_LOGIN_LOWER) {
      const repo = forge.getRepo(segments[0]!, segments[1]!);
      if (repo) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><title>${repo.name}</title><h1>${repo.name}</h1>`); return; }
    }
    sendJson(res, 404, { message: 'Not Found' });
  } catch (error) {
    // A handler must never kill the forge: answer 500 like round 1 did.
    console.error('handler error:', error);
    if (!res.headersSent) sendJson(res, 500, { message: (error as Error).message });
    else res.end();
  }
}
