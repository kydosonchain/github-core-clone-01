// Shared domain operations used by REST, GraphQL and MCP alike, so the three
// surfaces can never disagree about what an issue, pull request or merge is.

import {
  FIXED_EPOCH,
  branchTip,
  makeServerCommit,
  mergeBase,
  parseCommit,
  threeWayMerge,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export function iso(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString();
}

/** Create an issue (labels already resolved against the repo). */
export function createIssue(store: Store, repo: Repo, title: string, body: string, labels: Label[] = []): Issue {
  repo.numberSeq += 1;
  const issue: Issue = {
    id: store.nextSeq(),
    number: repo.numberSeq,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    createdSeq: store.nextSeq(),
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request; returns an error string when GitHub would refuse it. */
export function createPull(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): { pull: Pull } | { error: string } {
  if (headRef === baseRef) return { error: 'head and base must be different branches' };
  if (!branchTip(repo, headRef) || !branchTip(repo, baseRef)) {
    return { error: 'head or base branch does not exist' };
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef) {
      return { error: `A pull request already exists for head branch ${headRef}` };
    }
  }
  repo.numberSeq += 1;
  const pull: Pull = {
    id: store.nextSeq(),
    number: repo.numberSeq,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: store.nextSeq(),
  };
  repo.pulls.set(pull.number, pull);
  return { pull };
}

/** Append a comment to an issue. */
export function addIssueComment(store: Store, repo: Repo, issue: Issue, body: string): { id: number; body: string } {
  repo.commentSeq += 1;
  const comment = { id: repo.commentSeq, body, createdSeq: store.nextSeq() };
  issue.comments.push(comment);
  return comment;
}

/** The mergeability of a pull request, computed live from the branch tips. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const base = mergeBase(repo, headTip, baseTip);
  if (!base) return 'UNKNOWN';
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const currentTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const merged = threeWayMerge(repo, baseTree, headTree, currentTree);
  return merged.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge (or true-merge) a pull request; returns an error when it cannot merge. */
export function mergePullRequest(
  store: Store,
  repo: Repo,
  pull: Pull,
  method: string,
): { ok: true; mergeCommitSha: string } | { ok: false; error: string } {
  if (pull.state !== 'open' || pull.merged) return { ok: false, error: 'Pull request is not open' };
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return { ok: false, error: 'head or base branch does not exist' };
  const base = mergeBase(repo, headTip, baseTip);
  if (!base) return { ok: false, error: 'No merge base found' };
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const currentTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const merged = threeWayMerge(repo, baseTree, headTree, currentTree);
  if (merged.conflict) return { ok: false, error: `Merge conflict in ${merged.conflictPaths.join(', ')}` };
  const parents = method === 'MERGE' ? [baseTip, headTip] : [baseTip];
  const commitOid = makeServerCommit(store, repo, {
    tree: merged.treeOid,
    parents,
    message: `Merge pull request #${pull.number} from ${pull.headRef}`,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = iso(FIXED_EPOCH + store.commitSeq - 1);
  pull.mergeCommitSha = commitOid;
  return { ok: true, mergeCommitSha: commitOid };
}
