// Lane B response shapes: the JSON projections every surface returns for a
// repository, issue, pull request and comment. One place, so REST, GraphQL
// and MCP can never disagree about an id or a field name.

import type { Issue, IssueComment, PullRequest, Repo } from './store.ts';
import { issueGlobalId, prGlobalId, repoGlobalId } from './store.ts';

export function repoShape(repo: Repo, baseUrl: string): Record<string, unknown> {
  const path = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: repo.databaseId,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === 'adaiversen' ? 1000 : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${baseUrl}${path}`,
    url: `${baseUrl}${path}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: 'adaiversen', id: 1000 },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function commentShape(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `${issueGlobalId(repo, issue)}:comment:${comment.id}`,
    body: comment.body,
    user: { login: 'adaiversen', id: 1000 },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function pullShape(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.number,
    node_id: prGlobalId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    user: { login: 'adaiversen', id: 1000 },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function viewerShape(): Record<string, unknown> {
  return {
    login: 'adaiversen',
    id: 1000,
    node_id: 'user:adaiversen',
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
    type: 'User',
  };
}
