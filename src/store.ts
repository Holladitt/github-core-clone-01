// Lane B forge store: one canonical in-memory model shared by git, REST,
// GraphQL and MCP. All state is deterministic: fixed timestamps, fixed
// author identity, sequential ids. No Date.now() / Math.random() anywhere.

import {
  buildCommitBytes,
  buildTree,
  collectReachable,
  commitChain,
  hashObject,
  isAncestor,
  isOid,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  treesFromFiles,
  type GitObject,
  type TreeEntry,
} from './gitobjs.ts';
import { ZERO_OID, b64url } from './util.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
/** Fixed timestamp for every server-created commit (determinism). */
export const FIXED_TS = 1700000000;
export const AUTHOR_LINE = `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  databaseId: number;
  createdSeq: number;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextIssue: number;
  nextPr: number;
  nextCommentId: number;
  /** Bumped when any issue of this repo changes (invalidates issue JSON cache). */
  issueVersion: number;
  /** Bumped when the repo's own fields change (invalidates repo JSON cache). */
  repoVersion: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function repoGlobalId(repo: Repo): string {
  return b64url(`repo:${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64url(`issue:${repo.owner}/${repo.name}#${issue.number}`);
}

export function prGlobalId(repo: Repo, pr: PullRequest): string {
  return b64url(`pr:${repo.owner}/${repo.name}#${pr.number}`);
}

export class ForgeStore {
  /** Every git object, keyed by SHA-1. */
  readonly objects = new Map<string, GitObject>();
  /** Repos keyed by `owner/name`. */
  readonly repos = new Map<string, Repo>();
  /**
   * Bumped whenever any object or ref changes. Caches (advertisements,
   * ls-refs answers, fetch packs) are valid only while they hold this value.
   */
  epoch = 0;
  private nextDbId = 5000;
  private nextSeq = 0;
  private nextTreeSeq = 0;

  /** Mark the object/ref world changed (invalidates git caches). */
  touch(): void {
    this.epoch += 1;
  }

  object(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      this.epoch += 1;
    }
    return oid;
  }

  putBlob(data: Buffer): string {
    return this.putObject('blob', data);
  }

  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(repoKey(VIEWER_LOGIN, name))) return null;
    const repo: Repo = {
      owner: VIEWER_LOGIN,
      name,
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      databaseId: this.nextDbId,
      createdSeq: this.nextSeq,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssue: 1,
      nextPr: 1,
      nextCommentId: 1,
      issueVersion: 0,
      repoVersion: 0,
    };
    this.nextDbId += 1;
    this.nextSeq += 1;
    this.repos.set(repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repoKey(repo.owner, repo.name));
    this.epoch += 1;
  }

  // ------------------------------------------------------------ refs

  /** Resolve a ref name (or HEAD) to an oid, or '' when absent. */
  refTarget(repo: Repo, ref: string): string {
    if (ref === 'HEAD') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
    }
    return repo.refs.get(ref) ?? '';
  }

  listRefs(repo: Repo): Array<{ ref: string; oid: string }> {
    const out: Array<{ ref: string; oid: string }> = [];
    for (const [ref, oid] of repo.refs) out.push({ ref, oid });
    out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return out;
  }

  /** Resolve a ref/oid/short name to a commit oid for ?sha= style queries. */
  resolveCommitRef(repo: Repo, ref: string): string {
    if (isOid(ref)) return ref;
    if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
    if (repo.refs.has(`refs/tags/${ref}`)) {
      return this.peelToCommit(repo.refs.get(`refs/tags/${ref}`)!);
    }
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    if (ref === 'HEAD') return this.refTarget(repo, 'HEAD');
    return '';
  }

  /** Follow tag objects down to the commit they point at. */
  peelToCommit(oid: string): string {
    let current = oid;
    for (let i = 0; i < 16; i += 1) {
      const obj = this.objects.get(current);
      if (!obj) return current;
      if (obj.type === 'tag') {
        current = parseTag(obj.data).object;
        continue;
      }
      return current;
    }
    return current;
  }

  // ------------------------------------------------------------ file trees

  /** Flat path -> blob oid map for the tree of a commit. */
  filesAt(commitOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return out;
    const treeOid = parseCommit(obj.data).tree;
    const walk = (tree: string, prefix: string): void => {
      const treeObj = this.objects.get(tree);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const entry of parseTree(treeObj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The blob oid for one path at a commit, or '' when absent. */
  blobAt(commitOid: string, path: string): string {
    return this.filesAt(commitOid).get(path) ?? '';
  }

  /** Commit a new file tree onto a ref; returns the new commit oid. */
  commitFiles(
    repo: Repo,
    ref: string,
    files: ReadonlyMap<string, string>,
    message: string,
  ): string {
    const trees = treesFromFiles(files);
    for (const [oid, bytes] of trees) this.putObject('tree', bytes);
    // treesFromFiles inserts children before their parent, so the root tree
    // oid is the last key.
    const root = [...trees.keys()][trees.size - 1]!;
    const parent = this.refTarget(repo, ref);
    const parents = parent !== '' && isOid(parent) ? [parent] : [];
    const bytes = buildCommitBytes({
      tree: root,
      parents,
      message,
      author: AUTHOR_LINE,
      timestamp: FIXED_TS,
    });
    const commitOid = this.putObject('commit', bytes);
    repo.refs.set(ref, commitOid);
    this.epoch += 1;
    return commitOid;
  }

  /** The tree oid that `filesAt` would produce for a file map. */
  treeOidFor(files: ReadonlyMap<string, string>): string {
    const trees = treesFromFiles(files);
    for (const [oid, bytes] of trees) this.putObject('tree', bytes);
    return [...trees.keys()][trees.size - 1]!;
  }

  /** List commit oids newest-first for a ref. */
  commitsOf(repo: Repo, ref: string): string[] {
    const tip = this.resolveCommitRef(repo, ref);
    if (tip === '' || !isOid(tip)) return [];
    return commitChain(tip, (oid) => this.objects.get(oid));
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | null {
    for (const label of labels) {
      if (!repo.labels.has(label)) return null;
    }
    const issue: Issue = {
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
    };
    repo.nextIssue += 1;
    repo.issues.set(issue.number, issue);
    repo.issueVersion += 1;
    return issue;
  }

  /** Change an issue's state through the store (keeps the JSON cache honest). */
  setIssueState(repo: Repo, issue: Issue, state: 'open' | 'closed'): void {
    if (issue.state !== state) {
      issue.state = state;
      repo.issueVersion += 1;
    }
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: repo.nextCommentId, body };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ pull requests

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | null {
    const headSha = this.refTarget(repo, `refs/heads/${headRef}`);
    const baseSha = this.refTarget(repo, `refs/heads/${baseRef}`);
    if (headSha === '' || baseSha === '') return null;
    const pr: PullRequest = {
      number: repo.nextPr,
      title,
      body,
      headRef,
      headSha,
      baseRef,
      baseSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.nextPr += 1;
    repo.pulls.set(pr.number, pr);
    return pr;
  }

  /** Flat-file diff between two commits: added/modified/removed paths. */
  diffFiles(repo: Repo, fromCommit: string, toCommit: string): Array<{
    path: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
  }> {
    const from = this.filesAt(fromCommit);
    const to = this.filesAt(toCommit);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> = [];
    const countLines = (oid: string): number => {
      const obj = this.objects.get(oid);
      if (!obj) return 0;
      const text = obj.data.toString('utf8');
      if (text === '') return 0;
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines.length;
    };
    const paths = new Set([...from.keys(), ...to.keys()]);
    for (const path of [...paths].sort()) {
      const a = from.get(path);
      const b = to.get(path);
      if (a === b) continue;
      if (a === undefined && b !== undefined) {
        out.push({ path, status: 'added', additions: countLines(b), deletions: 0 });
      } else if (a !== undefined && b === undefined) {
        out.push({ path, status: 'removed', additions: 0, deletions: countLines(a) });
      } else if (a !== undefined && b !== undefined) {
        const add = countLines(b);
        const del = countLines(a);
        out.push({ path, status: 'modified', additions: add, deletions: del });
      }
    }
    return out;
  }

  /** Three-way merge of `head` onto `base`; null when the merge conflicts. */
  threeWay(repo: Repo, baseCommit: string, headCommit: string): Map<string, string> | null {
    const base = mergeBase(baseCommit, headCommit, (oid) => this.objects.get(oid));
    const baseFiles = base === null ? new Map<string, string>() : this.filesAt(base);
    const headFiles = this.filesAt(headCommit);
    const baseBranchFiles = this.filesAt(baseCommit);
    const out = new Map<string, string>(baseBranchFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseBranchFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const t = baseBranchFiles.get(path);
      if (h === b) {
        // Head did not touch this path: keep the base branch version.
        continue;
      }
      if (t === b) {
        // Base branch did not touch it: take the head version (or its deletion).
        if (h === undefined) out.delete(path);
        else out.set(path, h);
        continue;
      }
      if (h === t) continue;
      return null;
    }
    return out;
  }

  /** 'MERGEABLE' | 'CONFLICTING' for a pull request, computed live. */
  mergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    const baseTip = this.refTarget(repo, `refs/heads/${pr.baseRef}`);
    const headTip = this.refTarget(repo, `refs/heads/${pr.headRef}`);
    if (baseTip === '' || headTip === '') return 'CONFLICTING';
    return this.threeWay(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Squash-merge a PR; returns the merge commit oid, or null on conflict. */
  squashMerge(repo: Repo, pr: PullRequest): string | null {
    const baseTip = this.refTarget(repo, `refs/heads/${pr.baseRef}`);
    const headTip = this.refTarget(repo, `refs/heads/${pr.headRef}`);
    if (baseTip === '' || headTip === '') return null;
    const mergedFiles = this.threeWay(repo, baseTip, headTip);
    if (mergedFiles === null) return null;
    const treeOid = this.treeOidFor(mergedFiles);
    const bytes = buildCommitBytes({
      tree: treeOid,
      parents: [baseTip],
      message: pr.title,
      author: AUTHOR_LINE,
      timestamp: FIXED_TS,
    });
    const mergeOid = this.putObject('commit', bytes);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeOid);
    this.epoch += 1;
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = '2025-01-01T00:00:00Z';
    pr.mergeCommitSha = mergeOid;
    return mergeOid;
  }

  // ------------------------------------------------------------ git helpers

  /** Objects the client still needs, with shallow bookkeeping. */
  planFetch(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    shallow: readonly string[],
    depth: number | null,
  ): {
    objects: GitObject[];
    shallowOut: string[];
    unshallowOut: string[];
  } {
    const lookup = (oid: string): GitObject | undefined => this.objects.get(oid);
    // Expand tag roots to their target commits for distance purposes.
    const commitRoots: string[] = [];
    const rootObjects = new Set<string>();
    for (const want of wants) {
      const obj = this.objects.get(want);
      if (!obj) continue;
      if (obj.type === 'tag') {
        rootObjects.add(want);
        const peeled = this.peelToCommit(want);
        if (peeled !== want) commitRoots.push(peeled);
        else commitRoots.push(want);
      } else {
        commitRoots.push(want);
      }
    }
    // Distance from any want commit (0-based). depth N keeps distance < N.
    // Index-headed queue, not shift(): shift() is O(n) per pop.
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = commitRoots.map((oid) => [oid, 0] as [string, number]);
    let qHead = 0;
    while (qHead < queue.length) {
      const [oid, d] = queue[qHead++]!;
      if (dist.has(oid)) continue;
      if (depth !== null && d >= depth) continue;
      dist.set(oid, d);
      const obj = this.objects.get(oid);
      if (obj?.type === 'commit') {
        for (const parent of parseCommit(obj.data).parents) queue.push([parent, d + 1]);
      }
    }
    const included = new Set<string>();
    for (const [oid, d] of dist) {
      void d;
      included.add(oid);
    }
    // Objects the client already holds: reachable from haves, but never
    // across one of the client's shallow boundaries.
    const shallowSet = new Set(shallow);
    const held = new Set<string>();
    {
      const stack = [...haves];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (held.has(oid)) continue;
        const obj = this.objects.get(oid);
        if (!obj) continue;
        held.add(oid);
        if (shallowSet.has(oid)) continue;
        if (obj.type === 'commit') {
          stack.push(parseCommit(obj.data).tree);
          for (const parent of parseCommit(obj.data).parents) stack.push(parent);
        } else if (obj.type === 'tag') {
          stack.push(parseTag(obj.data).object);
        } else if (obj.type === 'tree') {
          for (const entry of parseTree(obj.data)) stack.push(entry.oid);
        }
      }
    }
    // The send set: included commits plus ONLY the trees/blobs of those
    // commits (+ tag roots), minus anything the client already holds. A
    // parent commit outside the depth window must not leak its tree in.
    const exact = new Set<string>();
    for (const oid of rootObjects) exact.add(oid);
    const walkTree = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (exact.has(oid)) continue;
        const obj = this.objects.get(oid);
        if (!obj) continue;
        exact.add(oid);
        if (obj.type === 'tree') {
          for (const entry of parseTree(obj.data)) {
            if (entry.mode !== '160000') stack.push(entry.oid);
          }
        }
      }
    };
    for (const oid of included) {
      exact.add(oid);
      const obj = this.objects.get(oid);
      if (obj?.type === 'commit') walkTree(parseCommit(obj.data).tree);
    }
    const finalSet = new Set<string>();
    for (const oid of exact) if (!held.has(oid)) finalSet.add(oid);

    const objects: GitObject[] = [];
    for (const oid of finalSet) {
      const obj = this.objects.get(oid);
      if (obj) objects.push(obj);
    }
    objects.sort((a, b) => {
      const ao = hashObject(a.type, a.data);
      const bo = hashObject(b.type, b.data);
      return ao < bo ? -1 : ao > bo ? 1 : 0;
    });

    // Shallow bookkeeping for the reply.
    const shallowOut: string[] = [];
    const unshallowOut: string[] = [];
    if (depth !== null) {
      for (const oid of included) {
        const d = dist.get(oid)!;
        const obj = this.objects.get(oid);
        if (obj?.type !== 'commit') continue;
        const parents = parseCommit(obj.data).parents;
        const hasParentIncluded = parents.some((p) => included.has(p));
        if (!hasParentIncluded && d >= 0) shallowOut.push(oid);
      }
      for (const old of shallow) {
        if (included.has(old)) {
          const parents = parseCommit(this.objects.get(old)?.data ?? Buffer.alloc(0)).parents;
          if (parents.some((p) => included.has(p))) unshallowOut.push(old);
        }
      }
    }
    return { objects, shallowOut, unshallowOut };
  }

  /** Apply one ref update from a receive-pack; returns an error string or null. */
  applyRefUpdate(
    repo: Repo,
    ref: string,
    oldOid: string,
    newOid: string,
  ): string | null {
    const current = repo.refs.get(ref) ?? ZERO_OID;
    const isCreate = oldOid === ZERO_OID;
    const isDelete = newOid === ZERO_OID;
    if (isCreate) {
      if (repo.refs.has(ref)) return 'reference already exists';
      if (isDelete) return 'cannot delete a non-existent reference';
      if (!this.objects.has(newOid)) return 'object not found';
      repo.refs.set(ref, newOid);
      this.epoch += 1;
      return null;
    }
    if (current === ZERO_OID) return 'reference does not exist';
    if (current !== oldOid) return 'old value mismatch';
    if (isDelete) {
      repo.refs.delete(ref);
      this.epoch += 1;
      return null;
    }
    if (!this.objects.has(newOid)) return 'object not found';
    const newObj = this.objects.get(newOid)!;
    if (ref.startsWith('refs/heads/') && newObj.type === 'commit') {
      const oldObj = this.objects.get(oldOid);
      if (!oldObj || oldObj.type !== 'commit') return 'invalid old value';
      if (!isAncestor(oldOid, newOid, (oid) => this.objects.get(oid))) {
        return 'non-fast-forward';
      }
    }
    repo.refs.set(ref, newOid);
    this.epoch += 1;
    return null;
  }
}
