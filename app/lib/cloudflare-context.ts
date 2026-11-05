import { RouterContextProvider } from 'react-router';

/*
 * Minimal shape of a Cloudflare ExecutionContext, kept structural so this module
 * does not depend on `@cloudflare/workers-types` (the Node build has no worker
 * types in scope).
 */
export interface RuntimeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface BoltCloudflare {
  /*
   * Runtime configuration. On Workers this is the `env` binding object; on Node
   * it is `process.env`. Both are read as string maps at every call site.
   */
  env: Env;

  /*
   * Absent on the Node/VPS runtime. Callers guard on `ctx.waitUntil` being a
   * function, so `undefined` simply means "await the work instead".
   */
  ctx?: RuntimeExecutionContext;
}

/*
 * React Router 8 removed `AppLoadContext`; a loader's `context` is now a
 * `RouterContextProvider` and the request handler rejects anything that is not
 * an instance of it.
 *
 * Every route in this app reads `context.cloudflare.env`, so instead of touching
 * all ~43 call sites we subclass the provider and re-expose the runtime bindings
 * as a plain `cloudflare` property. On Workers that is the real `env`; on the
 * Node/VPS build it is an object built from `process.env`. Keeping the property
 * name is what makes the app runtime-agnostic. The matching type augmentation
 * lives in `load-context.ts`.
 */
export class BoltRouterContext extends RouterContextProvider {
  readonly cloudflare: BoltCloudflare;
  readonly clientAddress?: string;

  constructor(cloudflare: BoltCloudflare, clientAddress?: string) {
    super();
    this.cloudflare = cloudflare;
    this.clientAddress = clientAddress;
  }
}
