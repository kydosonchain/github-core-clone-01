// REST v3 (`/api/v3`).
//
// Rules the whole surface follows: every reply is application/json, never
// HTML; every reply carries a non-empty X-GitHub-Request-Id; errors carry
// `{"message": string}`; no token on a private repository is 401; the same
// repository name under another owner is 404, never 403; a malformed JSON
// body is 400; an unknown route is 404 JSON.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_EPOCH,
  branchTip,
  defaultBranchTip,
  diffTrees,
  flattenTree,
  issueGlobalId,
  makeServerCommit,
  mergeBase,
  parseCommit,
  parseCommitCached,
  parseTreeCached,
  pullGlobalId,
  putObject,
  repoGlobalId,
  resolveRefToCommit,
  setFileInTree,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import {
  addIssueComment as addIssueCommentDomain,
  createIssue as createIssueDomain,
  createPull as createPullDomain,
  mergePullRequest as mergePullRequestDomain,
} from './domain.ts';
import { sendEmpty, sendJson } from './respond.ts';

export interface RestOpts {
  authed: boolean;
  body: Buffer;
  requestId: string;
  baseUrl: string;
}

function rid(opts: RestOpts): Record<string, string> {
  return { 'x-github-request-id': opts.requestId };
}

function ok(res: ServerResponse, status: number, obj: unknown, opts: RestOpts, extra: Record<string, string> = {}): void {
  sendJson(res, status, obj, { ...rid(opts), ...extra });
}

function fail(res: ServerResponse, status: number, message: string, opts: RestOpts): void {
  sendJson(res, status, { message }, rid(opts));
}

function parseBody(opts: RestOpts): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (opts.body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(opts.body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function iso(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString();
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, pageNum: number, perPage: number, total: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const build = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(page));
    return `<${baseUrl}${path}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (pageNum < lastPage) links.push(`${build(pageNum + 1)}; rel="next"`);
  if (pageNum > 1) links.push(`${build(pageNum - 1)}; rel="prev"`);
  links.push(`${build(1)}; rel="first"`);
  links.push(`${build(lastPage)}; rel="last"`);
  return links.join(', ');
}

// ---------------------------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------------------------

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: iso(FIXED_EPOCH),
    updated_at: iso(FIXED_EPOCH),
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? '';
  const baseSha = branchTip(repo, pull.baseRef) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

function userJson(store: Store): Record<string, unknown> {
  return {
    login: store.viewer.login,
    id: store.viewer.id,
    node_id: Buffer.from(`User:${store.viewer.login}`, 'utf8').toString('base64'),
    name: store.viewer.name,
    email: store.viewer.email,
    type: 'User',
  };
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** Load a repo for an owner-scoped route; answers 404 when the owner or repo is wrong. */
function loadRepo(store: Store, res: ServerResponse, owner: string, name: string, opts: RestOpts): Repo | null {
  if (owner !== store.viewer.login) {
    fail(res, 404, 'Not Found', opts);
    return null;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    fail(res, 404, 'Not Found', opts);
    return null;
  }
  return repo;
}

/** Enforce auth for a repo route: private repos need a token; writes always need one. */
function checkRepoAuth(repo: Repo, method: string, res: ServerResponse, opts: RestOpts): boolean {
  if (!opts.authed && (repo.private || method !== 'GET')) {
    fail(res, 401, 'Requires authentication', opts);
    return false;
  }
  return true;
}

/** The tip commit's tree oid for a branch, or null when the branch is unborn/missing. */
function branchTree(repo: Repo, branch: string): string | null {
  const tip = branchTip(repo, branch);
  if (!tip) return null;
  const obj = repo.objects.get(tip);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommitCached(repo, tip, obj.data).tree;
}

/** Commit JSON for a commit oid. */
function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const info = obj && obj.type === 'commit' ? parseCommit(obj.data) : { tree: '', parents: [] as string[], author: '', committer: '', message: '' };
  const parsePerson = (raw: string): { name: string; email: string; date: string } => {
    const m = /^([^<]*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw.trim());
    if (!m) return { name: raw, email: '', date: iso(FIXED_EPOCH) };
    return { name: m[1].trim(), email: m[2], date: iso(Number(m[3])) };
  };
  return {
    sha: oid,
    commit: {
      message: info.message,
      author: parsePerson(info.author),
      committer: parsePerson(info.committer),
      tree: { sha: info.tree },
    },
    parents: info.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

/** Route a `/api/v3/...` request. Returns true when handled. */
export function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  opts: RestOpts,
): boolean {
  const method = req.method ?? 'GET';
  try {
    // API root.
    if (segments.length === 0) {
      if (method !== 'GET') return fail(res, 404, 'Not Found', opts), true;
      return ok(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{username}',
      }, opts, { 'x-oauth-scopes': 'repo, read:org' }), true;
    }
    // /meta
    if (segments.length === 1 && segments[0] === 'meta') {
      if (method !== 'GET') return fail(res, 404, 'Not Found', opts), true;
      return ok(res, 200, { installed_version: '1.0.0' }, opts), true;
    }
    // /user
    if (segments.length === 1 && segments[0] === 'user') {
      if (method !== 'GET') return fail(res, 404, 'Not Found', opts), true;
      if (!opts.authed) return fail(res, 401, 'Requires authentication', opts), true;
      return ok(res, 200, userJson(store), opts), true;
    }
    // /user/repos
    if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      if (!opts.authed) return fail(res, 401, 'Requires authentication', opts), true;
      if (method === 'POST') return createRepo(store, req, res, opts);
      if (method === 'GET') return listUserRepos(store, req, res, query, opts);
      return fail(res, 404, 'Not Found', opts), true;
    }
    // /repos/{owner}/{name}[...]
    if (segments.length >= 3 && segments[0] === 'repos') {
      return handleRepoRoute(store, req, res, segments.slice(1), query, opts);
    }
    return fail(res, 404, 'Not Found', opts), true;
  } catch (err) {
    process.stderr.write(`[rest] ${method} /api/v3/${segments.join('/')} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.writableEnded) fail(res, 500, 'Internal Server Error', opts);
    return true;
  }
}

function createRepo(store: Store, _req: IncomingMessage, res: ServerResponse, opts: RestOpts): boolean {
  const parsed = parseBody(opts);
  if (!parsed.ok) return fail(res, 400, 'Invalid JSON body', opts), true;
  const name = asString(parsed.value.name);
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) {
    return fail(res, 422, 'Repository name is invalid', opts), true;
  }
  const owner = store.viewer.login;
  if (store.getRepo(owner, name)) {
    return fail(res, 422, `Repository ${owner}/${name} already exists`, opts), true;
  }
  const repo = store.createRepo(owner, name, {
    description: asString(parsed.value.description) ?? '',
    private: asBool(parsed.value.private) ?? false,
  });
  return ok(res, 201, repoJson(store, repo), opts), true;
}

function listUserRepos(store: Store, _req: IncomingMessage, res: ServerResponse, query: URLSearchParams, opts: RestOpts): boolean {
  const repos = store.listRepos(store.viewer.login);
  const { page, total, pageNum, perPage } = paginate(repos, query);
  const headers: Record<string, string> = {};
  if (total > perPage || pageNum > 1) {
    headers.link = linkHeader(opts.baseUrl, '/api/v3/user/repos', query, pageNum, perPage, total);
  }
  return ok(res, 200, page.map((r) => repoJson(store, r)), opts, headers), true;
}

// ---------------------------------------------------------------------------------------------
// Repository routes
// ---------------------------------------------------------------------------------------------

function handleRepoRoute(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  opts: RestOpts,
): boolean {
  const method = req.method ?? 'GET';
  const [owner, name, ...rest] = segments;
  const repo = loadRepo(store, res, owner, name, opts);
  if (!repo) return true;
  if (!checkRepoAuth(repo, method, res, opts)) return true;

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return ok(res, 200, repoJson(store, repo), opts), true;
    if (method === 'PATCH') {
      const parsed = parseBody(opts);
      if (!parsed.ok) return fail(res, 400, 'Invalid JSON body', opts), true;
      const description = asString(parsed.value.description);
      if (description !== undefined) repo.description = description;
      return ok(res, 200, repoJson(store, repo), opts), true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      sendEmpty(res, 204, rid(opts));
      return true;
    }
    return fail(res, 404, 'Not Found', opts), true;
  }

  const [section, ...tail] = rest;
  if (section === 'branches') return handleBranches(store, req, res, repo, tail, opts);
  if (section === 'commits') return handleCommits(store, req, res, repo, query, opts);
  if (section === 'git' && tail[0] === 'refs') return handleGitRefs(store, req, res, repo, tail.slice(1), opts);
  if (section === 'contents') return handleContents(store, req, res, repo, tail.join('/'), query, opts);
  if (section === 'labels') return handleLabels(store, req, res, repo, opts);
  if (section === 'issues') return handleIssues(store, req, res, repo, tail, query, opts);
  if (section === 'pulls') return handlePulls(store, req, res, repo, tail, query, opts);
  return fail(res, 404, 'Not Found', opts), true;
}

function handleBranches(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[], opts: RestOpts): boolean {
  const method = req.method ?? 'GET';
  if (method !== 'GET') return fail(res, 404, 'Not Found', opts), true;
  if (tail.length === 0) {
    const list = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return ok(res, 200, list, opts), true;
  }
  const branch = tail.join('/');
  const tip = branchTip(repo, branch);
  if (!tip) return fail(res, 404, 'Not Found', opts), true;
  return ok(res, 200, { name: branch, commit: { sha: tip }, protected: false }, opts), true;
}

function handleCommits(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo, query: URLSearchParams, opts: RestOpts): boolean {
  if ((req.method ?? 'GET') !== 'GET') return fail(res, 404, 'Not Found', opts), true;
  const ref = query.get('sha');
  let tip: string | undefined;
  if (ref) {
    tip = resolveRefToCommit(repo, ref);
    if (!tip) return fail(res, 404, 'Not Found', opts), true;
  } else {
    tip = defaultBranchTip(repo);
  }
  const oids: string[] = [];
  if (tip) {
    const seen = new Set<string>();
    let cur: string | undefined = tip;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      oids.push(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') break;
      const info = parseCommitCached(repo, cur, obj.data);
      cur = info.parents[0];
    }
  }
  const { page } = paginate(oids, query);
  return ok(res, 200, page.map((oid) => commitJson(repo, oid)), opts), true;
}

function handleGitRefs(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[], opts: RestOpts): boolean {
  const method = req.method ?? 'GET';
  if (method === 'POST' && tail.length === 0) {
    const parsed = parseBody(opts);
    if (!parsed.ok) return fail(res, 400, 'Invalid JSON body', opts), true;
    const ref = asString(parsed.value.ref);
    const sha = asString(parsed.value.sha);
    if (!ref || !ref.startsWith('refs/') || !sha || !/^[0-9a-f]{40}$/i.test(sha)) {
      return fail(res, 422, 'ref and sha are required', opts), true;
    }
    if (repo.refs.has(ref)) return fail(res, 422, `Reference ${ref} already exists`, opts), true;
    const obj = repo.objects.get(sha);
    if (!obj) return fail(res, 422, `Object ${sha} does not exist`, opts), true;
    repo.refs.set(ref, sha);
    return ok(res, 201, { ref, object: { sha, type: obj.type } }, opts), true;
  }
  if (method === 'GET' && tail.length >= 2 && tail[0] === 'heads') {
    const branch = tail.slice(1).join('/');
    const tip = branchTip(repo, branch);
    if (!tip) return fail(res, 404, 'Not Found', opts), true;
    return ok(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } }, opts), true;
  }
  return fail(res, 404, 'Not Found', opts), true;
}

// ---------------------------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------------------------

/** Read a file or directory entry at a tree; returns null when the path is absent. */
function lookupPath(
  repo: Repo,
  treeOid: string,
  path: string,
): { kind: 'file'; oid: string; size: number } | { kind: 'dir'; oid: string; entries: Array<{ name: string; path: string; oid: string; mode: string }> } | null {
  if (path === '') {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTreeCached(repo, treeOid, obj.data).map((e) => ({
      name: e.name,
      path: e.name,
      oid: e.oid,
      mode: e.mode,
    }));
    return { kind: 'dir', oid: treeOid, entries };
  }
  const flat = flattenTree(repo, treeOid);
  const file = flat.get(path);
  if (file) {
    const obj = repo.objects.get(file.oid);
    return { kind: 'file', oid: file.oid, size: obj?.data.length ?? 0 };
  }
  // A directory: any file under `path/`.
  const prefix = `${path}/`;
  const children = new Map<string, { name: string; path: string; oid: string; mode: string }>();
  const subtrees = new Map<string, string>();
  for (const [p, f] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { name: rest, path: p, oid: f.oid, mode: f.mode });
    } else {
      const dir = rest.slice(0, slash);
      if (!subtrees.has(dir)) subtrees.set(dir, '');
    }
  }
  if (children.size === 0 && subtrees.size === 0) return null;
  // Resolve directory oids by walking the tree.
  const dirOid = (dirName: string): string => {
    const parts = path.split('/').concat(dirName);
    let cur = treeOid;
    for (const part of parts) {
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'tree') return '';
      const entry = parseTreeCached(repo, cur, obj.data).find((e) => e.name === part && e.mode === '40000');
      if (!entry) return '';
      cur = entry.oid;
    }
    return cur;
  };
  const entries: Array<{ name: string; path: string; oid: string; mode: string }> = [];
  for (const [name, entry] of children) entries.push({ ...entry, mode: entry.mode });
  for (const dir of subtrees.keys()) {
    entries.push({ name: dir, path: `${path}/${dir}`, oid: dirOid(dir), mode: '40000' });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { kind: 'dir', oid: '', entries };
}

function handleContents(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  path: string,
  query: URLSearchParams,
  opts: RestOpts,
): boolean {
  const method = req.method ?? 'GET';
  const branch = query.get('ref') ?? repo.defaultBranch;

  if (method === 'GET') {
    const tip = resolveRefToCommit(repo, branch);
    if (!tip) return fail(res, 404, 'Not Found', opts), true;
    const tree = branchTree(repo, branch);
    if (!tree) return fail(res, 404, 'Not Found', opts), true;
    const found = lookupPath(repo, tree, path);
    if (!found) return fail(res, 404, 'Not Found', opts), true;
    if (found.kind === 'file') {
      const obj = repo.objects.get(found.oid);
      const name = path.split('/').pop() ?? path;
      return ok(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: found.size,
        name,
        path,
        content: obj?.data.toString('base64') ?? '',
        sha: found.oid,
      }, opts), true;
    }
    return ok(res, 200, found.entries.map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: e.path,
      sha: e.oid,
      size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
    })), opts), true;
  }

  if (method === 'PUT') {
    const parsed = parseBody(opts);
    if (!parsed.ok) return fail(res, 400, 'Invalid JSON body', opts), true;
    const message = asString(parsed.value.message) ?? 'Update file';
    const contentB64 = asString(parsed.value.content);
    if (!contentB64) return fail(res, 422, 'content is required', opts), true;
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return fail(res, 400, 'content is not valid base64', opts), true;
    }
    const putBranch = asString(parsed.value.branch) ?? repo.defaultBranch;
    const sha = asString(parsed.value.sha);
    let tip = branchTip(repo, putBranch);
    let tree = tip ? branchTree(repo, putBranch) : null;
    const isNewRepo = !tip && repo.refs.size === 0;
    if (!tip && !isNewRepo) {
      // A named branch that does not exist yet starts at the default-branch tip.
      const defaultTip = defaultBranchTip(repo);
      if (defaultTip) {
        tree = branchTree(repo, repo.defaultBranch);
        tip = defaultTip;
      } else {
        return fail(res, 404, 'Not Found', opts), true;
      }
    }
    const flat = tree ? flattenTree(repo, tree) : new Map<string, { oid: string; mode: string }>();
    const existing = flat.get(path);
    if (existing && sha && sha !== existing.oid) {
      return fail(res, 409, 'sha does not match the current file', opts), true;
    }
    if (existing && !sha) {
      return fail(res, 422, 'sha is required to update a file', opts), true;
    }
    const blobOid = putObject(repo, 'blob', content);
    const newTree = setFileInTree(repo, tree, path, blobOid);
    const parents = tip ? [tip] : [];
    const commitOid = makeServerCommit(store, repo, { tree: newTree, parents, message });
    repo.refs.set(`refs/heads/${putBranch}`, commitOid);
    if (isNewRepo) repo.defaultBranch = putBranch;
    const name = path.split('/').pop() ?? path;
    return ok(res, existing ? 200 : 201, {
      content: { name, path, sha: blobOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitOid },
    }, opts), true;
  }

  if (method === 'DELETE') {
    const parsed = parseBody(opts);
    if (!parsed.ok) return fail(res, 400, 'Invalid JSON body', opts), true;
    const message = asString(parsed.value.message) ?? 'Delete file';
    const sha = asString(parsed.value.sha);
    const delBranch = asString(parsed.value.branch) ?? repo.defaultBranch;
    const tip = branchTip(repo, delBranch);
    if (!tip) return fail(res, 404, 'Not Found', opts), true;
    const tree = branchTree(repo, delBranch);
    if (!tree) return fail(res, 404, 'Not Found', opts), true;
    const flat = flattenTree(repo, tree);
    const existing = flat.get(path);
    if (!existing) return fail(res, 404, 'Not Found', opts), true;
    if (sha && sha !== existing.oid) return fail(res, 409, 'sha does not match the current file', opts), true;
    const newTree = setFileInTree(repo, tree, path, null);
    const commitOid = makeServerCommit(store, repo, { tree: newTree, parents: [tip], message });
    repo.refs.set(`refs/heads/${delBranch}`, commitOid);
    return ok(res, 200, { commit: { sha: commitOid }, content: null }, opts), true;
  }

  return fail(res, 404, 'Not Found', opts), true;
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

function handleLabels(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo, opts: RestOpts): boolean {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    return ok(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })), opts), true;
  }
  if (method === 'POST') {
    const parsed = parseBody(opts);
    if (!parsed.ok) return fail(res, 400, 'Invalid JSON body', opts), true;
    const name = asString(parsed.value.name);
    if (!name) return fail(res, 422, 'name is required', opts), true;
    if (repo.labels.has(name)) return fail(res, 422, `Label ${name} already exists`, opts), true;
    const color = asString(parsed.value.color) ?? 'ededed';
    const label = { name, color };
    repo.labels.set(name, label);
    return ok(res, 201, { name, color }, opts), true;
  }
  return fail(res, 404, 'Not Found', opts), true;
}

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

function handleIssues(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
  opts: RestOpts,
): boolean {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'POST') return createIssue(store, res, repo, opts);
    if (method === 'GET') return listIssues(store, res, repo, query, opts);
    return fail(res, 404, 'Not Found', opts), true;
  }
  const number = parseInt(tail[0], 10);
  if (Number.isNaN(number)) return fail(res, 404, 'Not Found', opts), true;
  const issue = repo.issues.get(number);
  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue) return fail(res, 404, 'Not Found', opts), true;
    if (method === 'GET') {
      return ok(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: store.viewer.login } })), opts), true;
    }
    if (method === 'POST') {
      const parsed = parseBody(opts);
      if (!parsed.ok) return fail(res, 400, 'Invalid JSON body', opts), true;
      const body = asString(parsed.value.body);
      if (!body) return fail(res, 422, 'body is required', opts), true;
      const comment = addIssueCommentDomain(store, repo, issue, body);
      return ok(res, 201, { id: comment.id, body: comment.body, user: { login: store.viewer.login } }, opts), true;
    }
    return fail(res, 404, 'Not Found', opts), true;
  }
  if (tail.length === 1) {
    if (!issue) return fail(res, 404, 'Not Found', opts), true;
    if (method === 'GET') return ok(res, 200, issueJson(store, repo, issue), opts), true;
    if (method === 'PATCH') {
      const parsed = parseBody(opts);
      if (!parsed.ok) return fail(res, 400, 'Invalid JSON body', opts), true;
      const state = asString(parsed.value.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = asString(parsed.value.title);
      if (title !== undefined) issue.title = title;
      const body = asString(parsed.value.body);
      if (body !== undefined) issue.body = body;
      return ok(res, 200, issueJson(store, repo, issue), opts), true;
    }
    return fail(res, 404, 'Not Found', opts), true;
  }
  return fail(res, 404, 'Not Found', opts), true;
}

function createIssue(store: Store, res: ServerResponse, repo: Repo, opts: RestOpts): boolean {
  const parsed = parseBody(opts);
  if (!parsed.ok) return fail(res, 400, 'Invalid JSON body', opts), true;
  const title = asString(parsed.value.title);
  if (!title) return fail(res, 422, 'title is required', opts), true;
  const body = asString(parsed.value.body) ?? '';
  const labelNames = Array.isArray(parsed.value.labels) ? parsed.value.labels : [];
  const labels: Array<{ name: string; color: string }> = [];
  for (const raw of labelNames) {
    const name = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? asString((raw as Record<string, unknown>).name) : undefined;
    if (!name) continue;
    const label = repo.labels.get(name);
    if (!label) return fail(res, 422, `Label ${name} does not exist`, opts), true;
    labels.push(label);
  }
  const issue = createIssueDomain(store, repo, title, body, labels);
  return ok(res, 201, issueJson(store, repo, issue), opts), true;
}

function listIssues(store: Store, res: ServerResponse, repo: Repo, query: URLSearchParams, opts: RestOpts): boolean {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((i) => i.state === 'open');
  else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
  issues.sort((a, b) => {
    const d = a.createdSeq - b.createdSeq;
    return direction === 'asc' ? d : -d;
  });
  const { page } = paginate(issues, query);
  return ok(res, 200, page.map((i) => issueJson(store, repo, i)), opts), true;
}

// ---------------------------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
  opts: RestOpts,
): boolean {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'POST') return createPull(store, res, repo, opts);
    if (method === 'GET') return listPulls(store, res, repo, query, opts);
    return fail(res, 404, 'Not Found', opts), true;
  }
  const number = parseInt(tail[0], 10);
  if (Number.isNaN(number)) return fail(res, 404, 'Not Found', opts), true;
  const pull = repo.pulls.get(number);
  if (!pull) return fail(res, 404, 'Not Found', opts), true;
  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') return fail(res, 404, 'Not Found', opts), true;
    return pullFiles(res, repo, pull, opts);
  }
  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') return fail(res, 404, 'Not Found', opts), true;
    return mergePull(store, res, repo, pull, opts);
  }
  if (tail.length === 1 && method === 'GET') {
    return ok(res, 200, pullJson(store, repo, pull), opts), true;
  }
  return fail(res, 404, 'Not Found', opts), true;
}

function createPull(store: Store, res: ServerResponse, repo: Repo, opts: RestOpts): boolean {
  const parsed = parseBody(opts);
  if (!parsed.ok) return fail(res, 400, 'Invalid JSON body', opts), true;
  const title = asString(parsed.value.title);
  const head = asString(parsed.value.head);
  const base = asString(parsed.value.base);
  if (!title || !head || !base) return fail(res, 422, 'title, head and base are required', opts), true;
  const result = createPullDomain(store, repo, title, asString(parsed.value.body) ?? '', head, base);
  if ('error' in result) return fail(res, 422, result.error, opts), true;
  return ok(res, 201, pullJson(store, repo, result.pull), opts), true;
}

function listPulls(store: Store, res: ServerResponse, repo: Repo, query: URLSearchParams, opts: RestOpts): boolean {
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const { page } = paginate(pulls, query);
  return ok(res, 200, page.map((p) => pullJson(store, repo, p)), opts), true;
}

function pullFiles(res: ServerResponse, repo: Repo, pull: Pull, opts: RestOpts): boolean {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return fail(res, 404, 'Not Found', opts), true;
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const changes = diffTrees(repo, baseTree, headTree);
  return ok(res, 200, changes.map((c) => ({
    filename: c.path,
    status: c.status,
    additions: c.additions,
    deletions: c.deletions,
    changes: c.changes,
  })), opts), true;
}

function mergePull(store: Store, res: ServerResponse, repo: Repo, pull: Pull, opts: RestOpts): boolean {
  const parsed = parseBody(opts);
  if (!parsed.ok) return fail(res, 400, 'Invalid JSON body', opts), true;
  const method = (asString(parsed.value.merge_method) ?? 'squash').toUpperCase();
  const result = mergePullRequestDomain(store, repo, pull, method);
  if (!result.ok) {
    if (result.error === 'head or base branch does not exist') return fail(res, 404, 'Not Found', opts), true;
    return fail(res, 405, result.error, opts), true;
  }
  return ok(res, 200, { sha: result.mergeCommitSha, merged: true, message: 'Pull request successfully merged' }, opts), true;
}
