// Lane B GraphQL v4 surface: a small hand-written parser and executor for
// the document subset the conformance suite sends (variables, aliases,
// inline fragments, batched documents, __type introspection). Introspection
// answers are built once at module load and reused for every request.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { mergeBase } from './gitobjs.ts';
import { ForgeStore, VIEWER_LOGIN, issueGlobalId, prGlobalId, repoGlobalId, type Issue, type PullRequest, type Repo } from './store.ts';
import {
  b64url,
  hasValidAuth,
  isRecord,
  parseJsonBody,
  pathnameOf,
  readBody,
  sendJson,
  sendUnauthorized,
  unb64url,
} from './util.ts';

// ------------------------------------------------------------ tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      let out = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else out += esc;
          i += 2;
        } else {
          out += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const start = i;
      if (c === '-') i += 1;
      while (i < source.length && /[0-9]/.test(source[i]!)) i += 1;
      let isFloat = false;
      if (source[i] === '.') {
        isFloat = true;
        i += 1;
        while (i < source.length && /[0-9]/.test(source[i]!)) i += 1;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        i += 1;
        if (source[i] === '+' || source[i] === '-') i += 1;
        while (i < source.length && /[0-9]/.test(source[i]!)) i += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(start, i) });
      continue;
    }
    if (isNameStart(c)) {
      const start = i;
      while (i < source.length && isNameChar(source[i]!)) i += 1;
      tokens.push({ kind: 'name', value: source.slice(start, i) });
      continue;
    }
    if ('{}()[]:!=$&|@.'.includes(c)) {
      if (c === '.' && source.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------ AST + parser

export type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string | null;
  typeCondition: string | null;
  selections: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected '${value}' in GraphQL document`);
    }
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name${value ? ` ${value}` : ''} in GraphQL document`);
    }
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipVariableDefinitions();
        operations.push({ operation, name, selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelections();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selections });
        continue;
      }
      throw new Error('unexpected token in GraphQL document');
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    // '(' ... ')' with nested brackets; contents are not needed for execution.
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'punct' && this.peek().value === '...') {
        this.next();
        const next = this.peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          out.push({ kind: 'fragment', name: null, typeCondition, selections: this.parseSelections() });
        } else if (next.kind === 'name') {
          out.push({ kind: 'fragment', name: this.next().value as string, typeCondition: null, selections: [] });
        } else {
          throw new Error('bad fragment spread in GraphQL document');
        }
        continue;
      }
      out.push(this.parseField());
    }
    this.expectPunct('}');
    return out;
  }

  private parseField(): FieldNode {
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    // Directives (e.g. @include) are accepted and ignored.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelections();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ------------------------------------------------------------ introspection (cached)

interface TypeDef {
  kind: string;
  fields: string[];
  enumValues?: string[];
}

const TYPE_DEFS: Readonly<Record<string, TypeDef>> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name'] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body'] },
};

const INTROSPECTION_CACHE = new Map<string, Record<string, unknown>>();
function introspectionType(name: string): Record<string, unknown> | null {
  const cached = INTROSPECTION_CACHE.get(name);
  if (cached) return cached;
  const def = TYPE_DEFS[name];
  if (!def) return null;
  const out: Record<string, unknown> = {
    name,
    kind: def.kind,
    description: null,
    fields:
      def.kind === 'OBJECT'
        ? def.fields.map((field) => ({ name: field, description: null, args: [] }))
        : null,
    enumValues:
      def.kind === 'ENUM'
        ? (def.enumValues ?? []).map((value) => ({ name: value, description: null }))
        : null,
  };
  INTROSPECTION_CACHE.set(name, out);
  return out;
}

// ------------------------------------------------------------ executor

class GqlError extends Error {}

interface GqlValue {
  __type: string;
  __value: unknown;
}

function wrap(type: string, value: unknown): GqlValue {
  return { __type: type, __value: value };
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name] ?? null;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.fields)) out[key] = valueOf(child, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) out[key] = valueOf(node, variables);
  return out;
}

function cursorFor(number: number): string {
  return b64url(`cursor:${number}`);
}

function cursorNumber(after: unknown): number | null {
  if (typeof after !== 'string' || after === '') return null;
  const decoded = unb64url(after);
  if (!decoded || !decoded.startsWith('cursor:')) return null;
  const n = Number.parseInt(decoded.slice('cursor:'.length), 10);
  return Number.isFinite(n) ? n : null;
}

interface Ctx {
  store: ForgeStore;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
}

function resolveSelections(
  ctx: Ctx,
  typeName: string,
  value: unknown,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const fragment = selection.name !== null ? ctx.fragments.get(selection.name) : null;
      const sub = fragment ? fragment.selections : selection.selections;
      if (fragment && fragment.typeCondition !== null && fragment.typeCondition !== typeName) continue;
      Object.assign(out, resolveSelections(ctx, typeName, value, sub));
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(ctx, typeName, value, selection);
  }
  return out;
}

function resolveField(ctx: Ctx, typeName: string, value: unknown, field: FieldNode): unknown {
  const { store } = ctx;
  const args = argsOf(field, ctx.variables);
  const name = field.name;

  if (name === '__typename') return typeName;

  if (typeName === 'Query') {
    if (name === '__type') {
      const typeNameArg = args.name as string;
      return introspectionType(typeNameArg);
    }
    if (name === '__schema') {
      return resolveSelections(
        ctx,
        '__Schema',
        {
          queryType: { name: 'Query' },
          mutationType: { name: 'Mutation' },
          types: Object.keys(TYPE_DEFS).map((n) => ({ name: n })),
        },
        field.selections,
      );
    }
    if (name === 'viewer') {
      return resolveSelections(ctx, 'User', { login: VIEWER_LOGIN }, field.selections);
    }
    if (name === 'repository') {
      const repo = store.repo(args.owner as string, args.name as string);
      if (!repo) return null;
      return resolveSelections(ctx, 'Repository', repo, field.selections);
    }
    if (name === 'node') {
      const decoded = unb64url(args.id as string) ?? '';
      if (decoded.startsWith('repo:')) {
        const [owner, repoName] = decoded.slice(5).split('/');
        const repo = store.repo(owner ?? '', repoName ?? '');
        if (!repo) return null;
        return resolveSelections(ctx, 'Repository', repo, field.selections);
      }
      if (decoded.startsWith('issue:')) {
        const match = /^issue:([^/]+)\/([^#]+)#(\d+)$/.exec(decoded);
        if (!match) return null;
        const repo = store.repo(match[1]!, match[2]!);
        const issue = repo?.issues.get(Number.parseInt(match[3]!, 10));
        if (!issue || !repo) return null;
        return resolveSelections(ctx, 'Issue', { repo, issue }, field.selections);
      }
      if (decoded.startsWith('pr:')) {
        const match = /^pr:([^/]+)\/([^#]+)#(\d+)$/.exec(decoded);
        if (!match) return null;
        const repo = store.repo(match[1]!, match[2]!);
        const pr = repo?.pulls.get(Number.parseInt(match[3]!, 10));
        if (!pr || !repo) return null;
        return resolveSelections(ctx, 'PullRequest', { repo, pr }, field.selections);
      }
      return null;
    }
    throw new GqlError(`Cannot query field "${name}" on type "Query"`);
  }

  if (typeName === 'Mutation') {
    return resolveMutation(ctx, field);
  }

  if (typeName.endsWith('Payload') || typeName === 'IssueCommentEdge') {
    return resolvePayloadField(ctx, typeName, value, field);
  }

  if (typeName === 'IssueComment') {
    const comment = value as { id: string; body: string };
    if (name === 'id') return comment.id;
    if (name === 'body') return comment.body;
    throw new GqlError(`Cannot query field "${name}" on type "IssueComment"`);
  }

  if (typeName === '__Schema') {
    const schema = value as { queryType: unknown; mutationType: unknown; types: unknown[] };
    if (name === 'queryType') return schema.queryType;
    if (name === 'mutationType') return schema.mutationType;
    if (name === 'types') return schema.types;
    throw new GqlError(`Cannot query field "${name}" on type "__Schema"`);
  }

  if (typeName === 'Repository') {
    const repo = value as Repo;
    switch (name) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.databaseId;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return resolveSelections(ctx, 'User', { login: repo.owner }, field.selections);
      case 'defaultBranchRef':
        return resolveSelections(ctx, 'Ref', { name: repo.defaultBranch }, field.selections);
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const issue = repo.issues.get(args.number as number);
        if (!issue) return null;
        return resolveSelections(ctx, 'Issue', { repo, issue }, field.selections);
      }
      case 'issues':
        return resolveIssueConnection(ctx, repo, args, field.selections);
      case 'pullRequests':
        return resolvePrConnection(ctx, repo, args, field.selections);
      case 'pullRequest': {
        const pr = repo.pulls.get(args.number as number);
        if (!pr) return null;
        return resolveSelections(ctx, 'PullRequest', { repo, pr }, field.selections);
      }
      default:
        throw new GqlError(`Cannot query field "${name}" on type "Repository"`);
    }
  }

  if (typeName === 'Ref') {
    const ref = value as { name: string };
    if (name === 'name') return ref.name;
    throw new GqlError(`Cannot query field "${name}" on type "Ref"`);
  }

  if (typeName === 'User') {
    const user = value as { login: string };
    if (name === 'login') return user.login;
    if (name === 'id') return user.login === VIEWER_LOGIN ? 1000 : 0;
    if (name === 'name') return user.login === VIEWER_LOGIN ? 'ada iversen' : user.login;
    throw new GqlError(`Cannot query field "${name}" on type "User"`);
  }

  if (typeName === 'Issue') {
    const { repo, issue } = value as { repo: Repo; issue: Issue };
    switch (name) {
      case 'id':
        return issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return issue.body;
      default:
        throw new GqlError(`Cannot query field "${name}" on type "Issue"`);
    }
  }

  if (typeName === 'IssueConnection') {
    const conn = value as { nodes: Array<{ repo: Repo; issue: Issue }>; pageInfo: Record<string, unknown> };
    if (name === 'nodes') {
      return conn.nodes.map((node) => resolveSelections(ctx, 'Issue', node, field.selections));
    }
    if (name === 'pageInfo') {
      return resolveSelections(ctx, 'PageInfo', conn.pageInfo, field.selections);
    }
    throw new GqlError(`Cannot query field "${name}" on type "IssueConnection"`);
  }

  if (typeName === 'PageInfo') {
    const info = value as Record<string, unknown>;
    if (name === 'hasNextPage') return info.hasNextPage ?? false;
    if (name === 'endCursor') return info.endCursor ?? null;
    throw new GqlError(`Cannot query field "${name}" on type "PageInfo"`);
  }

  if (typeName === 'PullRequest') {
    const { repo, pr } = value as { repo: Repo; pr: PullRequest };
    switch (name) {
      case 'id':
        return prGlobalId(repo, pr);
      case 'number':
        return pr.number;
      case 'state':
        return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pr.merged;
      case 'headRefName':
        return pr.headRef;
      case 'baseRefName':
        return pr.baseRef;
      case 'mergeable':
        return store.mergeable(repo, pr);
      case 'files': {
        const baseTip = store.refTarget(repo, `refs/heads/${pr.baseRef}`);
        const headTip = store.refTarget(repo, `refs/heads/${pr.headRef}`);
        const base = mergeBase(headTip, baseTip, (oid) => store.object(oid)) ?? baseTip;
        const files = store.diffFiles(repo, base, headTip);
        const first = typeof args.first === 'number' ? (args.first as number) : files.length;
        const nodes = files.slice(0, first).map((f) => ({ path: f.path }));
        return resolveSelections(
          ctx,
          'PullRequestChangedFileConnection',
          { nodes, pageInfo: { hasNextPage: files.length > first, endCursor: null } },
          field.selections,
        );
      }
      default:
        throw new GqlError(`Cannot query field "${name}" on type "PullRequest"`);
    }
  }

  if (typeName === 'PullRequestConnection') {
    const conn = value as { nodes: Array<{ repo: Repo; pr: PullRequest }>; pageInfo: Record<string, unknown> };
    if (name === 'nodes') {
      return conn.nodes.map((node) => resolveSelections(ctx, 'PullRequest', node, field.selections));
    }
    if (name === 'pageInfo') {
      return resolveSelections(ctx, 'PageInfo', conn.pageInfo, field.selections);
    }
    throw new GqlError(`Cannot query field "${name}" on type "PullRequestConnection"`);
  }

  if (typeName === 'PullRequestChangedFileConnection') {
    const conn = value as { nodes: Array<{ path: string }>; pageInfo: Record<string, unknown> };
    if (name === 'nodes') {
      return conn.nodes.map((node) => resolveSelections(ctx, 'PullRequestChangedFile', node, field.selections));
    }
    if (name === 'pageInfo') {
      return resolveSelections(ctx, 'PageInfo', conn.pageInfo, field.selections);
    }
    throw new GqlError(`Cannot query field "${name}" on type "PullRequestChangedFileConnection"`);
  }

  if (typeName === 'PullRequestChangedFile') {
    const file = value as { path: string };
    if (name === 'path') return file.path;
    throw new GqlError(`Cannot query field "${name}" on type "PullRequestChangedFile"`);
  }

  throw new GqlError(`Cannot query field "${name}" on type "${typeName}"`);
}

function resolveIssueConnection(
  ctx: Ctx,
  repo: Repo,
  args: Record<string, unknown>,
  selections: SelectionNode[],
): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const desc = orderBy?.direction === 'DESC';
  issues.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const afterNum = cursorNumber(args.after);
  if (afterNum !== null) {
    issues = issues.filter((i) => (desc ? i.number < afterNum : i.number > afterNum));
  }
  const first = typeof args.first === 'number' ? (args.first as number) : issues.length;
  const page = issues.slice(0, first);
  const pageInfo = {
    hasNextPage: issues.length > first,
    endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
  };
  return resolveSelections(ctx, 'IssueConnection', { nodes: page.map((issue) => ({ repo, issue })), pageInfo }, selections);
}

function resolvePrConnection(
  ctx: Ctx,
  repo: Repo,
  args: Record<string, unknown>,
  selections: SelectionNode[],
): Record<string, unknown> {
  const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  const first = typeof args.first === 'number' ? (args.first as number) : pulls.length;
  const page = pulls.slice(0, first);
  const pageInfo = { hasNextPage: pulls.length > first, endCursor: null };
  return resolveSelections(ctx, 'PullRequestConnection', { nodes: page.map((pr) => ({ repo, pr })), pageInfo }, selections);
}

function resolveMutation(ctx: Ctx, field: FieldNode): unknown {
  const { store } = ctx;
  const args = argsOf(field, ctx.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;

  const findRepoById = (globalId: string): Repo | null => {
    const decoded = unb64url(globalId) ?? '';
    if (!decoded.startsWith('repo:')) return null;
    const [owner, name] = decoded.slice(5).split('/');
    return store.repo(owner ?? '', name ?? '') ?? null;
  };
  const findIssueById = (globalId: string): { repo: Repo; issue: Issue } | null => {
    const decoded = unb64url(globalId) ?? '';
    const match = /^issue:([^/]+)\/([^#]+)#(\d+)$/.exec(decoded);
    if (!match) return null;
    const repo = store.repo(match[1]!, match[2]!);
    const issue = repo?.issues.get(Number.parseInt(match[3]!, 10));
    return repo && issue ? { repo, issue } : null;
  };
  const findPrById = (globalId: string): { repo: Repo; pr: PullRequest } | null => {
    const decoded = unb64url(globalId) ?? '';
    const match = /^pr:([^/]+)\/([^#]+)#(\d+)$/.exec(decoded);
    if (!match) return null;
    const repo = store.repo(match[1]!, match[2]!);
    const pr = repo?.pulls.get(Number.parseInt(match[3]!, 10));
    return repo && pr ? { repo, pr } : null;
  };

  switch (field.name) {
    case 'createIssue': {
      const repo = findRepoById(input.repositoryId as string);
      if (!repo) throw new GqlError('Repository not found');
      const issue = store.createIssue(repo, input.title as string, (input.body as string) ?? '', []);
      if (!issue) throw new GqlError('Could not create issue');
      return resolveSelections(ctx, 'CreateIssuePayload', { issue: wrap('Issue', { repo, issue }) }, field.selections);
    }
    case 'closeIssue': {
      const found = findIssueById(input.issueId as string);
      if (!found) throw new GqlError('Issue not found');
      store.setIssueState(found.repo, found.issue, 'closed');
      return resolveSelections(ctx, 'CloseIssuePayload', { issue: wrap('Issue', found) }, field.selections);
    }
    case 'createPullRequest': {
      const repo = findRepoById(input.repositoryId as string);
      if (!repo) throw new GqlError('Repository not found');
      const pr = store.createPull(
        repo,
        (input.title as string) ?? '',
        (input.body as string) ?? '',
        input.headRefName as string,
        input.baseRefName as string,
      );
      if (!pr) throw new GqlError('head or base branch does not exist');
      return resolveSelections(ctx, 'CreatePullRequestPayload', { pullRequest: wrap('PullRequest', { repo, pr }) }, field.selections);
    }
    case 'mergePullRequest': {
      const found = findPrById(input.pullRequestId as string);
      if (!found) throw new GqlError('Pull request not found');
      const merged = store.squashMerge(found.repo, found.pr);
      if (merged === null) throw new GqlError('Pull request has a merge conflict');
      return resolveSelections(ctx, 'MergePullRequestPayload', { pullRequest: wrap('PullRequest', found) }, field.selections);
    }
    case 'addComment': {
      const found = findIssueById(input.subjectId as string);
      if (!found) throw new GqlError('Subject not found');
      const comment = store.addComment(found.repo, found.issue, input.body as string);
      const node = { id: String(comment.id), body: comment.body };
      return resolveSelections(
        ctx,
        'AddCommentPayload',
        { commentEdge: wrap('IssueCommentEdge', { node: wrap('IssueComment', node) }) },
        field.selections,
      );
    }
    default:
      throw new GqlError(`Cannot query field "${field.name}" on type "Mutation"`);
  }
}

// Payload objects resolve their single field from the wrapped value.
function resolvePayloadField(ctx: Ctx, typeName: string, value: unknown, field: FieldNode): unknown {
  const payload = value as Record<string, GqlValue>;
  const wrapped = payload[field.name];
  if (!wrapped) throw new GqlError(`Cannot query field "${field.name}" on type "${typeName}"`);
  return resolveSelections(ctx, wrapped.__type, wrapped.__value, field.selections);
}

// ------------------------------------------------------------ HTTP entry

function executeOne(store: ForgeStore, doc: unknown): Record<string, unknown> {
  if (!isRecord(doc) || typeof doc.query !== 'string') {
    return { errors: [{ message: 'GraphQL query is required' }] };
  }
  const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
  const operationName = typeof doc.operationName === 'string' ? doc.operationName : null;
  let parsed: DocumentNode;
  try {
    parsed = new Parser(tokenize(doc.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    parsed.operations.find((op) => operationName !== null && op.name === operationName) ??
    parsed.operations[0];
  if (!operation) return { errors: [{ message: 'No operation found' }] };
  const ctx: Ctx = { store, variables, fragments: parsed.fragments };
  try {
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data: Record<string, unknown> = {};
    for (const selection of operation.selections) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== rootType) continue;
        const fragment = selection.name !== null ? ctx.fragments.get(selection.name) : null;
        const sub = fragment ? fragment.selections : selection.selections;
        Object.assign(data, resolveSelections(ctx, rootType, null, sub));
        continue;
      }
      const key = selection.alias ?? selection.name;
      if (rootType === 'Mutation') {
        data[key] = resolveMutation(ctx, selection);
      } else {
        data[key] = resolveField(ctx, rootType, null, selection);
      }
    }
    return { data };
  } catch (err) {
    if (err instanceof GqlError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    throw err;
  }
}

export async function handleGraphql(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (pathnameOf(req) !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (!hasValidAuth(req)) {
    sendUnauthorized(res);
    return true;
  }
  const body = parseJsonBody(await readBody(req));
  if (body === null) {
    sendJson(res, 400, { message: 'Invalid JSON body', errors: [{ message: 'Invalid JSON body' }] });
    return true;
  }
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((doc) => executeOne(store, doc)));
    return true;
  }
  sendJson(res, 200, executeOne(store, body));
  return true;
}
