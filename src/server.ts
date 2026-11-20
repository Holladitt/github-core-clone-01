// Lane B server: one http.Server dispatching to the four surfaces, all
// sharing one ForgeStore. Nothing here binds a port; main.ts owns that.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { pathSegments, pathnameOf, queryOf, sendJson } from './util.ts';

export function createForgeServer(store: ForgeStore = new ForgeStore()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathnameOf(req);
        const method = req.method ?? 'GET';

        // Health probe: no auth, 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
        const segments = pathSegments(path);
        if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
          const owner = segments[0]!;
          const repoName = segments[1]!.slice(0, -'.git'.length);
          const tail = segments.slice(2);
          if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
            const service = queryOf(req.url ?? '').get('service') ?? '';
            if (service === 'git-upload-pack' || service === 'git-receive-pack') {
              await handleInfoRefs(store, req, res, owner, repoName, service);
              return;
            }
          }
          if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
            await handleUploadPack(store, req, res, owner, repoName);
            return;
          }
          if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
            await handleReceivePack(store, req, res, owner, repoName);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Fast-path dispatch by path prefix: the four surfaces live on
        // disjoint paths, so each request reaches exactly one handler
        // (each handler still returns false for a path it does not own,
        // so this is identical to trying them in order — without paying
        // for two extra URL parses and handler entries per request).
        if (path === '/mcp') {
          if (await handleMcp(store, req, res)) return;
        } else if (path === '/api/graphql') {
          if (await handleGraphql(store, req, res)) return;
        } else if (path.startsWith('/api/v3')) {
          // handleRest owns every /api/v3 path (it returns false only
          // for a path that does not start with /api/v3).
          await handleRest(store, req, res);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler failure must never kill the server.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
    })();
  });
}
