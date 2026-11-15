// MCP (`/mcp`): JSON-RPC 2.0 over streamable HTTP, revision 2026-07-28, with the
// legacy `initialize` handshake as a fallback.
//
// - `server/discover` answers the supported revisions, capabilities and serverInfo.
// - `tools/list` offers exactly six tools, built from one frozen constant, so two
//   calls answer the same list byte for byte.
// - `tools/call` answers with `content` (JSON text) AND `structuredContent` (the
//   same object), acting on the same store as REST.
// - An unknown tool is -32602/-32601 (never HTTP 500); a missing required
//   argument is `isError: true`; a non-JSON body is HTTP 400 with -32700;
//   no Authorization is HTTP 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { branchTip, globalId, type Repo, type Store } from './store.ts';
import {
  createIssue as createIssueDomain,
  createPull as createPullDomain,
  mergePullRequest as mergePullRequestDomain,
} from './domain.ts';
import { sendEmpty, sendJson } from './respond.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner of the repository (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

interface McpOpts {
  authed: boolean;
  body: Buffer;
  requestId: string;
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(payload: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findTool(name: string): (typeof TOOLS)[number] | undefined {
  const normalized = name.split('__').pop()?.toLowerCase() ?? '';
  return TOOLS.find((t) => t.name === name) ?? TOOLS.find((t) => t.name.toLowerCase() === normalized);
}

function loadRepo(store: Store, owner: string, repoName: string): Repo | null {
  if (owner !== store.viewer.login) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function dispatchToolCall(store: Store, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const tool = findTool(name);
  if (!tool) return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null) {
      return { result: toolError(`Missing required argument: ${required}`) };
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : store.viewer.login;
  const repoName = args.repo as string | undefined;

  if (tool.name === 'create_repo') {
    if (owner !== store.viewer.login) return { result: toolError('Cannot create repositories for another owner') };
    const repoNameArg = args.name as string;
    if (store.getRepo(owner, repoNameArg)) return { result: toolError(`Repository ${owner}/${repoNameArg} already exists`) };
    const repo = store.createRepo(owner, repoNameArg, {
      description: typeof args.description === 'string' ? args.description : '',
      private: typeof args.private === 'boolean' ? args.private : false,
    });
    return {
      result: toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      }),
    };
  }

  if (!repoName) return { result: toolError('repo is required') };
  const repo = loadRepo(store, owner, repoName);
  if (!repo) return { result: toolError(`Repository ${owner}/${repoName} not found`) };

  if (tool.name === 'get_repo') {
    return {
      result: toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      }),
    };
  }
  if (tool.name === 'create_issue') {
    const issue = createIssueDomain(store, repo, args.title as string, typeof args.body === 'string' ? args.body : '');
    return {
      result: toolResult({
        id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: 'open',
      }),
    };
  }
  if (tool.name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((i) => i.state === 'open');
    else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
    issues.sort((a, b) => a.createdSeq - b.createdSeq);
    return {
      result: toolResult({
        issues: issues.map((i) => ({
          id: globalId('Issue', `${repo.owner}/${repo.name}#${i.number}`),
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
        })),
      }),
    };
  }
  if (tool.name === 'create_pull_request') {
    const result = createPullDomain(
      store,
      repo,
      args.title as string,
      typeof args.body === 'string' ? args.body : '',
      args.head as string,
      args.base as string,
    );
    if ('error' in result) return { result: toolError(result.error) };
    const pull = result.pull;
    return {
      result: toolResult({
        id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
        number: pull.number,
        title: pull.title,
        state: 'open',
        head: { ref: pull.headRef, sha: branchTip(repo, pull.headRef) ?? '' },
        base: { ref: pull.baseRef, sha: branchTip(repo, pull.baseRef) ?? '' },
      }),
    };
  }
  if (tool.name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.get(number);
    if (!pull) return { result: toolError(`Pull request #${number} not found`) };
    const result = mergePullRequestDomain(store, repo, pull, 'SQUASH');
    if (!result.ok) return { result: toolError(result.error) };
    return {
      result: toolResult({
        number: pull.number,
        merged: true,
        state: 'closed',
        sha: result.mergeCommitSha,
      }),
    };
  }
  return { error: { code: -32601, message: `Unknown tool: ${name}` } };
}

export function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, opts: McpOpts): boolean {
  const method = req.method ?? 'POST';
  const headers = { 'x-github-request-id': opts.requestId };
  if (method === 'DELETE') {
    sendEmpty(res, 204, headers);
    return true;
  }
  if (method === 'GET') {
    sendJson(res, 405, rpcError(null, -32600, 'Method not allowed'), headers);
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, rpcError(null, -32600, 'Method not allowed'), headers);
    return true;
  }
  if (!opts.authed) {
    sendJson(res, 401, rpcError(null, -32000, 'Requires authentication'), headers);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.body.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'), headers);
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'), headers);
    return true;
  }
  const body = parsed as Record<string, unknown>;
  const id = body.id ?? null;
  const hasId = Object.prototype.hasOwnProperty.call(body, 'id') && body.id !== undefined;
  const rpcMethod = body.method;
  if (typeof rpcMethod !== 'string') {
    if (hasId) sendJson(res, 200, rpcError(id, -32600, 'Invalid Request'), headers);
    else sendEmpty(res, 202, headers);
    return true;
  }
  // Notifications (no id) are answered 202 with an empty body.
  if (!hasId) {
    sendEmpty(res, 202, headers);
    return true;
  }
  const params = (body.params ?? {}) as Record<string, unknown>;
  if (rpcMethod === 'server/discover') {
    const info = serverInfo();
    sendJson(res, 200, rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: info,
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    }), headers);
    return true;
  }
  if (rpcMethod === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) || LEGACY_VERSIONS.includes(requested) || /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2025-11-25';
    sendJson(res, 200, rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    }), headers);
    return true;
  }
  if (rpcMethod === 'ping') {
    sendJson(res, 200, rpcResult(id, {}), headers);
    return true;
  }
  if (rpcMethod === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }), headers);
    return true;
  }
  if (rpcMethod === 'tools/call') {
    const callParams = params as Record<string, unknown>;
    const toolName = callParams.name as string | undefined;
    const args = (callParams.arguments ?? {}) as Record<string, unknown>;
    if (typeof toolName !== 'string') {
      sendJson(res, 200, rpcError(id, -32602, 'Tool name is required'), headers);
      return true;
    }
    const outcome = dispatchToolCall(store, toolName, args);
    if (outcome.error) {
      sendJson(res, 200, rpcError(id, outcome.error.code, outcome.error.message), headers);
      return true;
    }
    sendJson(res, 200, rpcResult(id, outcome.result), headers);
    return true;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${rpcMethod}`), headers);
  return true;
}
