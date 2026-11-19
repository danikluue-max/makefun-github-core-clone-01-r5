// HTTP plumbing for the forge: auth, request ids, JSON/buffer replies, bodies.
// The entry's server (src/rawhttp.ts) buffers every request body before the
// handler runs, so readBody() resolves from that buffer with no listeners
// and no tick hop; the event-listener path below is only a fallback for a
// request that did not come through the raw server.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN;
const AUTH = SHOP_TOKEN === undefined || SHOP_TOKEN === '' ? undefined : `Bearer ${SHOP_TOKEN}`;
let requestNumber = 0;

export function isAuthorized(req: IncomingMessage): boolean {
  return AUTH === undefined || req.headers.authorization === AUTH;
}

export function nextRequestId(): string { return `req-${++requestNumber}`; }

export function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'X-GitHub-Request-Id': nextRequestId(), ...extra });
  res.end(body);
}

export function sendBuf(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(body.length), ...extra });
  res.end(body);
}

/** The buffered body of a raw-server request, when the request carries one. */
function bufferedBody(req: IncomingMessage): Buffer | undefined {
  const raw = req as unknown as { bodyBuffer?: unknown };
  return Buffer.isBuffer(raw.bodyBuffer) ? raw.bodyBuffer : undefined;
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  const buffered = bufferedBody(req);
  if (buffered !== undefined) return Promise.resolve(buffered);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | Uint8Array) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(part);
      total += part.length;
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] as Buffer : Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

export function splitPath(pathname: string): string[] {
  const raw = pathname.split('/').filter((segment) => segment !== '');
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i]?.includes('%')) {
      try {
        raw[i] = decodeURIComponent(raw[i] as string);
      } catch {
        // Malformed %-escape: keep the raw segment (matches round 1 behaviour).
      }
    }
  }
  return raw;
}
