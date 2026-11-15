// git smart HTTP: info/refs, git-upload-pack (protocol v2 and v0) and git-receive-pack.
//
// Protocol notes the implementation is built to:
//  - info/refs answers the v2 capability advertisement when the request carries
//    `Git-Protocol: version=2`, and the v0 ref advertisement otherwise.
//  - v2 ls-refs honours peel / symrefs / unborn and filters ref-prefix server-side.
//  - v2/v0 fetch sends exactly the objects the client does not hold (see
//    selectFetch in store.ts), with shallow/unshallow lines and ACK/NAK.
//  - receive-pack stores the pushed pack even when a ref update is refused, and
//    reports a non-fast-forward with the exact reason `non-fast-forward`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AGENT_NAME,
  ZERO_OID,
  defaultBranchTip,
  isAncestor,
  parsePktLines,
  parseTag,
  pktLine,
  flushPkt,
  delimPkt,
  readPack,
  selectFetch,
  sideband,
  writePack,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';
import { sendJson, sendRaw } from './respond.ts';

export interface GitOpts {
  authed: boolean;
  body: Buffer;
  requestId: string;
}

/** Route a `/{owner}/{repo}.git/...` request. Returns true when handled. */
export function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  subpath: string,
  query: URLSearchParams,
  opts: GitOpts,
): boolean {
  if (owner !== store.viewer.login) {
    sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': opts.requestId });
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Repository not found' }, { 'x-github-request-id': opts.requestId });
    return true;
  }
  const isWrite = subpath === 'git-receive-pack';
  if (!opts.authed && (repo.private || isWrite)) {
    sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': opts.requestId });
    return true;
  }
  try {
    if (subpath === 'info/refs' && req.method === 'GET') {
      infoRefs(req, res, repo, query);
      return true;
    }
    if (subpath === 'git-upload-pack' && req.method === 'POST') {
      uploadPack(req, res, repo, opts.body);
      return true;
    }
    if (subpath === 'git-receive-pack' && req.method === 'POST') {
      receivePack(req, res, repo, opts.body);
      return true;
    }
  } catch (err) {
    // A malformed git request must never take the server down.
    process.stderr.write(`[git] ${subpath} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.writableEnded) {
      sendJson(res, 400, { message: 'Bad Request' }, { 'x-github-request-id': opts.requestId });
    }
    return true;
  }
  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': opts.requestId });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer[] {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack_detailed thin-pack side-band-64k ofs-delta shallow agent=${AGENT_NAME}`
      : `symref=HEAD:refs/heads/${repo.defaultBranch} report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT_NAME}`;
  const headTip = defaultBranchTip(repo);
  const lines: string[] = [];
  lines.push(`${headTip ?? ZERO_OID} ${headTip ? 'HEAD' : 'capabilities^{}'}\0${caps}\n`);
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}\n`);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag' && name.startsWith('refs/tags/')) {
      lines.push(`${parseTag(obj.data).object} ${name}^{}\n`);
    }
  }
  return lines.map((l) => pktLine(l));
}

function v2Advertisement(): Buffer[] {
  const lines = ['version 2', `agent=${AGENT_NAME}`, 'object-format=sha1', 'ls-refs=unborn', 'fetch=shallow thin-pack ofs-delta'];
  return lines.map((l) => pktLine(`${l}\n`));
}

function infoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  const service = query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, { message: 'service parameter is required' });
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  const v2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt()];
  if (v2) {
    parts.push(...v2Advertisement());
  } else {
    parts.push(...v0Advertisement(repo, service));
  }
  parts.push(flushPkt());
  sendRaw(res, 200, Buffer.concat(parts), contentType);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

interface ParsedRequest {
  headerLines: string[];
  argLines: string[];
}

/** Split a v2 request body into the command section and the argument section (after the delim). */
function parseV2Request(body: Buffer): ParsedRequest {
  const { items } = parsePktLines(body);
  const headerLines: string[] = [];
  const argLines: string[] = [];
  let section = 0;
  for (const item of items) {
    if (item.kind === 'delim') {
      section = 1;
      continue;
    }
    if (item.kind === 'flush') break;
    const text = item.data.toString('utf8').replace(/\n$/, '');
    if (section === 0) headerLines.push(text);
    else argLines.push(text);
  }
  return { headerLines, argLines };
}

function uploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const v2 = req.headers['git-protocol'] === 'version=2';
  if (!v2) {
    fetchV0(res, repo, body);
    return;
  }
  const { headerLines, argLines } = parseV2Request(body);
  const command = (headerLines[0] ?? '').trim();
  if (command === '') {
    // An empty v2 request asks for the capability advertisement.
    const parts: Buffer[] = [...v2Advertisement(), flushPkt()];
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'command=ls-refs') {
    lsRefsV2(res, repo, argLines);
    return;
  }
  if (command === 'command=fetch') {
    fetchV2(res, repo, argLines);
    return;
  }
  sendJson(res, 400, { message: `unknown v2 command ${JSON.stringify(command)}` });
}

function lsRefsV2(res: ServerResponse, repo: Repo, argLines: string[]): void {
  const peel = argLines.includes('peel');
  const symrefs = argLines.includes('symrefs');
  const unborn = argLines.includes('unborn');
  const prefixes = argLines.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = defaultBranchTip(repo);
  if (keep('HEAD')) {
    if (headTip) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    const obj = repo.objects.get(oid);
    if (peel && obj?.type === 'tag') {
      line += ` peeled:${parseTag(obj.data).object}`;
    }
    lines.push(line);
  }
  const parts = lines.map((l) => pktLine(`${l}\n`));
  parts.push(flushPkt());
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
}

function parseFetchArgs(argLines: string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  for (const a of argLines) {
    if (a.startsWith('want ')) wants.push(a.slice(5).split(/[\s\0]/)[0]);
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = parseInt(a.slice(7).trim(), 10);
      if (!Number.isNaN(n)) deepen = n;
    }
  }
  return { wants, haves, shallow, deepen };
}

function fetchV2(res: ServerResponse, repo: Repo, argLines: string[]): void {
  const args = parseFetchArgs(argLines);
  const sel = selectFetch(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (sel.acks.length > 0) {
    for (const ack of sel.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(delimPkt());
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(delimPkt());
  }
  const wantedRefs: string[] = [];
  for (const w of args.wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === w) wantedRefs.push(`${oid} ${name}`);
    }
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const r of wantedRefs) parts.push(pktLine(`${r}\n`));
    parts.push(delimPkt());
  }
  if (sel.objects.size > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sideband(1, writePack(sel.objects)));
  }
  parts.push(flushPkt());
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function fetchV0(res: ServerResponse, repo: Repo, body: Buffer): void {
  const { items } = parsePktLines(body);
  const argLines: string[] = [];
  for (const item of items) {
    if (item.kind !== 'data') continue;
    argLines.push(item.data.toString('utf8').replace(/\n$/, ''));
  }
  const args = parseFetchArgs(argLines);
  const sel = selectFetch(repo, args);
  const parts: Buffer[] = [];
  // v0 has no `ready` line: the client only accepts NAK / ACK / shallow / unshallow here.
  if (sel.acks.length > 0) {
    for (const ack of sel.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  if (sel.objects.size > 0) {
    parts.push(...sideband(1, writePack(sel.objects)));
  }
  parts.push(flushPkt());
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function applyPushCommand(repo: Repo, cmd: PushCommand): { ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = cmd;
  if (!ref.startsWith('refs/')) return { ok: false, reason: 'invalid refname' };
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ok: false, reason: 'stale info' };
    repo.refs.delete(ref);
    return { ok: true, reason: '' };
  }
  const newObj = repo.objects.get(newOid);
  if (!newObj) return { ok: false, reason: 'object not found' };
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    repo.refs.set(ref, newOid);
    return { ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
  if (oldOid !== current) return { ok: false, reason: 'stale info' };
  if (newObj.type === 'commit') {
    if (!isAncestor(repo, oldOid, newOid)) return { ok: false, reason: 'non-fast-forward' };
  } else if (newObj.type === 'tag') {
    const target = parseTag(newObj.data).object;
    const curObj = repo.objects.get(current);
    const curTarget = curObj?.type === 'tag' ? parseTag(curObj.data).object : current;
    if (!isAncestor(repo, curTarget, target)) return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ok: true, reason: '' };
}

function receivePack(_req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const { items, rest } = parsePktLines(body, { stopAtFirstFlush: true });
  const commands: PushCommand[] = [];
  let reportStatusV2 = false;
  let sideBand = false;
  for (const item of items) {
    if (item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    const text = item.data.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.includes('report-status-v2')) reportStatusV2 = true;
      if (caps.includes('side-band-64k')) sideBand = true;
    }
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }

  // Unpack first: the pack's objects are stored even when a ref update is refused.
  let unpackOk = true;
  let unpackDetail = '';
  if (rest.length > 0) {
    try {
      const incoming: Map<string, GitObject> = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of incoming) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [];
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail || 'error'}`);
  if (unpackOk) {
    for (const cmd of commands) {
      const result = applyPushCommand(repo, cmd);
      if (result.ok) reportLines.push(`ok ${cmd.ref}`);
      else reportLines.push(`ng ${cmd.ref} ${result.reason}`);
      if (reportStatusV2) {
        reportLines.push(`option old-oid ${cmd.oldOid}`);
        reportLines.push(`option new-oid ${cmd.newOid}`);
      }
    }
  }
  const reportPkt = Buffer.concat(reportLines.map((l) => pktLine(`${l}\n`)));
  let payload: Buffer;
  if (sideBand) {
    payload = Buffer.concat([...sideband(1, reportPkt), flushPkt()]);
  } else {
    payload = Buffer.concat([reportPkt, flushPkt()]);
  }
  sendRaw(res, 200, payload, 'application/x-git-receive-pack-result');
}
