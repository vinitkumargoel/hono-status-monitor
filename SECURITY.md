# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.2.x | Yes |
| 1.1.x | Security fixes only |
| < 1.1 | No. Upgrade to 1.2. |

## Reporting a vulnerability

Report vulnerabilities privately. Do not open a public issue, pull request or discussion.

1. Go to <https://github.com/vinitkumargoel/hono-status-monitor/security/advisories/new> (the repository's **Security** tab, then **Report a vulnerability**).
2. Include the affected version, runtime (Node, Bun, Workers, Deno, Vercel Edge), a minimal reproduction or proof of concept, and the impact as you understand it.

What to expect:

- Acknowledgement within 5 business days.
- An initial assessment (confirmed, needs more information, or not a vulnerability) within 10 business days.
- For confirmed issues, a fix and a patched release for the supported versions, coordinated with you through the advisory. A CVE is requested where appropriate, and you are credited unless you prefer not to be.

This is a single-maintainer project; timelines are targets, not guarantees.

## Scope

In scope: the published `hono-status-monitor` package, including the dashboard HTML and client script it serves, its HTTP endpoints, and the edge store integration.

Out of scope: deployments that expose the status routes without `authorize` or other access control (the routes are public by default; see below), vulnerabilities in `hono` or other dependencies (report those upstream), and findings that require an already compromised server.

## Hardening checklist

The status surface reveals hostname, PID, runtime versions, route names, error messages and health check details. Before deploying:

- **Restrict access.** Set `authorize`, or put your own auth middleware on the mount path before `app.route`. Compare secrets in constant time (`timingSafeEqual` from `hono/utils/buffer`) and reject when the secret is unset. `authorize` covers every status route, including `/health`, `/prometheus` and `/api/stream`. In production the monitor logs a warning at startup if `authorize` isn't set.
- **Enable `securityHeaders: true`** unless you need cross-origin embedding. It adds a nonce-based Content-Security-Policy and same-origin framing. It becomes the default in 2.0.
- **Under a strict CSP**, use `inlineCharts: true` (no external scripts) or self-host Chart.js and set `chartjsUrl` / `chartAdapterUrl`. The default CDN scripts carry Subresource Integrity hashes.
- **Don't expose health details publicly.** If load balancers or probes need an unauthenticated endpoint, serve a separate route that returns only the status (`monitor.getHealth()`), not the full report. Keep secrets and connection strings out of `HealthCheckResult.details`.
- **Keep error messages clean.** Recent errors are shown on the dashboard; avoid putting tokens or personal data in error messages or URLs.
- **Configure `logger`.** Route the monitor's messages to your logging system, and don't pass `logger: false` in production if you want the missing-`authorize` warning to be seen.
- **Bound memory.** Keep `maxTrackedRoutes` at a sensible cap and use `groupBy: 'route'` or `normalizePath` so scanners can't create unbounded route entries.
