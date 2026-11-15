// GraphQL v4 (`/api/graphql`): a hand-written parser and executor for exactly
// the documents `gh` and `github-mcp-server` send, plus `__type` introspection.
//
// The executor validates selections against the schema first: an unknown field
// is HTTP 200 with an errors array naming it (no data). An unknown repository
// is `data.repository = null` with no errors. A JSON array body answers an
// array of results in order. Unauthenticated is exactly 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_EPOCH,
  branchTip,
  diffTrees,
  globalId,
  mergeBase,
  parseCommit,
  parseGlobalId,
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
  pullMergeable,
} from './domain.ts';
import { sendJson } from './respond.ts';

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'Fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'Operation';
  operationType: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; type: string }>;
  selections: SelectionNode[];
}

interface Token {
  kind: 'Name' | 'String' | 'Int' | 'Float' | 'Punct' | 'EOF';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'Punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'Punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const e = input[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          out += map[e] ?? e;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'String', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'Float' : 'Int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j])) j += 1;
      tokens.push({ kind: 'Name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'Punct' || t.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(t.value)}`);
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'Name') throw new Error(`expected a name, got ${JSON.stringify(t.value)}`);
    return t.value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek().kind !== 'EOF') ops.push(this.parseOperation());
    return ops;
  }

  private parseOperation(): OperationNode {
    const t = this.peek();
    if (t.kind === 'Punct' && t.value === '{') {
      return { kind: 'Operation', operationType: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    const kw = this.expectName();
    if (kw !== 'query' && kw !== 'mutation' && kw !== 'subscription') throw new Error(`unexpected keyword ${kw}`);
    let name: string | null = null;
    if (this.peek().kind === 'Name') name = this.next().value;
    const variables = this.parseVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind: 'Operation', operationType: kw, name, variables, selections };
  }

  private parseVariableDefinitions(): Array<{ name: string; type: string }> {
    const defs: Array<{ name: string; type: string }> = [];
    if (this.peek().kind === 'Punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'Punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        if (this.peek().kind === 'Punct' && this.peek().value === '=') {
          this.next();
          this.parseValue();
        }
        defs.push({ name, type });
      }
      this.next();
    }
    return defs;
  }

  private parseType(): string {
    let type: string;
    const t = this.next();
    if (t.kind === 'Punct' && t.value === '[') {
      type = `[${this.parseType()}]`;
    } else if (t.kind === 'Name') {
      type = t.value;
    } else {
      throw new Error('expected a type');
    }
    if (this.peek().kind === 'Punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) sels.push(this.parseSelection());
    this.next();
    return sels;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'Punct' && t.value === '...') {
      this.next();
      const nt = this.peek();
      if (nt.kind === 'Name' && nt.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'Fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (nt.kind === 'Name') {
        this.next(); // a named fragment spread (unused by the suite's documents)
        this.skipDirectives();
        return { kind: 'Fragment', typeCondition: null, selections: [] };
      }
      this.skipDirectives();
      return { kind: 'Fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'Punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'Punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'Field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'Punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'Punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.next();
    }
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'Punct' && t.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (t.kind === 'Punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'List', values };
    }
    if (t.kind === 'Punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'Object', fields };
    }
    if (t.kind === 'String') return { kind: 'String', value: t.value };
    if (t.kind === 'Int') return { kind: 'Int', value: parseInt(t.value, 10) };
    if (t.kind === 'Float') return { kind: 'Float', value: parseFloat(t.value) };
    if (t.kind === 'Name') {
      if (t.value === 'true') return { kind: 'Boolean', value: true };
      if (t.value === 'false') return { kind: 'Boolean', value: false };
      if (t.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t.value)}`);
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'Punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      this.parseArguments();
    }
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((v) => resolveValue(v, variables));
    case 'Object': {
      const o: Record<string, unknown> = {};
      for (const f of node.fields) o[f.name] = resolveValue(f.value, variables);
      return o;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Schema (validation + introspection)
// ---------------------------------------------------------------------------------------------

const SCALARS = new Set(['String', 'Int', 'Boolean', 'ID', 'Float']);

const OBJECT_FIELDS: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Node: { id: 'ID' },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String', url: 'String' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'RepositoryPermission',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
    url: 'String',
  },
  Ref: { name: 'String', target: 'Commit' },
  Commit: { oid: 'String', message: 'String' },
  Issue: {
    id: 'ID',
    databaseId: 'Int',
    number: 'Int',
    title: 'String',
    state: 'IssueState',
    body: 'String',
    createdAt: 'String',
    url: 'String',
    author: 'User',
  },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  PullRequest: {
    id: 'ID',
    databaseId: 'Int',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'PullRequestState',
    merged: 'Boolean',
    headRefName: 'String',
    baseRefName: 'String',
    mergeable: 'MergeableState',
    files: 'PullRequestChangedFileConnection',
    url: 'String',
  },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', url: 'String' },
  __Type: {
    name: 'String',
    kind: 'String',
    description: 'String',
    fields: '[__Field]',
    enumValues: '[__EnumValue]',
    inputFields: '[__InputValue]',
    interfaces: '[__Type]',
    possibleTypes: '[__Type]',
  },
  __Field: { name: 'String', description: 'String', type: '__Type', args: '[__InputValue]' },
  __EnumValue: { name: 'String', description: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '[__Type]' },
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function unwrapType(t: string): string {
  return t.replace(/^\[/, '').replace(/\]$/, '').replace(/!$/, '');
}

function validateSelections(selections: SelectionNode[], typeName: string, errors: string[]): void {
  for (const sel of selections) {
    if (sel.kind === 'Fragment') {
      const t = sel.typeCondition ?? typeName;
      if (sel.typeCondition && !OBJECT_FIELDS[t] && !ENUM_VALUES[t] && !SCALARS.has(t)) {
        errors.push(`Unknown type "${t}".`);
        continue;
      }
      validateSelections(sel.selections, t, errors);
      continue;
    }
    const fields = OBJECT_FIELDS[typeName];
    if (!fields || !(sel.name in fields)) {
      errors.push(`Cannot query field "${sel.name}" on type "${typeName}".`);
      continue;
    }
    if (sel.selections !== null) {
      const inner = unwrapType(fields[sel.name]);
      if (SCALARS.has(inner)) {
        errors.push(`Field "${sel.name}" must not have a selection since type "${inner}" has no subfields.`);
        continue;
      }
      validateSelections(sel.selections, inner, errors);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

interface GqlCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Source = Record<string, unknown>;

function userSource(store: Store, login: string): Source {
  return {
    __typename: 'User',
    id: globalId('User', login),
    login,
    name: login === store.viewer.login ? store.viewer.name : login,
    email: login === store.viewer.login ? store.viewer.email : '',
    url: `https://github.com/${login}`,
  };
}

function repoSource(repo: Repo): Source {
  return { __typename: 'Repository', _repo: repo };
}

function issueSource(repo: Repo, issue: Issue): Source {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullSource(repo: Repo, pull: Pull): Source {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function commentSource(store: Store, repo: Repo, issue: Issue, comment: { id: number; body: string }): Source {
  return {
    __typename: 'IssueComment',
    id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`),
    body: comment.body,
    author: userSource(store, store.viewer.login),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

function typeSource(name: string): Source | null {
  if (OBJECT_FIELDS[name]) {
    const fields = Object.keys(OBJECT_FIELDS[name]).map((f) => ({ __typename: '__Field', name: f, description: null }));
    return { __typename: '__Type', name, kind: 'OBJECT', description: null, fields, enumValues: null, inputFields: null, interfaces: [], possibleTypes: [] };
  }
  if (ENUM_VALUES[name]) {
    const enumValues = ENUM_VALUES[name].map((v) => ({ __typename: '__EnumValue', name: v, description: null }));
    return { __typename: '__Type', name, kind: 'ENUM', description: null, fields: null, enumValues, inputFields: null, interfaces: [], possibleTypes: [] };
  }
  if (SCALARS.has(name)) {
    return { __typename: '__Type', name, kind: 'SCALAR', description: null, fields: null, enumValues: null, inputFields: null, interfaces: [], possibleTypes: [] };
  }
  return null;
}

/** Decode a global id into its repo + kind, or null when it does not resolve here. */
function decodeNodeId(store: Store, id: string): { kind: string; repo: Repo | null; number?: number; commentId?: number } | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  const { kind, payload } = parsed;
  if (kind === 'User') return { kind, repo: null };
  const hash = payload.indexOf('#');
  const repoPart = hash === -1 ? payload : payload.slice(0, hash);
  const slash = repoPart.indexOf('/');
  if (slash === -1) return null;
  const repo = store.getRepo(repoPart.slice(0, slash), repoPart.slice(slash + 1)) ?? null;
  if (hash === -1) return { kind, repo };
  const rest = payload.slice(hash + 1);
  const colon = rest.indexOf(':');
  const number = Number(colon === -1 ? rest : rest.slice(0, colon));
  if (!Number.isInteger(number)) return null;
  const commentId = colon === -1 ? undefined : Number(rest.slice(colon + 1));
  return { kind, repo, number, commentId };
}

function cursorForIssue(issue: Issue): string {
  return Buffer.from(`issue:${issue.number}`, 'utf8').toString('base64');
}

function cursorForPull(pull: Pull): string {
  return Buffer.from(`pull:${pull.number}`, 'utf8').toString('base64');
}

function pageInfoFor(cursors: string[], hasNextPage: boolean): Source {
  return {
    __typename: 'PageInfo',
    hasNextPage,
    hasPreviousPage: false,
    startCursor: cursors.length > 0 ? cursors[0] : null,
    endCursor: cursors.length > 0 ? cursors[cursors.length - 1] : null,
  };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Source {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const after = typeof args.after === 'string' ? args.after : undefined;
  let issues = [...repo.issues.values()];
  if (states) {
    issues = issues.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const dir = orderBy.direction === 'DESC' ? -1 : 1;
  issues.sort((a, b) => {
    let d = a.createdSeq - b.createdSeq;
    if (d === 0) d = a.number - b.number;
    return d * dir;
  });
  if (after) {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    const m = /^issue:(\d+)$/.exec(decoded);
    if (m) {
      const idx = issues.findIndex((i) => i.number === Number(m[1]));
      if (idx >= 0) issues = issues.slice(idx + 1);
    }
  }
  const totalCount = issues.length;
  const page = first !== undefined ? issues.slice(0, first) : issues;
  const hasNextPage = first !== undefined && issues.length > first;
  const nodes = page.map((i) => issueSource(repo, i));
  const edges = page.map((i) => ({ __typename: 'IssueEdge', node: issueSource(repo, i), cursor: cursorForIssue(i) }));
  return {
    __typename: 'IssueConnection',
    nodes,
    edges,
    pageInfo: pageInfoFor(edges.map((e) => e.cursor as string), hasNextPage),
    totalCount,
  };
}

function pullRequestConnection(repo: Repo, args: Record<string, unknown>): Source {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : undefined;
  let pulls = [...repo.pulls.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  if (after) {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    const m = /^pull:(\d+)$/.exec(decoded);
    if (m) {
      const idx = pulls.findIndex((p) => p.number === Number(m[1]));
      if (idx >= 0) pulls = pulls.slice(idx + 1);
    }
  }
  const totalCount = pulls.length;
  const page = first !== undefined ? pulls.slice(0, first) : pulls;
  const hasNextPage = first !== undefined && pulls.length > first;
  const nodes = page.map((p) => pullSource(repo, p));
  const edges = page.map((p) => ({ __typename: 'PullRequestEdge', node: pullSource(repo, p), cursor: cursorForPull(p) }));
  return {
    __typename: 'PullRequestConnection',
    nodes,
    edges,
    pageInfo: pageInfoFor(edges.map((e) => e.cursor as string), hasNextPage),
    totalCount,
  };
}

function filesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): Source {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  let changes: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  if (headTip && baseTip) {
    const base = mergeBase(repo, headTip, baseTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    changes = diffTrees(repo, baseTree, headTree);
  }
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? changes.slice(0, first) : changes;
  const nodes = page.map((c) => ({
    __typename: 'PullRequestChangedFile',
    path: c.path,
    additions: c.additions,
    deletions: c.deletions,
    changeType: c.status.toUpperCase(),
  }));
  const totalCount = changes.length;
  const hasNextPage = first !== undefined && changes.length > first;
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes,
    pageInfo: pageInfoFor([], hasNextPage),
    totalCount,
  };
}

function resolveField(parentType: string, source: Source, fieldName: string, args: Record<string, unknown>, ctx: GqlCtx): unknown {
  const store = ctx.store;
  // `node(id:)` returns the Node interface: resolve its fields against the concrete type.
  if (parentType === 'Node' && typeof source.__typename === 'string') parentType = source.__typename;
  // Plain properties (User, Ref, connections, payloads, PageInfo, introspection) answer directly.
  if (!(parentType === 'Query' || parentType === 'Mutation' || parentType === 'Repository' || parentType === 'Issue' || parentType === 'PullRequest')) {
    return source[fieldName] ?? null;
  }

  if (parentType === 'Query') {
    if (fieldName === 'viewer') return userSource(store, store.viewer.login);
    if (fieldName === 'repository') {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (!owner || !name || owner !== store.viewer.login) return null;
      const repo = store.getRepo(owner, name);
      return repo ? repoSource(repo) : null;
    }
    if (fieldName === 'node') {
      const decoded = decodeNodeId(store, String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'User') return userSource(store, store.viewer.login);
      if (!decoded.repo) return null;
      if (decoded.kind === 'Repository') return repoSource(decoded.repo);
      if (decoded.kind === 'Issue' && decoded.number !== undefined) {
        const issue = decoded.repo.issues.get(decoded.number);
        return issue ? issueSource(decoded.repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest' && decoded.number !== undefined) {
        const pull = decoded.repo.pulls.get(decoded.number);
        return pull ? pullSource(decoded.repo, pull) : null;
      }
      if (decoded.kind === 'IssueComment' && decoded.number !== undefined && decoded.commentId !== undefined) {
        const issue = decoded.repo.issues.get(decoded.number);
        const comment = issue?.comments.find((c) => c.id === decoded.commentId);
        return issue && comment ? commentSource(store, decoded.repo, issue, comment) : null;
      }
      return null;
    }
    if (fieldName === '__type') {
      return typeof args.name === 'string' ? typeSource(args.name) : null;
    }
    if (fieldName === '__schema') {
      return {
        __typename: '__Schema',
        queryType: typeSource('Query'),
        mutationType: typeSource('Mutation'),
        types: Object.keys(OBJECT_FIELDS).map((n) => typeSource(n)).filter(Boolean),
      };
    }
    return null;
  }

  if (parentType === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (fieldName === 'createIssue') {
      const decoded = decodeNodeId(store, String(input.repositoryId ?? ''));
      if (!decoded || !decoded.repo) {
        ctx.errors.push({ message: 'createIssue: unknown repository' });
        return undefined;
      }
      const title = input.title as string | undefined;
      if (!title) {
        ctx.errors.push({ message: 'createIssue: title is required' });
        return undefined;
      }
      const issue = createIssueDomain(store, decoded.repo, title, (input.body as string | undefined) ?? '');
      return { __typename: 'CreateIssuePayload', issue: issueSource(decoded.repo, issue), clientMutationId: input.clientMutationId ?? null };
    }
    if (fieldName === 'closeIssue') {
      const decoded = decodeNodeId(store, String(input.issueId ?? ''));
      const issue = decoded?.repo && decoded.number !== undefined ? decoded.repo.issues.get(decoded.number) : undefined;
      if (!issue) {
        ctx.errors.push({ message: 'closeIssue: unknown issue' });
        return undefined;
      }
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueSource(decoded.repo!, issue), clientMutationId: input.clientMutationId ?? null };
    }
    if (fieldName === 'createPullRequest') {
      const decoded = decodeNodeId(store, String(input.repositoryId ?? ''));
      if (!decoded || !decoded.repo) {
        ctx.errors.push({ message: 'createPullRequest: unknown repository' });
        return undefined;
      }
      const result = createPullDomain(
        store,
        decoded.repo,
        (input.title as string | undefined) ?? '',
        (input.body as string | undefined) ?? '',
        (input.headRefName as string | undefined) ?? '',
        (input.baseRefName as string | undefined) ?? '',
      );
      if ('error' in result) {
        ctx.errors.push({ message: `createPullRequest: ${result.error}` });
        return undefined;
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(decoded.repo, result.pull), clientMutationId: input.clientMutationId ?? null };
    }
    if (fieldName === 'mergePullRequest') {
      const decoded = decodeNodeId(store, String(input.pullRequestId ?? ''));
      const pull = decoded?.repo && decoded.number !== undefined ? decoded.repo.pulls.get(decoded.number) : undefined;
      if (!pull || !decoded?.repo) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
        return undefined;
      }
      const method = (input.mergeMethod as string | undefined) ?? 'SQUASH';
      const result = mergePullRequestDomain(store, decoded.repo, pull, method);
      if (!result.ok) {
        ctx.errors.push({ message: `mergePullRequest: ${result.error}` });
        return undefined;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(decoded.repo, pull), clientMutationId: input.clientMutationId ?? null };
    }
    if (fieldName === 'addComment') {
      const decoded = decodeNodeId(store, String(input.subjectId ?? ''));
      const issue = decoded?.repo && decoded.number !== undefined ? decoded.repo.issues.get(decoded.number) : undefined;
      if (!issue || !decoded?.repo) {
        ctx.errors.push({ message: 'addComment: unknown subject' });
        return undefined;
      }
      const body = input.body as string | undefined;
      if (!body) {
        ctx.errors.push({ message: 'addComment: body is required' });
        return undefined;
      }
      const comment = addIssueCommentDomain(store, decoded.repo, issue, body);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: commentSource(store, decoded.repo, issue, comment), cursor: Buffer.from(`comment:${comment.id}`).toString('base64') },
        clientMutationId: input.clientMutationId ?? null,
      };
    }
    return null;
  }

  if (parentType === 'Repository') {
    const repo = source._repo as Repo;
    switch (fieldName) {
      case 'id':
        return globalId('Repository', `${repo.owner}/${repo.name}`);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return userSource(store, repo.owner);
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.defaultBranch);
        return tip ? { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: tip, message: '' } } : null;
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = args.number as number | undefined;
        const issue = number !== undefined ? repo.issues.get(number) : undefined;
        return issue ? issueSource(repo, issue) : null;
      }
      case 'issues':
        return issueConnection(repo, args);
      case 'pullRequests':
        return pullRequestConnection(repo, args);
      case 'pullRequest': {
        const number = args.number as number | undefined;
        const pull = number !== undefined ? repo.pulls.get(number) : undefined;
        return pull ? pullSource(repo, pull) : null;
      }
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}`;
      default:
        return source[fieldName] ?? null;
    }
  }

  if (parentType === 'Issue') {
    const repo = source._repo as Repo;
    const issue = source._issue as Issue;
    switch (fieldName) {
      case 'id':
        return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
      case 'databaseId':
        return issue.id;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return issue.body;
      case 'createdAt':
        return new Date(FIXED_EPOCH * 1000).toISOString();
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'author':
        return userSource(store, store.viewer.login);
      default:
        return source[fieldName] ?? null;
    }
  }

  if (parentType === 'PullRequest') {
    const repo = source._repo as Repo;
    const pull = source._pull as Pull;
    switch (fieldName) {
      case 'id':
        return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
      case 'databaseId':
        return pull.id;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return pullMergeable(repo, pull);
      case 'files':
        return filesConnection(repo, pull, args);
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      default:
        return source[fieldName] ?? null;
    }
  }

  return source[fieldName] ?? null;
}

function executeSelections(selections: SelectionNode[], parentType: string, source: Source, ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'Fragment') {
      if (sel.typeCondition && source.__typename !== sel.typeCondition) continue;
      const sub = executeSelections(sel.selections, sel.typeCondition ?? parentType, source, ctx);
      Object.assign(out, sub);
      continue;
    }
    const key = sel.alias ?? sel.name;
    const args: Record<string, unknown> = {};
    for (const a of sel.args) args[a.name] = resolveValue(a.value, ctx.variables);
    const value = resolveField(parentType, source, sel.name, args, ctx);
    if (value === undefined) {
      out[key] = null;
      continue;
    }
    if (sel.selections === null) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const inner = unwrapType(OBJECT_FIELDS[parentType]?.[sel.name] ?? 'String');
      out[key] = value.map((item) => (item === null || typeof item !== 'object' ? null : executeSelections(sel.selections!, inner, item as Source, ctx)));
    } else if (value !== null && typeof value === 'object') {
      const inner = unwrapType(OBJECT_FIELDS[parentType]?.[sel.name] ?? 'String');
      out[key] = executeSelections(sel.selections, inner, value as Source, ctx);
    } else {
      out[key] = null;
    }
  }
  return out;
}

function executeOperation(store: Store, op: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: GqlCtx = { store, variables, errors: [] };
  const rootType = op.operationType === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: string[] = [];
  validateSelections(op.selections, rootType, validationErrors);
  if (validationErrors.length > 0) {
    return { errors: validationErrors.map((m) => ({ message: m })) };
  }
  const rootSource: Source = { __typename: rootType };
  const data = executeSelections(op.selections, rootType, rootSource, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

function executeEntry(store: Store, entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { errors: [{ message: 'Invalid GraphQL request' }] };
  }
  const { query, variables, operationName } = entry as Record<string, unknown>;
  if (typeof query !== 'string') return { errors: [{ message: 'query is required' }] };
  const vars = variables && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
  let ops: OperationNode[];
  try {
    ops = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: `Syntax error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  let op: OperationNode | undefined;
  if (typeof operationName === 'string') op = ops.find((o) => o.name === operationName);
  else if (ops.length === 1) op = ops[0];
  if (!op) return { errors: [{ message: 'Unknown operation' }] };
  return executeOperation(store, op, vars);
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export interface GraphqlOpts {
  authed: boolean;
  body: Buffer;
  requestId: string;
}

export function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse, opts: GraphqlOpts): boolean {
  const headers = { 'x-github-request-id': opts.requestId };
  if ((req.method ?? 'POST') !== 'POST') {
    sendJson(res, 405, { errors: [{ message: 'Method not allowed' }] }, headers);
    return true;
  }
  if (!opts.authed) {
    sendJson(res, 401, { errors: [{ message: 'Requires authentication' }] }, headers);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] }, headers);
    return true;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => executeEntry(store, entry)), headers);
    return true;
  }
  sendJson(res, 200, executeEntry(store, parsed), headers);
  return true;
}
