import type { BoltCloudflare } from '~/lib/cloudflare-context';

/*
 * Node/VPS counterpart of the Workers `env` binding object.
 *
 * Routes read `context.cloudflare.env.<NAME>` (surviving from the original
 * Workers build), so on the VPS we hand them `process.env` under the same shape.
 * Doing it here — in the request handler's context — means zero changes at those
 * call sites and no reliance on Workers-only globals.
 */
export function createNodeRuntimeContext(ctx?: BoltCloudflare['ctx']): BoltCloudflare {
  return {
    env: process.env as unknown as BoltCloudflare['env'],
    ctx,
  };
}
