import { createRequestListener } from '@react-router/node';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RouterContextProvider, type ServerBuild } from 'react-router';

import type { BoltCloudflare } from '~/lib/cloudflare-context';
import { getSupabaseSession } from '../app/lib/.server/supabase.ts';
import { createNodeRuntimeContext } from './node-context.ts';

/*
 * Node/VPS entry point. Mirrors workers/app.ts: both build the same
 * `RouterContextProvider` the React Router request handler requires, differing
 * only in where the runtime bindings come from (`process.env` here).
 *
 * `SERVER_BUILD` is the path (absolute, or relative to the working directory) of
 * the React Router server build. Defaults to the repo's `build/server/index.js`,
 * which is also where this entry lives after `tsc` places it under
 * `build/server-node/`.
 */
const buildPath = resolve(process.env.SERVER_BUILD ?? 'build/server/index.js');

const build = (await import(pathToFileURL(buildPath).href)) as unknown as ServerBuild;

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

/*
 * Workers serves `build/client` from the asset layer in front of the worker. On
 * Node nothing does that, so the entry has to, or every `/assets/*` request
 * reaches the router and 404s.
 */
const clientDir = resolve(process.env.CLIENT_DIR ?? 'build/client');

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Immutable for hashed bundles, revalidated for everything else. */
function cacheControlFor(pathname: string) {
  return pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
}

/** Returns true when the request was answered by a static file. */
function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }

  /*
   * Only the two namespaces the build actually emits. Anything else — notably
   * API routes such as `/api/chat` — must reach the router untouched.
   */
  if (!/^\/(assets|icons|avatars)\//.test(req.url ?? '') && !/^\/[^/]+\.[a-zA-Z0-9]+$/.test(req.url ?? '')) {
    return false;
  }

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const filePath = normalize(join(clientDir, decodeURIComponent(pathname)));

  // Directory traversal guard: never serve outside the client build.
  if (!filePath.startsWith(clientDir) || !existsSync(filePath)) {
    return false;
  }

  const stat = statSync(filePath);

  if (!stat.isFile()) {
    return false;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', cacheControlFor(pathname));

  if (req.method === 'HEAD') {
    res.end();

    return true;
  }

  createReadStream(filePath).pipe(res);

  return true;
}

const listener = createRequestListener({
  build,
  mode: 'production',
  getLoadContext: async (request, client) => {
    const context = new RouterContextProvider() as RouterContextProvider & {
      cloudflare: BoltCloudflare;
      user: { id: string; email?: string } | null;
    };

    context.cloudflare = createNodeRuntimeContext();

    /*
     * Resolve the session once per request so loaders can read `context.user`
     * synchronously. Done here rather than in every loader because GoTrue would
     * otherwise be called once per matched route.
     *
     * A failure here must not take the whole request down — a database blip
     * should surface as "signed out", not as a 500 on the marketing page.
     */
    let user: { id: string; email?: string } | null = null;

    try {
      const session = await getSupabaseSession(request);

      user = session.user;
    } catch (error) {
      console.error('Session resolution failed:', error);
    }

    // Lets security.ts resolve the real client IP (rate limiting, bug reports).
    return Object.assign(context, { clientAddress: client.address, user }) as typeof context;
  },
});

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (serveStatic(req, res)) {
    return;
  }

  listener(req, res);
});

server.listen(port, host, () => {
  console.log(`koadr listening on http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, closing server`);
    server.close(() => process.exit(0));
  });
}
