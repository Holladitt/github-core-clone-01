// Lane B MCP surface: JSON-RPC 2.0 over Streamable HTTP at POST /mcp,
// modern 2026-07-28 revision via server/discover (initialize kept as a
// legacy fallback). The six tools are thin adapters over the one ForgeStore,
// so MCP-created resources read back identically over REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeStore, VIEWER_LOGIN } from './store.ts';
import { commentShape, issueShape, pullShape, repoShape } from './shapes.ts';
import { hasValidAuth, isRecord, parseJsonBody, pathnameOf, readBody, sendJson } from './util.ts';

const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// One static definition list: two tools/list answers are byte-for-byte equal.
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(data: unknown): Record<string, unknown> {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export async function handleMcp(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (pathnameOf(req) !== '/mcp') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const raw = await readBody(req);
  const body = parseJsonBody(raw);
  if (body === null || !isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!hasValidAuth(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32000, message: 'Requires authentication' } });
    return true;
  }

  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};
  const protocolHeader = (req.headers['mcp-protocol-version'] as string | undefined) ?? PROTOCOL_VERSION;
  const headers = { 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-session-id': 'forge-b-session' };

  // Notifications carry no id and get no JSON-RPC reply.
  if (id === null && body.method !== undefined && body.method !== null && !('id' in body)) {
    res.writeHead(202, headers);
    res.end();
    return true;
  }

  const reply = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result }, headers);
  };
  const replyError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } }, headers);
  };

  if (method === 'server/discover') {
    reply({
      protocolVersion: PROTOCOL_VERSION,
      supportedVersions: [PROTOCOL_VERSION, '2025-06-18', '2025-03-26'],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'forge-b', version: '1.0' },
    });
    return true;
  }
  if (method === 'initialize') {
    reply({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge-b', version: '1.0' },
    });
    return true;
  }
  if (method === 'ping') {
    reply({});
    return true;
  }
  if (method === 'tools/list') {
    reply({ tools: TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      replyError(-32602, `Unknown tool: ${toolName}`);
      return true;
    }
    const required = ((tool.inputSchema.required as string[]) ?? []).filter((key) => args[key] === undefined);
    if (required.length > 0) {
      reply({ ...toolError(`Missing required argument: ${required.join(', ')}`), isError: true });
      return true;
    }
    const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
    try {
      switch (toolName) {
        case 'create_repo': {
          const created = store.createRepo(
            args.name as string,
            args.private === true,
            typeof args.description === 'string' ? (args.description as string) : '',
          );
          if (!created) {
            reply(toolError('Repository already exists'));
            return true;
          }
          reply(toolResult(repoShape(created, baseUrl)));
          return true;
        }
        case 'get_repo': {
          const repo = store.repo(args.owner as string, args.repo as string);
          if (!repo) {
            reply(toolError('Repository not found'));
            return true;
          }
          reply(toolResult(repoShape(repo, baseUrl)));
          return true;
        }
        case 'create_issue': {
          const repo = store.repo(args.owner as string, args.repo as string);
          if (!repo) {
            reply(toolError('Repository not found'));
            return true;
          }
          const issue = store.createIssue(
            repo,
            args.title as string,
            typeof args.body === 'string' ? (args.body as string) : '',
            [],
          );
          if (!issue) {
            reply(toolError('Could not create issue'));
            return true;
          }
          reply(toolResult(issueShape(repo, issue)));
          return true;
        }
        case 'list_issues': {
          const repo = store.repo(args.owner as string, args.repo as string);
          if (!repo) {
            reply(toolError('Repository not found'));
            return true;
          }
          const state = typeof args.state === 'string' ? args.state : 'open';
          let issues = [...repo.issues.values()];
          if (state !== 'all') issues = issues.filter((i) => i.state === state);
          issues.sort((a, b) => a.number - b.number);
          reply(toolResult({ issues: issues.map((i) => issueShape(repo, i)) }));
          return true;
        }
        case 'create_pull_request': {
          const repo = store.repo(args.owner as string, args.repo as string);
          if (!repo) {
            reply(toolError('Repository not found'));
            return true;
          }
          const pr = store.createPull(
            repo,
            args.title as string,
            typeof args.body === 'string' ? (args.body as string) : '',
            args.head as string,
            args.base as string,
          );
          if (!pr) {
            reply(toolError('head or base branch does not exist'));
            return true;
          }
          reply(toolResult(pullShape(repo, pr)));
          return true;
        }
        case 'merge_pull_request': {
          const repo = store.repo(args.owner as string, args.repo as string);
          if (!repo) {
            reply(toolError('Repository not found'));
            return true;
          }
          const pr = repo.pulls.get(Number(args.pull_number));
          if (!pr) {
            reply(toolError('Pull request not found'));
            return true;
          }
          if (pr.merged) {
            reply(toolResult({ merged: true, sha: pr.mergeCommitSha, message: pr.title }));
            return true;
          }
          const merged = store.squashMerge(repo, pr);
          if (merged === null) {
            reply(toolError('Pull request has a merge conflict'));
            return true;
          }
          reply(toolResult({ merged: true, sha: merged, message: pr.title }));
          return true;
        }
        default:
          replyError(-32602, `Unknown tool: ${toolName}`);
          return true;
      }
    } catch (err) {
      reply(toolError(err instanceof Error ? err.message : 'tool failed'));
      return true;
    }
  }

  replyError(-32601, `Method not found: ${method}`);
  return true;
}

export { VIEWER_LOGIN };
