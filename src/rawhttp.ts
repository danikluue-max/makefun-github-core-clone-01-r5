// Minimal HTTP/1.1 server on node:net, written for this entry's hot paths.
// Replaces Node's http server: no Date header, no Connection/Keep-Alive
// headers, one write per response, and a synchronous buffered body so the
// handlers never wait a tick for a body that already arrived.
//
// The handler surface this emulates (everything the entry's handlers use):
//   req.method, req.url, lowercased req.headers, readBody() for the body
//   res.writeHead(status, headers), res.end(body?), res.headersSent
// Behaviour on malformed input mirrors the previous implementation exactly:
// a bad request line, a header line without a colon, an unsafe
// Content-Length, or a malformed chunked body destroys the socket.
import { createServer as createNetServer, type Socket } from 'node:net';

type Handler = (req: any, res: any) => void;

/** The request the handlers see. A plain class (no EventEmitter): the body
 *  is already fully buffered when the handler runs, so there is nothing to
 *  stream. `bodyBuffer` is what wire.ts's readBody() resolves with. */
class RawRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly bodyBuffer: Buffer;

  constructor(method: string, url: string, headers: Record<string, string>, body: Buffer) {
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.bodyBuffer = body;
  }
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

class RawResponse {
  headersSent = false;
  private status = 200;
  private headers: Record<string, string> = {};
  private ended = false;
  private readonly socket: Socket;
  private readonly closeAfter: () => boolean;
  private readonly flushed: () => void;

  constructor(socket: Socket, closeAfter: () => boolean, flushed: () => void) {
    this.socket = socket;
    this.closeAfter = closeAfter;
    this.flushed = flushed;
  }

  writeHead(status: number, headers: Record<string, string> = {}): this {
    if (!this.headersSent) {
      this.status = status;
      this.headers = { ...headers };
    }
    return this;
  }

  end(body?: string | Buffer): this {
    if (this.ended) return this;
    this.ended = true;
    const noBody = this.status === 204 || this.status === 304;
    const payload = noBody || body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(body);
    const headers = { ...this.headers };
    let hasLength = false;
    let hasConnection = false;
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (lower === 'content-length') hasLength = true;
      else if (lower === 'connection') hasConnection = true;
    }
    if (noBody) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-length') delete headers[key];
      }
    } else if (!hasLength) {
      headers['Content-Length'] = String(payload.length);
    }
    if (this.closeAfter() && !hasConnection) headers.Connection = 'close';
    // One allocation for head + payload, one write on the socket.
    let head = `HTTP/1.1 ${this.status} ${STATUS_TEXT[this.status] ?? 'OK'}\r\n`;
    for (const name of Object.keys(headers)) head += `${name}: ${headers[name]}\r\n`;
    head += '\r\n';
    const headBytes = Buffer.byteLength(head, 'ascii');
    const out = Buffer.allocUnsafe(headBytes + payload.length);
    out.write(head, 0, headBytes, 'ascii');
    payload.copy(out, headBytes);
    this.headersSent = true;
    this.socket.write(out, () => {
      this.flushed();
    });
    return this;
  }
}

export function createRawServer(handler: Handler) {
  return createNetServer((socket) => {
    socket.setNoDelay(true);
    socket.setTimeout(60_000, () => socket.destroy());
    let input = Buffer.alloc(0);
    let busy = false;
    let mustClose = false;
    let closedResponse = false;
    let sentContinue = false;

    const parse = (): void => {
      if (busy || socket.destroyed) return;
      const boundary = input.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      // --- request line + headers, scanned by hand (no split/regex) ---
      const headerText = input.subarray(0, boundary).toString('latin1');
      const firstSpace = headerText.indexOf(' ');
      const secondSpace = firstSpace < 0 ? -1 : headerText.indexOf(' ', firstSpace + 1);
      if (firstSpace <= 0 || secondSpace <= firstSpace + 1) return socket.destroy();
      const method = headerText.slice(0, firstSpace);
      const url = headerText.slice(firstSpace + 1, secondSpace);
      // The version must be exactly HTTP/1.0 or HTTP/1.1 and end the line.
      let lineEnd = headerText.indexOf('\r\n');
      if (lineEnd < 0) lineEnd = headerText.length;
      const version = headerText.slice(secondSpace + 1, lineEnd);
      if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') return socket.destroy();
      const headers: Record<string, string> = {};
      let at = lineEnd === headerText.length ? lineEnd : lineEnd + 2;
      while (at < headerText.length) {
        const next = headerText.indexOf('\r\n', at);
        const line = next < 0 ? headerText.slice(at) : headerText.slice(at, next);
        const colon = line.indexOf(':');
        if (colon <= 0) return socket.destroy();
        const name = line.slice(0, colon).trim().toLowerCase();
        if (!(name in headers)) headers[name] = line.slice(colon + 1).trim();
        if (next < 0) break;
        at = next + 2;
      }
      // Answer 100-continue as soon as the headers are in, BEFORE waiting for
      // the body: a client that waits for it would otherwise deadlock against
      // our body-length wait below.
      if ((headers.expect ?? '').toLowerCase() === '100-continue' && !sentContinue) {
        sentContinue = true;
        socket.write('HTTP/1.1 100 Continue\r\n\r\n');
      }
      const bodyStart = boundary + 4;
      let bodyLength = 0;
      const chunked = (headers['transfer-encoding'] ?? '')
        .toLowerCase().split(',').map((v) => v.trim()).includes('chunked');
      if (!chunked) {
        bodyLength = Number(headers['content-length'] ?? 0);
        if (!Number.isSafeInteger(bodyLength) || bodyLength < 0) return socket.destroy();
      }
      let body: Buffer;
      let consumed: number;
      if (chunked) {
        const decoded: Buffer[] = [];
        let pos = bodyStart;
        for (;;) {
          const lineEnd2 = input.indexOf('\r\n', pos);
          if (lineEnd2 < 0) return;
          const size = Number.parseInt(input.subarray(pos, lineEnd2).toString('ascii').split(';')[0] ?? '', 16);
          if (!Number.isSafeInteger(size) || size < 0) return socket.destroy();
          pos = lineEnd2 + 2;
          if (size === 0) {
            const trailerEnd = input.indexOf('\r\n\r\n', pos);
            if (input.subarray(pos, pos + 2).toString() === '\r\n') { consumed = pos + 2; break; }
            if (trailerEnd < 0) return;
            consumed = trailerEnd + 4;
            break;
          }
          if (input.length < pos + size + 2) return;
          if (input[pos + size] !== 13 || input[pos + size + 1] !== 10) return socket.destroy();
          decoded.push(input.subarray(pos, pos + size));
          pos += size + 2;
        }
        body = Buffer.concat(decoded);
      } else {
        if (input.length < bodyStart + bodyLength) return;
        body = input.subarray(bodyStart, bodyStart + bodyLength);
        consumed = bodyStart + bodyLength;
      }
      input = input.subarray(consumed!);
      busy = true;
      sentContinue = false;
      mustClose = (headers.connection ?? '').toLowerCase().split(',').map((v) => v.trim()).includes('close');
      const req = new RawRequest(method, url, headers, body);
      const res = new RawResponse(socket, () => mustClose, () => {
        if (mustClose) { closedResponse = true; socket.end(); }
        else { busy = false; parse(); }
      });
      try { handler(req, res); } catch { if (!res.headersSent) { res.writeHead(500); res.end(); } else res.end(); }
    };
    socket.on('data', (data) => {
      // Zero-copy when nothing is buffered: use the chunk itself.
      input = input.length === 0 ? data : Buffer.concat([input, data]);
      parse();
    });
    socket.on('end', () => { if (!closedResponse && !busy) socket.destroy(); });
    socket.on('error', () => {});
  });
}
