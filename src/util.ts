// Lane B shared helpers: tiny HTTP/JSON utilities used by every surface.
// No dependency beyond node:http and node:crypto (via gitobjs).

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';
export const ZERO_OID = '0'.repeat(40);

let requestCounter = 0;
/** A non-empty request id for every reply (deterministic per run order). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-b-${requestCounter.toString(16).padStart(8, '0')}`;
}

/**
 * The bearer token the entry was given, read once at module load:
 * process.env access is slow, and this is called on every authenticated
 * request. The token never changes during a process's life.
 */
const CACHED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The bearer token the entry was given, or '' when the trial did not set one. */
export function expectedToken(): string {
  return CACHED_TOKEN;
}

/** True when the request carries the trial token (or any Bearer when none is configured). */
export function hasValidAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return presented === expected;
}

/** Send a JSON body with the standard headers. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

/** Send raw bytes with a content type. */
export function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}

/** The 404 JSON body every surface uses for a missing resource. */
export function sendNotFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

/** The 401 JSON body for a missing or wrong bearer token. */
export function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

/** Read a request body fully, up to `limit` bytes; rejects when over the limit. */
export function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > limit) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      // Single-chunk bodies (the common case for small requests) skip the copy.
      if (chunks.length === 1 && Buffer.isBuffer(chunks[0])) resolve(chunks[0]!);
      else resolve(Buffer.concat(chunks, total));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Parse a JSON body; returns null when the bytes are not valid JSON. */
export function parseJsonBody(body: Buffer): unknown | null {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Split a URL path into decoded segments (empty segments dropped). */
export function pathSegments(pathname: string): string[] {
  const out: string[] = [];
  for (const part of pathname.split('/')) {
    if (part === '') continue;
    // Fast path: names the suite sends never contain a percent-escape.
    if (!part.includes('%')) {
      out.push(part);
      continue;
    }
    try {
      out.push(decodeURIComponent(part));
    } catch {
      out.push(part);
    }
  }
  return out;
}

/** Shared empty query map: callers only read it (`.get`), never mutate it. */
const EMPTY_QUERY: ReadonlyMap<string, string> = new Map<string, string>();

/** Parse a query string into a map (first value wins). */
export function queryOf(url: string): Map<string, string> {
  const at = url.indexOf('?');
  if (at < 0) return EMPTY_QUERY as Map<string, string>;
  const out = new Map<string, string>();
  for (const pair of url.slice(at + 1).split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
    if (!out.has(key)) {
      out.set(key, decodeURIComponent(((eq < 0 ? '' : pair.slice(eq + 1)).replace(/\+/g, ' '))));
    }
  }
  return out;
}

/** The pathname of a request URL, or '/' when it does not parse. */
export function pathnameOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const at = url.indexOf('?');
  return at < 0 ? url : url.slice(0, at);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return fallback;
}

/** Base64url without padding (for opaque global ids). */
export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function unb64url(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}
