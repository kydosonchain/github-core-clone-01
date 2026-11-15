// The HTTP server: routing, auth, request ids.
//
// One Store per process, shared by all four surfaces. The bearer token is the
// trial's MAKEFUN_SHOP_TOKEN; when that variable is unset (local development
// only) any non-empty bearer token is accepted. No logging happens per
// request: the benchmark workloads run thousands of requests through here.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleGit } from './src/git.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { sendJson } from './src/respond.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected) return token === expected;
  return true;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegments(pathname: string): string[] | null {
  const parts = pathname.split('/').filter((p) => p !== '');
  const out: string[] = [];
  for (const p of parts) {
    if (p.indexOf('%') === -1) {
      out.push(p);
      continue;
    }
    try {
      out.push(decodeURIComponent(p));
    } catch {
      return null;
    }
  }
  return out;
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    void (async () => {
      const requestId = store.nextRequestId();
      try {
        const rawUrl = req.url ?? '/';
        const qIndex = rawUrl.indexOf('?');
        const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
        const query = new URLSearchParams(qIndex === -1 ? '' : rawUrl.slice(qIndex + 1));
        const authed = isAuthed(req);
        const method = req.method ?? 'GET';

        if (pathname === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const segments = decodeSegments(pathname);
        if (segments === null) {
          sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
          return;
        }

        // git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          handleGit(store, req, res, segments[0], segments[1].slice(0, -4), segments.slice(2).join('/'), query, {
            authed,
            body,
            requestId,
          });
          return;
        }

        if (pathname === '/api/graphql') {
          const body = await readBody(req);
          handleGraphql(store, req, res, { authed, body, requestId });
          return;
        }

        if (pathname === '/mcp') {
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          handleMcp(store, req, res, { authed, body, requestId });
          return;
        }

        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const restPath = pathname === '/api/v3' ? '' : pathname.slice('/api/v3/'.length);
          const restSegments = restPath === '' ? [] : decodeSegments(`/${restPath}`) ?? [];
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const host = req.headers.host ?? 'localhost';
          handleRest(store, req, res, restSegments, query, {
            authed,
            body,
            requestId,
            baseUrl: `http://${host}`,
          });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
      } catch (err) {
        process.stderr.write(`[app] ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.writableEnded) {
          sendJson(res, 500, { message: 'Internal Server Error' }, { 'x-github-request-id': requestId });
        }
      }
    })();
  });
  return server;
}
