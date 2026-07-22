# Bundle Size Report — hono-status-monitor

Focus: **serverless consumers** (Cloudflare Workers, Lambda, Vercel Edge), where
bundle size affects cold start and deploy limits.

Numbers measured with `esbuild@0.24 --bundle --minify`, `hono` marked external,
from a clean `npm run build`. Gzip is plain `gzip -9`.

---

## 1. Baseline (v1.0.9)

### Where the "73 KB" came from

```js
import { statusMonitor } from 'hono-status-monitor';
```

| Entry | Minified | Gzipped |
|---|---:|---:|
| `hono-status-monitor` (main) | **74,300 B (72.6 KiB)** | 15,310 B |
| `hono-status-monitor/edge` | 34,659 B | 10,339 B |

The main entry was **2.1× the edge entry** — serverless users landing on the
default import paid for Node-only code they could never execute.

### npm tarball

| Metric | Value |
|---|---:|
| Packed | 53,557 B |
| Unpacked | 265,066 B |
| Files | 63 |

**33% of the install was source maps** no consumer uses (`.js.map` 72,572 B +
`.d.ts.map` 15,024 B).

---

## 2. Who was taking the space

Per-module contribution to the 74,300 B main bundle (esbuild metafile,
post-minification, post-tree-shaking):

| Module | Bytes | Share |
|---|---:|---:|
| **`dashboard.js`** | **48,460** | **65.2%** |
| `monitor.js` | 8,053 | 10.8% |
| `monitor-edge.js` | 5,318 | 7.2% |
| `cluster.js` | 3,124 | 4.2% |
| `edge-store.js` | 2,269 | 3.1% |
| `format.js` | 2,252 | 3.0% |
| everything else | 4,824 | 6.5% |

Same story on edge: `dashboard.js` was 21,755 of 34,659 B (**62.8%**).

### Why `dashboard.js` was immune to the minifier

`src/dashboard.ts` was two large template literals holding HTML + CSS + client
JS. **esbuild cannot minify inside a template literal** — it is opaque string
data. The file went 49,725 → 48,460 B in the bundle: 2.5%, versus ~55% for real
code.

| | Total | CSS | client JS | HTML |
|---|---:|---:|---:|---:|
| `generateDashboard` | 27,897 | 8,125 | 11,872 | ~7,900 |
| `generateEdgeDashboard` | 21,560 | 7,153 | 9,100 | ~5,300 |

### Duplication between the two dashboards

| Block | Node | Edge | Similarity | Shared |
|---|---:|---:|---:|---:|
| CSS | 8,125 | 7,153 | **83%** | ~6,335 B |
| client JS | 11,872 | 9,100 | **68%** | ~7,167 B |

**~13.5 KB of near-identical CSS/JS shipped twice** in the main entry.

### Structural coupling

`src/index.ts` statically imported `createEdgeStatusMonitor` and chose an
implementation at *runtime*, so no bundler could drop either side. A Node
consumer shipped 7,587 B of edge code; a Workers consumer on the default import
shipped 11,177 B of `os`/`cluster` code.

---

## 3. Code reuse / centralization audit

Centralization had been started and left half-finished.

**Already shared correctly:** `routes.ts` (auth guard, `/health`,
`/prometheus`, SSE), `metrics-utils.ts`, `request-tracking.ts`, `format.ts`.
A dead-export scan found nothing removable — only `isMonitorPath` is
unreferenced internally, and that is deliberate public API.

**Problem 1 — the two monitors shared 19 same-named functions.** Ten were
byte-identical or 99%+ (`trackRequest`, `trackRequestComplete`, `getTopRoutes`,
`getSlowestRoutes`, `getErrorRoutes`, `getErrorRate`, `evictRoutesIfNeeded`,
`addToHistory`, `trackRateLimitEvent`, `getHealthReport`) — ~5.2 KB maintained
twice, **~1.9 KB** of duplicated minified code. They were not extracted earlier
for a legitimate reason: they close over per-monitor mutable state
(`routeStats`, `statusCodes`, `activeConnections`), so they could not move into
`metrics-utils.ts` as free functions.

**Problem 2 — the two status factories were ~85% identical**, differing by
exactly five things: dashboard fn, `socketPath`, `enableStream`, `initSocket`,
`isEdgeMode`. That is a config object, not two functions. ~0.6 KB.

**Problem 3 — helpers reimplemented client-side.** `formatUptime` existed three
times, `esc`/`escapeHtml` three times, plus `drawSpark`, `createChart`,
`renderRoutes` and friends duplicated across the two templates.

**Vestigial:** `middleware.ts` was a 3-line pass-through (28 B).

The honest read: Problems 1 and 2 together were only ~2.5 KB — about **3.4%** of
the bundle. `dashboard.ts` alone was 19× larger. They were worth fixing because
**10 near-identical functions in two files will drift**, and a metrics bug fixed
in one but not the other silently ships wrong numbers to exactly the serverless
users this work targets. The bytes were incidental.

---

## 4. What was done

| Fix | Change |
|---|---|
| 1 | Build step minifies the CSS/JS embedded in template literals (`scripts/minify-assets.mjs`) |
| 2 | Shared `BASE_CSS` + one null-safe client script; per-variant CSS only |
| 3 | `workerd` / `edge-light` export conditions resolve edge bundlers to the edge build |
| 4 | Dashboard loaded via dynamic `import()` so splitting bundlers drop it from the entry chunk |
| 5 | Deferred — dashboard-as-opt-in-subpath is a breaking change, left for v2 |
| 6 | Stopped emitting and publishing source maps |
| P1 | `stats-core.ts` — shared accounting core both monitors compose |
| P2 | `status-factory.ts` — one `assembleStatusMonitor`, config-driven |
| P3 | `dashboard-assets.ts` / `dashboard.ts` / `dashboard-edge.ts` |
| — | Folded `middleware.ts` into `request-tracking.ts` |

---

## 5. Results (v1.1.0)

### Bundle size

| Entry | Baseline | Shipped | Δ |
|---|---:|---:|---:|
| main, minified | 74,300 | **50,300** | **−32.3%** |
| main, gzipped | 15,310 | 14,096 | −7.9% |
| edge, minified | 34,659 | **31,218** | **−9.9%** |
| edge, gzipped | 10,339 | 10,454 | +1.1% |

With code splitting (Vite, Rollup, `esbuild --splitting`) the dashboard leaves
the entry chunk entirely:

| Entry chunk | Baseline | Shipped | Δ |
|---|---:|---:|---:|
| main | 74,300 | **23,507** | **−68.4%** |
| edge | 34,659 | **12,920** | **−62.7%** |
| edge, gzipped | 10,339 | **4,886** | **−52.7%** |

### Install size

| Metric | Baseline | Shipped | Δ |
|---|---:|---:|---:|
| Unpacked | 265,066 | **162,376** | **−38.7%** |
| Packed | 53,557 | **39,978** | −25.4% |
| Files | 63 | 39 | −38% |

### Source

| File | Before | After |
|---|---:|---:|
| `dashboard.ts` | 50,114 | 3 modules totalling 36,474 |
| `monitor.ts` | 26,034 | 18,146 |
| `monitor-edge.ts` | 18,746 | 12,175 |
| duplicated monitor functions | 10 | **0** |

Net: **757 insertions, 1,575 deletions**.

### Honest accounting

Two results landed below projection, for reasons worth recording:

1. **Edge gzip is flat (+43 bytes).** The projection assumed dedup and
   minification would compound. Gzip had already been collapsing most of that
   redundancy, so removing it from the source recovered little *compressed*
   size. The raw −10.4% is real and helps cold-start parse time, but anyone
   sizing against Cloudflare's compressed limit should expect no change.
2. **The edge entry initially got _bigger_ (39,497 B, +14%).** Making the
   dashboard a dynamic `import()` defeated tree-shaking — a dynamic import
   forces the bundler to retain the whole target module, so the edge build
   started carrying the Node-only stylesheet. Fixed by splitting the dashboard
   into three modules. **The lesson generalises: lazy loading only shrinks a
   bundle if the lazily-loaded module holds nothing the eager path needed.**

The largest single win is code splitting, and it is the one thing consumers must
opt into. Wrangler does not split by default, so most Workers users land on
31 KB, not 12.9 KB. This is documented in the README rather than assumed.

---

## 6. Verification

The refactor touched every metrics path, so correctness was established by
differential testing against the v1.0.9 build rather than by inspection:

- **Metrics parity** — both monitors driven through an identical request
  sequence; snapshots, health reports and chart shapes byte-identical after
  scrubbing volatile fields.
- **Edge cases** — route eviction past `maxTrackedRoutes`, `maxRecentErrors`
  capping, `resetStats`, unbalanced `trackRequestComplete`: identical.
- **Public API** — exported symbols, handle shape and route table diffed against
  v1.0.9. Only additions, no removals (hence semver-minor).
- **Rendered HTML** — CSS rule counts (71 node / 58 edge) and DOM ids (43 / 25)
  preserved exactly.
- **End-to-end** — packed the tarball, installed into a clean project, exercised
  `/`, `/api/metrics`, `/health`, `/prometheus`.
- **Build self-check** — `minify-assets.mjs` re-renders and re-parses both
  dashboards after minifying and fails the build on a dropped element or syntax
  error. Both failure modes were negative-tested.
- **Real Cloudflare Workers run** — built with Wrangler 4.113 and served under
  `workerd` via `wrangler dev --local`. `/`, `/status`, `/status/api/metrics`,
  `/status/health` and `/status/prometheus` all return 200; the dashboard
  renders (15,412 B), which means the request-time dynamic `import()` resolves
  inside the real runtime. Wrangler inlines it into a single module rather than
  emitting a second chunk, so there is no cross-chunk import at runtime on the
  default path. Zero `node:os` / `node:cluster` / `node:perf_hooks` references
  in the output.
- **`workerd` export condition** — importing the *bare* `hono-status-monitor`
  specifier from a Worker produces a byte-identical bundle to the explicit
  `/edge` import (178.06 KiB upload, 44.07 KiB gzip, Hono included). The
  condition resolves as documented.
- 58/58 unit tests green.

### Known gap

Unit tests import from `src/`, which is never minified, so the minifier is not
covered by `npm test`. That is why validation lives inside the build step
instead — it runs on every `npm run build` and every `prepublishOnly`.
`tests/dashboard-contract.test.ts` covers the other half: it pins the snapshot
fields the shared client script reads, on both platforms, so trimming the edge
payload to save bytes fails a test rather than silently freezing the dashboard.

---

## Reproducing these numbers

```bash
npm run clean && npm run build
npm pack --dry-run --json          # tarball + unpacked size

echo 'import { statusMonitor } from "./dist/index.js"; export default statusMonitor();' > /tmp/n.mjs
npx esbuild@0.24 /tmp/n.mjs --bundle --minify --format=esm --platform=node \
    --external:hono --outfile=/tmp/n.min.js --metafile=/tmp/n.meta.json
# per-module attribution: outputs[].inputs[].bytesInOutput in n.meta.json

# with code splitting
npx esbuild@0.24 /tmp/n.mjs --bundle --minify --splitting --format=esm \
    --platform=node --external:hono --outdir=/tmp/split
```
