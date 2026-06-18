# Web Client Reliability — Reproduction Matrix

Repro tests live in `test/browser/network-repro.spec.ts`. They are **expected-fail** until
items 27–29 fix the underlying causes. Once fixed, remove the `test.fail()` marks and they
become the regression suite.

## Network Profiles

| Profile | Latency | Down (bytes/s) | Up (bytes/s) | Description |
|---|---|---|---|---|
| desktop-direct | <5 ms | unlimited | unlimited | Local daemon, no proxy |
| mobile/cloudflared | 150 ms | 200,000 (1.6 Mbps) | 50,000 (400 kbps) | Phone over tunnel |
| offline | ∞ | 0 | 0 | Network cut (cell handoff, tunnel drop) |

## Failure Matrix

| # | Scenario | Profile | Observed Failure | Root Cause | Fix Item |
|---|---|---|---|---|---|
| 1 | List load with 30 active sessions | mobile-3G | "Load failed" / timeout >10s | N+1 fan-out: 1 list + N `fetchWaitingFor` requests serialize on slow link | 27 |
| 2 | List load with route delay (200ms/req) | mobile-cloudflared | Waiting-for info missing or stalled | Per-session detail requests delayed by proxy RTT | 27 |
| 3 | List load with transient abort | any | "Load failed" with no recovery | No retry/backoff on initial fetch; single failure is permanent | 28 |
| 4 | SSE mid-stream: offline → online | mobile-3G | Entries appended offline never appear | `online` event not wired to SSE reconnect; stream error may not fire on silent drop | 29 |
| 5 | SSE mid-stream: 3G cut + restore | mobile-3G | Missed entries after network restore | Same as #4, plus high-latency reconnect delay compounds the gap | 29 |
| 6 | SSE + backgrounding: frozen+offline → active+online | mobile | Background entries never render | Combined visibility + network drop not handled atomically | 29 |

## How to Run

```bash
# Install Playwright browsers (first time only)
npx playwright install chromium

# Run the repro suite
npx playwright test test/browser/network-repro.spec.ts

# Run all browser tests
npm run test:browser
```

All tests in `network-repro.spec.ts` are currently marked `test.fail()`, meaning Playwright
expects them to fail. A "passing" run shows all tests as "expected failure". When a fix lands
and a test starts passing, remove its `test.fail()` marker — that's the signal the bug is
fixed and the test is now a regression guard.

## Shaping Techniques Used

- **CDP `Network.emulateNetworkConditions`**: throttles at the protocol level (applies to all
  requests including SSE). Simulates mobile bandwidth and offline transitions.
- **Playwright `page.route()` with delay**: adds per-request latency on specific URL patterns.
  Simulates cloudflared proxy overhead on the detail-fetch fan-out.
- **Playwright `page.route()` with abort**: simulates transient network failures (DNS timeout,
  connection refused, tunnel restart).
- **CDP `Page.setWebLifecycleState`**: simulates mobile app backgrounding (frozen → active).
  Combined with offline toggle reproduces the common mobile pattern of network + visibility
  state changing together.
