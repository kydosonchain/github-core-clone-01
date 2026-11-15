// The in-memory store and the git object model.
//
// Everything the forge serves — REST, GraphQL, MCP and git smart HTTP — reads
// and writes this one store, so the four surfaces can never disagree. Objects
// pushed over git are stored byte-for-byte; server-made commits (contents API,
// squash merges) use a fixed epoch plus a monotonic counter, never the wall
// clock, so a replay of the same trial leaves the same state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const AGENT_NAME = 'github-core-clone/1.0.0';
/** Deterministic base timestamp (seconds) for server-made commits. */
export const FIXED_EPOCH = 1700000000;
export const SERVER_IDENTITY = 'github-core-clone <forge@make.fun>';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  owner: string;
  name: string;
  id: number;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Shared issue + pull-request counter (GitHub shares one counter per repo). */
  numberSeq: number;
  commentSeq: number;
  parsedCommits: Map<string, CommitInfo>;
  parsedTrees: Map<string, TreeEntry[]>;
}

export class Store {
  readonly viewer = { login: VIEWER_LOGIN, id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
  readonly repos = new Map<string, Repo>();
  seq = 0;
  commitSeq = 0;
  requestSeq = 0;
  nextRepoId = 5000;

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean }): Repo {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) throw new Error(`repository ${owner}/${name} already exists`);
    const repo: Repo = {
      owner,
      name,
      id: this.nextRepoId,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      numberSeq: 0,
      commentSeq: 0,
      parsedCommits: new Map(),
      parsedTrees: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.createdSeq - b.createdSeq);
  }
}

// ---------------------------------------------------------------------------------------------
// Object hashing and parsing
// ---------------------------------------------------------------------------------------------

/** The git SHA-1 of an object: `SHA-1("<type> <size>\0" + bytes)`. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? '' : text.slice(split + 2);
  // Git stores the message with a trailing newline; the logical message has none.
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseCommitCached(repo: Repo, oid: string, data: Buffer): CommitInfo {
  let info = repo.parsedCommits.get(oid);
  if (!info) {
    info = parseCommit(data);
    repo.parsedCommits.set(oid, info);
  }
  return info;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) throw new Error('bad tree entry: no mode');
    const mode = data.subarray(i, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) throw new Error('bad tree entry: no name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('bad tree entry: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function parseTreeCached(repo: Repo, oid: string, data: Buffer): TreeEntry[] {
  let entries = repo.parsedTrees.get(oid);
  if (!entries) {
    entries = parseTree(data);
    repo.parsedTrees.set(oid, entries);
  }
  return entries;
}

/** Git tree order: entries sorted by name, directories compared as `name/`. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return Buffer.compare(Buffer.from(ka, 'utf8'), Buffer.from(kb, 'utf8'));
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(opts: { tree: string; parents: string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author}`, `committer ${opts.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${opts.message}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? '' : text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Store an object (deduplicated by oid) and return its oid. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Create a server-made commit (contents API, squash merge) with a deterministic timestamp. */
export function makeServerCommit(store: Store, repo: Repo, opts: { tree: string; parents: string[]; message: string }): string {
  const ts = FIXED_EPOCH + store.commitSeq;
  store.commitSeq += 1;
  const stamp = `${SERVER_IDENTITY} ${ts} +0000`;
  const data = buildCommit({ tree: opts.tree, parents: opts.parents, author: stamp, committer: stamp, message: opts.message });
  return putObject(repo, 'commit', data);
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

export type PktItem = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Parse pkt-lines from the front of `buf`; `rest` is whatever follows the last complete line.
 * With `stopAtFirstFlush`, parsing stops at the first flush and `rest` is everything after it
 * (receive-pack: the pack bytes follow the command flush). */
export function parsePktLines(buf: Buffer, opts: { stopAtFirstFlush?: boolean } = {}): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const lenHex = buf.subarray(i, i + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len) || len < 0) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    if (len === 0) {
      items.push({ kind: 'flush' });
      i += 4;
      if (opts.stopAtFirstFlush) break;
      continue;
    }
    if (len === 1) {
      items.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len < 4) throw new Error(`bad pkt-line length ${len}`);
    if (i + len > buf.length) break; // incomplete line: leave it in rest
    items.push({ kind: 'data', data: Buffer.from(buf.subarray(i + 4, i + len)) });
    i += len;
  }
  return { items, rest: buf.subarray(i) };
}

export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const head = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Wrap `data` in sideband packets of band `band`, chunked so no pkt-line exceeds the limit. */
export function sideband(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  if (data.length === 0) return out;
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.subarray(i, Math.min(i + CHUNK, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------------------------

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (p >= delta.length) throw new Error('truncated delta varint');
      const b = delta[p];
      p += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let total = 0;
  while (p < delta.length) {
    const op = delta[p];
    p += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[p++];
      if (op & 0x02) offset |= delta[p++] << 8;
      if (op & 0x04) offset |= delta[p++] << 16;
      if (op & 0x08) offset |= delta[p++] << 24;
      if (op & 0x10) size = delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      if (p + op > delta.length) throw new Error('truncated delta insert');
      parts.push(delta.subarray(p, p + op));
      p += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== tgtSize) throw new Error('delta target size mismatch');
  return Buffer.concat(parts);
}

/** Inflate one zlib stream at `offset` (bounded by `end`); returns its bytes and the next offset. */
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${err instanceof Error ? err.message : String(err)}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

const TYPE_CODES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUMBERS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/**
 * Read a packfile (version 2 or 3), resolving OFS_DELTA and REF_DELTA entries.
 * `resolveBase` supplies a base object a thin pack leaves out (the server's own store).
 * Every object's SHA-1 is recomputed; a mismatch is an error.
 */
export function readPack(buf: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('truncated pack');
    let b = buf[offset];
    offset += 1;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (offset >= trailerStart) throw new Error('truncated pack size');
      b = buf[offset];
      offset += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('truncated ofs delta');
      b = buf[offset];
      offset += 1;
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        if (offset >= trailerStart) throw new Error('truncated ofs delta');
        b = buf[offset];
        offset += 1;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      if (baseOff <= 0 || baseOff > entryOffset) throw new Error('bad ofs-delta base offset');
      entry.baseOffset = entryOffset - baseOff;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('truncated ref delta');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!TYPE_CODES[typeCode]) {
      throw new Error(`bad pack object type ${typeCode}`);
    }
    const inflated = inflateAt(buf, offset, trailerStart);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error('ref-delta base not found');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = TYPE_CODES[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const { type, data, oid } = resolve(entry);
    objects.set(oid, { type, data });
  }
  return objects;
}

function packEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** Pack cache: a pack's bytes are a pure function of its object set (objects are immutable, entries are sorted by oid, deflate is deterministic), so identical fetches reuse the same bytes. Capped to keep memory bounded. */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 128;

/** Write a plain version-2 pack (no deltas), entries sorted by oid for determinism. */
export function writePack(objects: Map<string, GitObject>): Buffer {
  const oids = [...objects.keys()].sort();
  const key = oids.join(',');
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = objects.get(oid)!;
    parts.push(packEntryHeader(TYPE_NUMBERS[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  const pack = Buffer.concat([body, trailer]);
  if (packCache.size >= PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

// ---------------------------------------------------------------------------------------------
// Reachability and ancestry
// ---------------------------------------------------------------------------------------------

/** All objects reachable from `tips` (commits, their trees and blobs, tags dereferenced). */
export function collectObjects(repo: Repo, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommitCached(repo, oid, obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTreeCached(repo, oid, obj.data)) queue.push(e.oid);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when `anc` is `desc` itself or one of its ancestors. */
export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const queue = [desc];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommitCached(repo, oid, obj.data).parents) queue.push(p);
  }
  return false;
}

/** The nearest common ancestor of `a` and `b` (first-parent-BFS from both sides), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = new Map<string, number>();
  const qa: Array<[string, number]> = [[a, 0]];
  let qi = 0;
  while (qi < qa.length) {
    const [oid, d] = qa[qi];
    qi += 1;
    if (ancA.has(oid)) continue;
    ancA.set(oid, d);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommitCached(repo, oid, obj.data).parents) qa.push([p, d + 1]);
  }
  const qb: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  qi = 0;
  let best: string | null = null;
  let bestScore = Infinity;
  while (qi < qb.length) {
    const [oid, d] = qb[qi];
    qi += 1;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const da = ancA.get(oid);
    if (da !== undefined) {
      const score = da + d;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommitCached(repo, oid, obj.data).parents) qb.push([p, d + 1]);
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Fetch selection (shallow / deepen)
// ---------------------------------------------------------------------------------------------

export interface FetchSelection {
  /** Objects to send, keyed by oid. */
  objects: Map<string, GitObject>;
  /** New shallow boundary commits (at the depth limit, with parents cut off). */
  shallow: string[];
  /** Former shallow boundaries whose parents are now included. */
  unshallow: string[];
  /** Haves that are ancestors of (or equal to) a want. */
  acks: string[];
}

/**
 * Compute what a fetch sends.
 *
 * Depth N includes commits at distance 0..N-1 from the wants; the boundary is
 * the distance-(N-1) commits that still have parents. Without a depth the walk
 * is unlimited and the send-set is reachable(wants) minus reachable(haves).
 * With a depth the client is shallow: it already holds the have commits and
 * the shallow boundaries themselves (with their trees) but not their ancestors.
 */
export function selectFetch(repo: Repo, opts: { wants: string[]; haves: string[]; shallow: string[]; deepen?: number }): FetchSelection {
  const { wants, haves, shallow, deepen } = opts;
  const maxDepth = deepen ?? Infinity;

  // 1. Wanted commits with their distance from the wants.
  const wantedCommits = new Map<string, number>();
  const wantedOther = new Set<string>();
  const queue: Array<[string, number]> = [];
  const queueCommit = (oid: string, d: number): void => {
    if (!wantedCommits.has(oid)) {
      wantedCommits.set(oid, d);
      queue.push([oid, d]);
    }
  };
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'commit') queueCommit(w, 0);
    else if (obj.type === 'tag') {
      wantedOther.add(w);
      const target = parseTag(obj.data).object;
      const tobj = repo.objects.get(target);
      if (tobj?.type === 'commit') queueCommit(target, 0);
      else if (tobj) wantedOther.add(target);
    } else wantedOther.add(w);
  }
  let qi = 0;
  while (qi < queue.length) {
    const [oid, d] = queue[qi];
    qi += 1;
    if (d >= maxDepth - 1) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommitCached(repo, oid, obj.data).parents) queueCommit(p, d + 1);
  }

  // 2. What the client already holds.
  const held = new Set<string>();
  if (deepen === undefined) {
    for (const h of haves) for (const oid of collectObjects(repo, [h])) held.add(oid);
  } else {
    for (const h of [...haves, ...shallow]) {
      const obj = repo.objects.get(h);
      if (!obj) continue;
      held.add(h);
      if (obj.type === 'commit') {
        const c = parseCommitCached(repo, h, obj.data);
        for (const oid of collectObjects(repo, [c.tree])) held.add(oid);
      }
    }
  }

  // 3. Send-set: wanted commits (not held) with their tree closures, plus wanted
  // non-commit objects with their closures. Ancestors are sent only when they are
  // themselves wanted (the depth limit), never as part of a tree closure.
  const send = new Map<string, GitObject>();
  const addTreeClosure = (treeOid: string): void => {
    for (const oid of collectObjects(repo, [treeOid])) {
      if (!held.has(oid)) {
        const obj = repo.objects.get(oid);
        if (obj) send.set(oid, obj);
      }
    }
  };
  for (const oid of wantedCommits.keys()) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    send.set(oid, obj);
    addTreeClosure(parseCommitCached(repo, oid, obj.data).tree);
  }
  for (const oid of wantedOther) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    send.set(oid, obj);
    if (obj.type === 'tree') addTreeClosure(oid);
  }

  // 4. Shallow / unshallow lines.
  const shallowOut: string[] = [];
  if (deepen !== undefined) {
    for (const [oid, d] of wantedCommits) {
      if (d !== maxDepth - 1) continue;
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit' && parseCommitCached(repo, oid, obj.data).parents.length > 0) shallowOut.push(oid);
    }
  }
  const unshallowOut: string[] = [];
  for (const b of shallow) {
    const obj = repo.objects.get(b);
    if (!obj || obj.type !== 'commit') continue;
    if (!wantedCommits.has(b)) continue;
    const parents = parseCommitCached(repo, b, obj.data).parents;
    if (parents.length > 0 && parents.every((p) => wantedCommits.has(p))) unshallowOut.push(b);
  }

  // 5. Acknowledgements: haves that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  for (const h of haves) {
    if (!repo.objects.has(h)) continue;
    for (const w of wants) {
      if (isAncestor(repo, h, w)) {
        acks.push(h);
        break;
      }
    }
  }

  return { objects: send, shallow: shallowOut, unshallow: unshallowOut, acks };
}

// ---------------------------------------------------------------------------------------------
// Trees: flatten, build, diff, merge
// ---------------------------------------------------------------------------------------------

/** A tree flattened to path -> {oid, mode} (files only). */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (tOid: string, prefix: string): void => {
    const obj = repo.objects.get(tOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTreeCached(repo, tOid, obj.data)) {
      const path = prefix + e.name;
      if (e.mode === '40000') walk(e.oid, `${path}/`);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) a tree from a flattened path map. */
export function buildTreeFromMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const buildDir = (dirPrefix: string): string => {
    const entries: TreeEntry[] = [];
    const subNames = new Set<string>();
    for (const [path, f] of files) {
      if (!path.startsWith(dirPrefix)) continue;
      const rest = path.slice(dirPrefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) entries.push({ mode: f.mode, name: rest, oid: f.oid });
      else subNames.add(rest.slice(0, slash));
    }
    for (const sub of subNames) {
      entries.push({ mode: '40000', name: sub, oid: buildDir(`${dirPrefix}${sub}/`) });
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return buildDir('');
}

/** Set (or delete, when blobOid is null) one path in a tree; returns the new tree oid. */
export function setFileInTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
  const files = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map<string, { oid: string; mode: string }>();
  // A path cannot be both a file and a directory: drop conflicting entries.
  for (const p of [...files.keys()]) {
    if (p === path || p.startsWith(`${path}/`) || path.startsWith(`${p}/`)) files.delete(p);
  }
  if (blobOid) files.set(path, { oid: blobOid, mode: '100644' });
  return buildTreeFromMap(repo, files);
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** LCS line diff: counts of added and deleted lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The file-level diff between two trees (base -> head). */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string): FileChange[] {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map<string, { oid: string; mode: string }>();
  const head = flattenTree(repo, headTreeOid);
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (!b && h) {
      const content = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions } = lineDiff('', content);
      out.push({ path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && !h) {
      const content = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const { deletions } = lineDiff(content, '');
      out.push({ path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b && h && b.oid !== h.oid) {
      const oldC = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newC = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldC, newC);
      out.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/**
 * Three-way merge of trees: base -> head changes applied onto the current tree.
 * A path changed on both sides to different contents is a conflict.
 */
export function threeWayMerge(
  repo: Repo,
  baseTreeOid: string,
  headTreeOid: string,
  currentTreeOid: string,
): { treeOid: string; conflict: boolean; conflictPaths: string[] } {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const current = flattenTree(repo, currentTreeOid);
  const merged = new Map(current);
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...head.keys(), ...current.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const c = current.get(path);
    const headChanged = (b?.oid ?? null) !== (h?.oid ?? null);
    const currentChanged = (b?.oid ?? null) !== (c?.oid ?? null);
    if (!headChanged) continue;
    if (!currentChanged) {
      if (h) merged.set(path, h);
      else merged.delete(path);
      continue;
    }
    if ((h?.oid ?? null) === (c?.oid ?? null)) continue;
    conflicts.push(path);
  }
  if (conflicts.length > 0) return { treeOid: '', conflict: true, conflictPaths: conflicts };
  return { treeOid: buildTreeFromMap(repo, merged), conflict: false, conflictPaths: [] };
}

// ---------------------------------------------------------------------------------------------
// Global ids (opaque, stable, never the plain database id)
// ---------------------------------------------------------------------------------------------

export function globalId(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; payload: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`);
}

// ---------------------------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------------------------

/** Resolve a branch name, full ref, or 40-hex oid to a commit oid (tags dereferenced). */
export function resolveRefToCommit(repo: Repo, ref: string): string | undefined {
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    return repo.objects.has(ref) ? ref : undefined;
  }
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const oid = repo.refs.get(full);
  if (!oid) return undefined;
  const obj = repo.objects.get(oid);
  if (obj?.type === 'tag') return parseTag(obj.data).object;
  return oid;
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

export function defaultBranchTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** The commit a ref points at, dereferencing annotated tags; undefined when missing. */
export function refTargetCommit(repo: Repo, refName: string): string | undefined {
  const oid = repo.refs.get(refName);
  if (!oid) return undefined;
  const obj = repo.objects.get(oid);
  if (obj?.type === 'tag') return parseTag(obj.data).object;
  return oid;
}
