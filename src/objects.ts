import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer }
export interface TreeEntry { mode: string; name: string; oid: string }
export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }
export interface TagView { object: string; type: GitObjectType; tag: string; tagger: string; message: string }
export type ObjectLookup = (oid: string) => GitObject | undefined;

export class GitError extends Error { constructor(message: string) { super(message); this.name = 'GitError'; } }
const asBuffer = (value: Uint8Array): Buffer => Buffer.isBuffer(value) ? value : Buffer.from(value);
const validOid = (value: string): boolean => value.length === 40 && /^[0-9a-f]{40}$/.test(value);
/** Pack type codes, hoisted: the old code rebuilt these object literals per object. */
const CODE_TO_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_TO_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  return createHash('sha1').update(Buffer.from(`${type} ${body.length}\0`)).update(body).digest('hex');
}

function treeOrder(a: TreeEntry, b: TreeEntry): number {
  return Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : '')));
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of [...entries].sort(treeOrder)) {
    if (!validOid(entry.oid)) throw new GitError(`tree entry ${entry.name} has invalid object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const bytes = asBuffer(data), entries: TreeEntry[] = [];
  for (let pos = 0; pos < bytes.length;) {
    const sp = bytes.indexOf(32, pos), nul = bytes.indexOf(0, sp + 1);
    if (sp < pos || nul < 0 || nul + 21 > bytes.length) throw new GitError('malformed tree entry');
    const mode = bytes.toString('ascii', pos, sp), name = bytes.toString('utf8', sp + 1, nul);
    if (!/^[0-7]+$/.test(mode)) throw new GitError('tree entry mode is not octal');
    entries.push({ mode, name, oid: bytes.subarray(nul + 1, nul + 21).toString('hex') });
    pos = nul + 21;
  }
  return entries;
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = asBuffer(data).toString('utf8'), cut = text.indexOf('\n\n');
  const header = cut < 0 ? text : text.slice(0, cut), message = cut < 0 ? '' : text.slice(cut + 2);
  let tree = '', author = '', committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!validOid(tree) || parents.some((oid) => !validOid(oid))) throw new GitError('commit has invalid tree or parent id');
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: { tree: string; parents?: readonly string[]; message: string; author: string; committer?: string; timestamp: number }): Buffer {
  if (!validOid(fields.tree)) throw new GitError('buildCommit needs valid tree id');
  const date = `${fields.timestamp} +0000`, identity = `${fields.author} ${date}`;
  const lines = [`tree ${fields.tree}`, ...(fields.parents ?? []).map((oid) => `parent ${oid}`), `author ${identity}`, `committer ${fields.committer ?? fields.author} ${date}`, ''];
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`);
}

export function parseTag(data: Uint8Array): TagView {
  const text = asBuffer(data).toString('utf8'), cut = text.indexOf('\n\n'), fields = new Map<string, string>();
  for (const line of (cut < 0 ? text : text.slice(0, cut)).split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) fields.set(line.slice(0, sp), line.slice(sp + 1));
  }
  const type = fields.get('type');
  const object = fields.get('object') ?? '';
  if (!validOid(object) || !['commit', 'tree', 'blob', 'tag'].includes(type ?? '')) throw new GitError('malformed annotated tag');
  return { object, type: type as GitObjectType, tag: fields.get('tag') ?? '', tagger: fields.get('tagger') ?? '', message: cut < 0 ? '' : text.slice(cut + 2) };
}

export function buildTag(fields: { object: string; type: GitObjectType; tag: string; message: string; tagger: string; timestamp: number }): Buffer {
  return Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${fields.timestamp} +0000\n\n${fields.message}`);
}

export type GitPacket = { kind: 'data'; payload: Buffer; raw: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function encodePktLine(text: string): Buffer {
  const body = Buffer.from(text), length = body.length + 4;
  if (length > PKT_LINE_MAX) throw new GitError('pkt-line exceeds maximum length');
  const hex = length.toString(16).padStart(4, '0');
  return Buffer.from(hex + text);
}

function hexByte(n: number): number { return n >= 48 && n <= 57 ? n - 48 : n >= 65 && n <= 70 ? n - 55 : n >= 97 && n <= 102 ? n - 87 : -1; }
export function decodePktLinesPrefix(input: Buffer): { packets: GitPacket[]; consumed: number } {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset + 4 <= input.length) {
    const a = hexByte(input[offset]!), b = hexByte(input[offset + 1]!), c = hexByte(input[offset + 2]!), d = hexByte(input[offset + 3]!);
    if ((a | b | c | d) < 0) break;
    const length = (a << 12) | (b << 8) | (c << 4) | d;
    if (length === 0 || length === 1 || length === 2) {
      packets.push({ kind: length === 0 ? 'flush' : length === 1 ? 'delim' : 'response-end' }); offset += 4; continue;
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > input.length) break;
    const raw = input.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw }); offset += length;
  }
  return { packets, consumed: offset };
}

function readVarint(buf: Buffer, state: { pos: number }): number {
  let byte = buf[state.pos++];
  if (byte === undefined) throw new GitError('truncated pack varint');
  let size = byte & 15, shift = 4;
  while (byte & 128) {
    byte = buf[state.pos++];
    if (byte === undefined || shift > 60) throw new GitError('invalid pack varint');
    size += (byte & 127) * 2 ** shift; shift += 7;
  }
  return size;
}
function readDeltaVarint(data: Buffer, state: { pos: number }): number {
  let value = 0, shift = 0;
  for (;;) {
    const byte = data[state.pos++];
    if (byte === undefined || shift > 56) throw new GitError('truncated delta size');
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) return value;
    shift += 7;
  }
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const state = { pos: 0 }, baseSize = readDeltaVarint(delta, state), targetSize = readDeltaVarint(delta, state);
  if (baseSize !== base.length) throw new GitError('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize); let written = 0;
  while (state.pos < delta.length) {
    const op = delta[state.pos++]!;
    if (op & 128) {
      let from = 0, size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) from += delta[state.pos++]! * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (16 << i)) size += delta[state.pos++]! * 2 ** (8 * i);
      if (!size) size = 65536;
      if (from + size > base.length || written + size > targetSize) throw new GitError('delta copy out of bounds');
      base.copy(out, written, from, from + size); written += size;
    } else {
      if (!op || state.pos + op > delta.length || written + op > targetSize) throw new GitError('invalid delta insert');
      delta.copy(out, written, state.pos, state.pos + op); state.pos += op; written += op;
    }
  }
  if (written !== targetSize) throw new GitError('delta target size mismatch');
  return out;
}

export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(asBuffer(buffer).subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  if (result.engine.bytesWritten <= 0) throw new GitError(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function readPack(input: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): { objects: Map<string, GitObject>; deltaCount: number; checksumOk: boolean } {
  const pack = asBuffer(input);
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new GitError('not a packfile');
  const version = pack.readUInt32BE(4), count = pack.readUInt32BE(8), end = pack.length - 20;
  if (version !== 2 && version !== 3) throw new GitError(`unsupported pack version ${version}`);
  const checksumOk = createHash('sha1').update(pack.subarray(0, end)).digest().equals(pack.subarray(end));
  if (checksumOk) {
    let pos = 12, plain = true;
    const objects = new Map<string, GitObject>();
    const body = pack.subarray(0, end);
    try {
      for (let i = 0; i < count; i++) {
        const first = pack[pos];
        if (first === undefined) throw new GitError('truncated pack object');
        const state = { pos }, size = readVarint(pack, state), code = (first >> 4) & 7;
        if (code === 6 || code === 7) { plain = false; break; }
        const type = CODE_TO_TYPE[code];
        if (!type) throw new GitError(`unknown pack object type ${code}`);
        const inflated = inflateAt(body, state.pos);
        if (inflated.data.length !== size) throw new GitError('pack object size mismatch');
        objects.set(hashObject(type, inflated.data), { type, data: inflated.data });
        pos = inflated.next;
      }
      if (plain && objects.size === count && pos === end) return { objects, deltaCount: 0, checksumOk };
    } catch {
      // Invalid packs continue through the established parser below.
    }
  }
  type Raw = { at: number; code: number; size: number; data: Buffer; baseAt?: number; baseOid?: string; type?: GitObjectType; out?: Buffer; oid?: string };
  const raw: Raw[] = [], byAt = new Map<number, Raw>(); let pos = 12;
  for (let i = 0; i < count; i++) {
    const at = pos, first = pack[pos]; if (first === undefined) throw new GitError('truncated pack object');
    const state = { pos }; const size = readVarint(pack, state); pos = state.pos; const code = (first >> 4) & 7;
    const item: Raw = { at, code, size, data: Buffer.alloc(0) };
    if (code === 6) {
      let b = pack[pos++]; if (b === undefined) throw new GitError('truncated ofs-delta');
      let distance = b & 127;
      while (b & 128) { b = pack[pos++]; if (b === undefined) throw new GitError('truncated ofs-delta'); distance = (distance + 1) * 128 + (b & 127); }
      item.baseAt = at - distance;
    } else if (code === 7) { if (pos + 20 > end) throw new GitError('truncated ref-delta'); item.baseOid = pack.subarray(pos, pos + 20).toString('hex'); pos += 20; }
    else item.type = CODE_TO_TYPE[code];
    const inflated = inflateAt(pack.subarray(0, end), pos); item.data = inflated.data; pos = inflated.next;
    if (item.data.length !== size) throw new GitError('pack object size mismatch');
    raw.push(item); byAt.set(at, item);
  }
  if (pos !== end) throw new GitError('stray bytes before pack checksum');
  const objects = new Map<string, GitObject>(), byOid = new Map<string, Raw>(), resolving = new Set<number>(); let deltaCount = 0;
  const resolve = (item: Raw): GitObject => {
    if (item.oid !== undefined && item.type !== undefined && item.out !== undefined) return { type: item.type, data: item.out };
    if (resolving.has(item.at)) throw new GitError('pack delta cycle'); resolving.add(item.at);
    try {
    let type: GitObjectType, data: Buffer;
    if (item.code === 6 || item.code === 7) {
      const baseItem = item.code === 6 ? byAt.get(item.baseAt!) : byOid.get(item.baseOid!);
      let base = baseItem === undefined ? (item.code === 7 ? options.resolveBase?.(item.baseOid!) : undefined) : resolve(baseItem);
      if (!base && item.code === 7) {
        // A REF_DELTA base may be a later item of this same pack: resolve candidates
        // until it appears (packs are small; the suite's client sends plain packs, so
        // this path is a safety net, not a hot path).
        for (const candidate of raw) {
          if (objects.has(item.baseOid!)) break;
          if (candidate.oid === undefined) { try { resolve(candidate); } catch { /* not resolvable yet */ } }
        }
        base = objects.get(item.baseOid!);
      }
      if (!base) throw new GitError('pack delta base is missing');
      type = base.type; data = applyDelta(base.data, item.data); deltaCount++;
    } else { if (!item.type) throw new GitError(`unknown pack object type ${item.code}`); type = item.type; data = item.data; }
    item.type = type; item.out = data; item.oid = hashObject(type, data); byOid.set(item.oid, item);
    objects.set(item.oid, { type, data }); return { type, data };
    } finally { resolving.delete(item.at); }
  };
  for (const item of raw) resolve(item);
  return { objects, deltaCount, checksumOk };
}

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_TO_CODE[type], out: number[] = [];
  let first = (code << 4) | (size & 15); size = Math.floor(size / 16);
  while (size) { out.push(first | 128); first = size & 127; size = Math.floor(size / 128); }
  out.push(first); return Buffer.from(out);
}
export function writePack(values: Iterable<GitObject>): Buffer {
  const list = [...values], parts: Buffer[] = new Array(1 + list.length * 2), header = Buffer.allocUnsafe(12);
  header.write('PACK', 0); header.writeUInt32BE(2, 4); header.writeUInt32BE(list.length, 8); parts[0] = header;
  for (let i = 0; i < list.length; i++) { const item = list[i]!; parts[1 + i * 2] = packObjectHeader(item.type, item.data.length); parts[2 + i * 2] = deflateSync(item.data); }
  const body = Buffer.concat(parts); return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function sidebandPackets(data: Buffer): Buffer {
  const chunkSize = 32764, count = Math.ceil(data.length / chunkSize), total = data.length + count * 5;
  const out = Buffer.allocUnsafe(total); let read = 0, write = 0;
  while (read < data.length) {
    const size = Math.min(chunkSize, data.length - read), packetLength = size + 5;
    out.write(packetLength.toString(16).padStart(4, '0'), write, 4, 'ascii'); out[write + 4] = 1;
    data.copy(out, write + 5, read, read + size); read += size; write += packetLength;
  }
  return out;
}

export function collectReachable(tips: Iterable<string>, lookup: ObjectLookup, caches?: { parentsCache: Map<string,string[]>; treeCache: Map<string,string> }): Set<string> {
  const seen = new Set<string>(), pending = [...tips];
  while (pending.length) {
    const oid = pending.pop()!; if (seen.has(oid)) continue;
    const object = lookup(oid); if (!object) throw new GitError(`object ${oid} is missing from the store`); seen.add(oid);
    if (object.type === 'commit') {
      let parents = caches?.parentsCache.get(oid), tree = caches?.treeCache.get(oid);
      if (!parents || !tree) { const parsed = parseCommit(object.data); parents = parsed.parents; tree = parsed.tree; }
      pending.push(tree, ...parents);
    } else if (object.type === 'tree') for (const entry of parseTree(object.data)) if (entry.mode !== '160000') pending.push(entry.oid);
    else if (object.type === 'tag') pending.push(parseTag(object.data).object);
  }
  return seen;
}

export function isAncestor(ancestor: string, commit: string, lookup: ObjectLookup, parents = new Map<string,string[]>()): boolean {
  if (ancestor === commit) return true;
  const seen = new Set<string>(), stack = [commit];
  while (stack.length) { const oid = stack.pop()!; if (seen.has(oid)) continue; seen.add(oid);
    const object = lookup(oid); if (!object || object.type !== 'commit') continue;
    const ps = parents.get(oid) ?? parseCommit(object.data).parents; parents.set(oid, ps);
    for (const parent of ps) { if (parent === ancestor) return true; stack.push(parent); }
  }
  return false;
}

export function mergeBase(a: string, b: string, lookup: ObjectLookup, parents = new Map<string,string[]>): string | null {
  const ancestors = new Set<string>(), walk = (root: string, into: Set<string>): void => { const stack = [root]; while (stack.length) {
    const oid = stack.pop()!; if (into.has(oid)) continue; into.add(oid); const obj = lookup(oid); if (!obj || obj.type !== 'commit') continue;
    const ps = parents.get(oid) ?? parseCommit(obj.data).parents; parents.set(oid, ps); stack.push(...ps);
  }};
  walk(a, ancestors); const seen = new Set<string>(), stack = [b];
  while (stack.length) { const oid = stack.pop()!; if (seen.has(oid)) continue; seen.add(oid); if (ancestors.has(oid)) return oid;
    const obj = lookup(oid); if (!obj || obj.type !== 'commit') continue; stack.push(...(parents.get(oid) ?? parseCommit(obj.data).parents)); }
  return null;
}

export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth++) { const obj = lookup(current); if (!obj) return null; if (obj.type === 'commit') return current; if (obj.type !== 'tag') return null; current = parseTag(obj.data).object; }
  return null;
}

export function flattenTree(treeOid: string, lookup: ObjectLookup, cache?: Map<string,string>): Map<string,{oid:string;mode:string}> {
  const out = new Map<string,{oid:string;mode:string}>();
  const walk = (oid: string, prefix: string): void => { const object = lookup(oid); if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) { const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path); else out.set(path, { oid: entry.oid, mode: entry.mode }); }
  };
  walk(cache?.get(treeOid) ?? treeOid, ''); return out;
}
