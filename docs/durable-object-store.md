# Durable Object store

`durableObjectStore()` is a `StatusStore` backed by a single Cloudflare Durable Object (`StatusStoreObject`). Use it in place of a KV namespace for edge fleet aggregation when you want reads that see every write right away.

## When to use it instead of KV

| | Workers KV | Durable Object store |
|---|---|---|
| Consistency | Eventual, up to ~60 s | Strong: a read sees every earlier write |
| `list()` | Slow and billed per call | One in-memory storage scan inside the object |
| Minimum TTL | 60 s | None (edge-store still clamps to 60 s) |
| Throughput | Very high reads, 1 write/s per key | One object, roughly 1k requests/s |
| Setup | Namespace id | Class export plus a migration |

Pick the Durable Object when the fleet view needs to be current (a few isolates, frequent dashboard polls, short `storeWriteInterval`), or when KV `list` costs add up. Stay on KV for very large fleets. Every isolate talks to the same object, so a single object is the ceiling.

## 1. wrangler.toml

```toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[[durable_objects.bindings]]
name = "STATUS_STORE"
class_name = "StatusStoreObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["StatusStoreObject"]   # or new_classes = [...] on the paid KV-backed backend
```

Use `new_sqlite_classes` on the Free plan (SQLite-backed objects) or `new_classes` for the key-value storage backend. Both work, because the object only uses the key-value storage API. Only add the migration once. Later migrations get new tags.

## 2. The Worker

The class must be exported from the Worker's main module, or the binding fails to deploy.

```ts
// src/index.ts
import { Hono, type ExecutionContext } from 'hono';
import { timingSafeEqual } from 'hono/utils/buffer';
import { statusMonitor } from 'hono-status-monitor/edge';
import { durableObjectStore, type DurableObjectNamespaceLike } from 'hono-status-monitor/durable-object';

// Required: the runtime looks the class up on the main module's exports.
export { StatusStoreObject } from 'hono-status-monitor/durable-object';

interface Env {
  STATUS_STORE: DurableObjectNamespaceLike; // a DurableObjectNamespace satisfies this
  STATUS_TOKEN?: string;
}

type App = Hono<{ Bindings: Env }>;

function createApp(env: Env): App {
  const monitor = statusMonitor({
    store: durableObjectStore(env.STATUS_STORE),
    storeWriteInterval: 15_000, // strong consistency makes shorter intervals worthwhile
    // The status routes answer 403 until authorize or publicAccess is set.
    authorize: async (c) => !!env.STATUS_TOKEN && timingSafeEqual(c.req.header('x-token') ?? '', env.STATUS_TOKEN),
  });

  const app: App = new Hono<{ Bindings: Env }>();
  app.use('*', monitor.middleware);
  app.route('/status', monitor.routes);
  return app;
}

// Bindings only exist inside fetch, so build the app (monitor and store) once per
// isolate on the first request, then reuse it.
let app: App | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    app ??= createApp(env);
    return app.fetch(request, env, ctx);
  },
};
```

### Where to create the store

Don't create the monitor per request. It would start from zero counters every time. Create the store together with the monitor, on the first request, as above. A binding such as `env.STATUS_STORE` stays valid for the isolate's whole lifetime, so holding it is safe. The client doesn't keep a stub around either. It calls `namespace.get(namespace.idFromName(name))` for every operation, so a stub broken by a deploy or an object reset is never reused.

## Options

```ts
durableObjectStore(namespace, name = 'hono-status-monitor')
```

`name` picks the object instance. Every isolate that should appear in the same fleet view must use the same name. Use a different name for each environment if they share a namespace.

## Behaviour

- Entries store their expiry time. Expired entries are dropped when a `get` or `list` touches them, and an alarm clears the rest, so a stopped isolate's snapshot disappears on its own.
- Limits: keys and prefixes are at most 512 characters, and values at most 128 KB (UTF-8). A request that breaks them gets a `400`, and the client call rejects. The monitor treats store errors as best-effort and never fails a request because of one.
- The object talks over a small JSON RPC (`POST`, body `{ op: 'get' | 'put' | 'list', key?, value?, ttlSeconds?, prefix? }`). It isn't meant to be exposed to the internet. Only your Worker, through the binding, can reach it.

## Security

The object trusts whoever can call its `fetch()`. Inside your Worker that is only code holding the `STATUS_STORE` binding, which is what you want. Never forward an incoming request (or a client-chosen path or body) to the stub: anyone who can reach such a route could read and overwrite every stored snapshot. TTLs above 30 days, keys over 512 characters and values over 128 KB are rejected with a 400.
