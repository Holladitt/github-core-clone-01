// Lane B REST v3 surface: /api/v3 root, meta, user, repos, contents,
// git refs, labels, issues, pull requests. All reads come from the one
// ForgeStore, so REST, GraphQL and MCP can never disagree.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeStore, VIEWER_LOGIN, type Repo } from './store.ts';
import { mergeBase, parseCommit, parseTree } from './gitobjs.ts';
import { commentShape, issueShape, pullShape, repoShape, viewerShape } from './shapes.ts';
import {
  asInt,
  hasValidAuth,
  isRecord,
  nextRequestId,
  parseJsonBody,
  pathSegments,
  pathnameOf,
  queryOf,
  readBody,
  sendBytes,
  sendJson,
  sendNotFound,
  sendUnauthorized,
  JSON_TYPE,
} from './util.ts';

/**
 * Serialized-JSON caches for the two hottest reads (the read workload GETs
 * one issue 2,000 times). Keys carry the repo's version counter, so any
 * mutation makes the old entry unreachable instead of stale.
 */
const issueJsonCache = new Map<string, Buffer>();
const repoJsonCache = new Map<string, Buffer>();

function cachedIssueJson(repo: Repo, issue: Parameters<typeof issueShape>[1]): Buffer {
  const key = `${repo.owner}/${repo.name}#${issue.number}@${repo.issueVersion}`;
  const hit = issueJsonCache.get(key);
  if (hit) return hit;
  const body = Buffer.from(`${JSON.stringify(issueShape(repo, issue))}\n`, 'utf8');
  if (issueJsonCache.size > 4096) issueJsonCache.clear();
  issueJsonCache.set(key, body);
  return body;
}

function cachedRepoJson(repo: Repo, baseUrl: string): Buffer {
  const key = `${repo.owner}/${repo.name}@${repo.repoVersion}@${baseUrl}`;
  const hit = repoJsonCache.get(key);
  if (hit) return hit;
  const body = Buffer.from(`${JSON.stringify(repoShape(repo, baseUrl))}\n`, 'utf8');
  if (repoJsonCache.size > 1024) repoJsonCache.clear();
  repoJsonCache.set(key, body);
  return body;
}

function send204(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function scopes(res: ServerResponse, status: number, body: unknown): void {
  sendJson(res, status, body, { 'x-oauth-scopes': 'repo, read:org' });
}

/** Paginate a list; returns the page slice and a Link header when more pages exist. */
function pageOf<T>(items: readonly T[], query: Map<string, string>): { page: T[]; link: string | null; total: number } {
  const perPage = Math.max(1, Math.min(100, asInt(query.get('per_page'), 30)));
  const pageNum = Math.max(1, asInt(query.get('page'), 1));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const total = items.length;
  const link = start + perPage < total ? `page=${pageNum + 1}` : null;
  return { page, link, total };
}

function linkHeader(req: IncomingMessage, query: Map<string, string>, nextPage: string | null): Record<string, string> {
  if (!nextPage) return {};
  const base = `http://${req.headers.host ?? 'localhost'}${pathnameOf(req)}`;
  const perPage = query.get('per_page') ?? '30';
  return { link: `<${base}?per_page=${perPage}&${nextPage}>; rel="next"` };
}

function repoOr404(store: ForgeStore, res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = store.repo(owner, name);
  if (!repo) {
    sendNotFound(res, 'Repository not found');
    return null;
  }
  return repo;
}

/** The tree oid of a directory inside a commit ('' for the root tree itself). */
function treeOidAt(store: ForgeStore, commitOid: string, path: string): string {
  const obj = store.object(commitOid);
  if (!obj || obj.type !== 'commit') return '';
  let current = parseCommit(obj.data).tree;
  if (path === '') return current;
  for (const segment of path.split('/')) {
    const tree = store.object(current);
    if (!tree || tree.type !== 'tree') return '';
    const entry = parseTree(tree.data).find((e) => e.name === segment && e.mode === '40000');
    if (!entry) return '';
    current = entry.oid;
  }
  return current;
}

export async function handleRest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const pathname = pathnameOf(req);
  if (!pathname.startsWith('/api/v3')) return false;
  const segments = pathSegments(pathname);
  // segments[0] is 'api', segments[1] is 'v3'.
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';
  const query = queryOf(req.url ?? '');

  // API root: public, carries the OAuth scopes header.
  if (rest.length === 0) {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    scopes(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      meta: '/api/v3/meta',
    });
    return true;
  }

  if (!hasValidAuth(req)) {
    sendUnauthorized(res);
    return true;
  }

  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: 'forge-b 1.0' });
    return true;
  }

  if (rest[0] === 'user') {
    if (rest.length === 1 && method === 'GET') {
      sendJson(res, 200, viewerShape());
      return true;
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'POST') {
        const body = parseJsonBody(await readBody(req));
        if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
          sendJson(res, 400, { message: 'name is required' });
          return true;
        }
        const name = body.name as string;
        const isPrivate = body.private === true;
        const description = typeof body.description === 'string' ? body.description : '';
        const created = store.createRepo(name, isPrivate, description);
        if (!created) {
          sendJson(res, 422, { message: 'Repository already exists' });
          return true;
        }
        const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
        sendJson(res, 201, repoShape(created, baseUrl));
        return true;
      }
      if (method === 'GET') {
        const repos = store.viewerRepos();
        const { page, link } = pageOf(repos, query);
        const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
        sendJson(res, 200, page.map((r) => repoShape(r, baseUrl)), linkHeader(req, query, link));
        return true;
      }
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (rest[0] !== 'repos' || rest.length < 3) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const owner = rest[1]!;
  const name = rest[2]!;
  const repo = repoOr404(store, res, owner, name);
  if (!repo) return true;
  const tail = rest.slice(3);
  const baseUrl = `http://${req.headers.host ?? 'localhost'}`;

  // GET / PATCH / DELETE /api/v3/repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendBytes(res, 200, cachedRepoJson(repo, baseUrl), JSON_TYPE);
      return true;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(await readBody(req));
      if (isRecord(body) && typeof body.description === 'string') {
        repo.description = body.description;
        repo.repoVersion += 1;
      }
      sendJson(res, 200, repoShape(repo, baseUrl));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      send204(res);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Branches.
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = store
        .listRefs(repo)
        .filter((r) => r.ref.startsWith('refs/heads/'))
        .map((r) => ({ name: r.ref.slice('refs/heads/'.length), commit: { sha: r.oid } }));
      sendJson(res, 200, branches);
      return true;
    }
    if (tail.length === 2 && method === 'GET') {
      const oid = store.refTarget(repo, `refs/heads/${tail[1]}`);
      if (oid === '') {
        sendNotFound(res, 'Branch not found');
        return true;
      }
      sendJson(res, 200, { name: tail[1], commit: { sha: oid } });
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Commits.
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const commits = store.commitsOf(repo, ref);
    sendJson(
      res,
      200,
      commits.map((sha) => {
        const obj = store.object(sha)!;
        const view = parseCommit(obj.data);
        return { sha, commit: { message: view.message, author: { name: VIEWER_LOGIN }, committer: { name: VIEWER_LOGIN } } };
      }),
    );
    return true;
  }

  // Contents.
  if (tail[0] === 'contents') {
    const filePath = tail.slice(1).join('/');
    const refParam = query.get('ref');
    if (method === 'GET') {
      const ref = refParam ?? repo.defaultBranch;
      const tip = store.resolveCommitRef(repo, ref);
      if (tip === '') {
        sendNotFound(res, 'Not Found');
        return true;
      }
      const blobOid = store.blobAt(tip, filePath);
      if (blobOid !== '') {
        const blob = store.object(blobOid)!;
        const baseName = filePath.split('/').pop() ?? filePath;
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: baseName,
          path: filePath,
          sha: blobOid,
          content: blob.data.toString('base64'),
        });
        return true;
      }
      const treeOid = treeOidAt(store, tip, filePath);
      if (treeOid === '') {
        sendNotFound(res, 'Not Found');
        return true;
      }
      const tree = store.object(treeOid)!;
      const entries = parseTree(tree.data).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
        sha: entry.oid,
      }));
      sendJson(res, 200, entries);
      return true;
    }
    if (method === 'PUT' || method === 'DELETE') {
      const body = parseJsonBody(await readBody(req));
      if (!isRecord(body)) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return true;
      }
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const ref = `refs/heads/${branch}`;
      const tip = store.refTarget(repo, ref);
      const files = tip === '' ? new Map<string, string>() : store.filesAt(tip);
      const currentBlob = files.get(filePath);
      if (method === 'DELETE') {
        if (currentBlob === undefined) {
          sendNotFound(res, 'Not Found');
          return true;
        }
        if (typeof body.sha === 'string' && body.sha !== currentBlob) {
          sendJson(res, 409, { message: 'sha does not match' });
          return true;
        }
        files.delete(filePath);
        const commitSha = store.commitFiles(repo, ref, files, typeof body.message === 'string' ? body.message : 'delete file');
        sendJson(res, 200, { commit: { sha: commitSha } });
        return true;
      }
      // PUT: create or update a file.
      if (typeof body.content !== 'string') {
        sendJson(res, 400, { message: 'content is required' });
        return true;
      }
      const contentBytes = Buffer.from(body.content, 'base64');
      const contentSha = store.putBlob(contentBytes);
      const existed = currentBlob !== undefined;
      if (existed && typeof body.sha === 'string' && body.sha !== currentBlob) {
        sendJson(res, 409, { message: 'sha does not match' });
        return true;
      }
      if (existed && typeof body.sha !== 'string') {
        sendJson(res, 422, { message: 'File already exists' });
        return true;
      }
      if (!existed && typeof body.sha === 'string') {
        sendJson(res, 409, { message: 'sha does not match' });
        return true;
      }
      files.set(filePath, contentSha);
      const commitSha = store.commitFiles(repo, ref, files, typeof body.message === 'string' ? body.message : 'update file');
      sendJson(res, existed ? 200 : 201, {
        content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: contentSha, size: contentBytes.length, encoding: 'base64' },
        commit: { sha: commitSha },
      });
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Git refs.
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
        sendJson(res, 400, { message: 'ref and sha are required' });
        return true;
      }
      const ref = body.ref as string;
      const sha = body.sha as string;
      if (!store.object(sha)) {
        sendJson(res, 422, { message: 'Object does not exist' });
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return true;
      }
      repo.refs.set(ref, sha);
      store.touch();
      sendJson(res, 201, { ref, object: { sha } });
      return true;
    }
    if (tail.length >= 3 && method === 'GET') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const oid = store.refTarget(repo, ref);
      if (oid === '') {
        sendNotFound(res, 'Reference not found');
        return true;
      }
      sendJson(res, 200, { ref, object: { sha: oid } });
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Labels.
  if (tail[0] === 'labels') {
    if (tail.length === 1 && method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (!isRecord(body) || typeof body.name !== 'string') {
        sendJson(res, 400, { message: 'name is required' });
        return true;
      }
      const label = { name: body.name as string, color: typeof body.color === 'string' ? (body.color as string) : '000000' };
      repo.labels.set(label.name, label);
      sendJson(res, 201, label);
      return true;
    }
    if (tail.length === 1 && method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()]);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Issues.
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = parseJsonBody(await readBody(req));
        if (!isRecord(body) || typeof body.title !== 'string') {
          sendJson(res, 400, { message: 'title is required' });
          return true;
        }
        const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l) => typeof l === 'string') as string[] : [];
        const issue = store.createIssue(repo, body.title as string, typeof body.body === 'string' ? (body.body as string) : '', labels);
        if (!issue) {
          sendJson(res, 422, { message: 'Unknown label' });
          return true;
        }
        sendJson(res, 201, issueShape(repo, issue));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        const sort = query.get('sort');
        const direction = query.get('direction') ?? 'desc';
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        } else {
          issues.sort((a, b) => b.number - a.number);
        }
        const { page, link } = pageOf(issues, query);
        sendJson(res, 200, page.map((i) => issueShape(repo, i)), linkHeader(req, query, link));
        return true;
      }
    }
    const issueNumber = asInt(tail[1], Number.NaN);
    const issue = repo.issues.get(issueNumber);
    if (tail.length === 2) {
      if (!issue) {
        sendNotFound(res, 'Issue not found');
        return true;
      }
      if (method === 'GET') {
        sendBytes(res, 200, cachedIssueJson(repo, issue), JSON_TYPE);
        return true;
      }
      if (method === 'PATCH') {
        const body = parseJsonBody(await readBody(req));
        if (isRecord(body)) {
          if (body.state === 'open' || body.state === 'closed') {
            store.setIssueState(repo, issue, body.state);
          }
          if (typeof body.title === 'string' && body.title !== issue.title) {
            issue.title = body.title;
            repo.issueVersion += 1;
          }
          if (typeof body.body === 'string' && body.body !== issue.body) {
            issue.body = body.body;
            repo.issueVersion += 1;
          }
        }
        sendJson(res, 200, issueShape(repo, issue));
        return true;
      }
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (!issue) {
        sendNotFound(res, 'Issue not found');
        return true;
      }
      if (method === 'POST') {
        const body = parseJsonBody(await readBody(req));
        if (!isRecord(body) || typeof body.body !== 'string') {
          sendJson(res, 400, { message: 'body is required' });
          return true;
        }
        const comment = store.addComment(repo, issue, body.body as string);
        sendJson(res, 201, commentShape(repo, issue, comment));
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => commentShape(repo, issue, c)));
        return true;
      }
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Pull requests.
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = parseJsonBody(await readBody(req));
        if (!isRecord(body) || typeof body.head !== 'string' || typeof body.base !== 'string') {
          sendJson(res, 400, { message: 'head and base are required' });
          return true;
        }
        const pr = store.createPull(
          repo,
          typeof body.title === 'string' ? (body.title as string) : '',
          typeof body.body === 'string' ? (body.body as string) : '',
          body.head as string,
          body.base as string,
        );
        if (!pr) {
          sendJson(res, 422, { message: 'head or base branch does not exist' });
          return true;
        }
        sendJson(res, 201, pullShape(repo, pr));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => a.number - b.number);
        const { page, link } = pageOf(pulls, query);
        sendJson(res, 200, page.map((p) => pullShape(repo, p)), linkHeader(req, query, link));
        return true;
      }
    }
    const prNumber = asInt(tail[1], Number.NaN);
    const pr = repo.pulls.get(prNumber);
    if (tail.length === 2) {
      if (!pr) {
        sendNotFound(res, 'Pull request not found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullShape(repo, pr));
        return true;
      }
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (!pr) {
        sendNotFound(res, 'Pull request not found');
        return true;
      }
      const baseTip = store.refTarget(repo, `refs/heads/${pr.baseRef}`);
      const headTip = store.refTarget(repo, `refs/heads/${pr.headRef}`);
      const base = mergeBase(headTip, baseTip, (oid) => store.object(oid)) ?? pr.baseSha;
      const files = store.diffFiles(repo, base, headTip);
      sendJson(
        res,
        200,
        files.map((f) => ({
          filename: f.path,
          status: f.status === 'removed' ? 'modified' : f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.additions + f.deletions,
        })),
      );
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (!pr) {
        sendNotFound(res, 'Pull request not found');
        return true;
      }
      if (pr.merged) {
        sendJson(res, 200, { merged: true, sha: pr.mergeCommitSha, message: pr.title });
        return true;
      }
      const merged = store.squashMerge(repo, pr);
      if (merged === null) {
        sendJson(res, 405, { message: 'Pull request has a merge conflict' });
        return true;
      }
      sendJson(res, 200, { merged: true, sha: merged, message: pr.title });
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}
