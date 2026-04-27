# ASC MCP — Build Plan (V1)

> **For the next session:** this file is the complete context. Read it top to bottom before doing anything. The repo is a fork; the real consumer lives in a sibling repo (LeafOS). Paths to both are below. **Start with section 0 — that's where the current state lives.**

---

## 0. Session handoff — last updated 2026-04-22

**Where we are:** the ASC MCP HTTP server is running on `127.0.0.1:8090`, all 27 tools register correctly over HTTP, and Kakashi (in the `hidden-leaf` village, NOT habby) has an `asc` summoning entry wired up. The user was about to run smoke test A in Discord when the previous session ended.

### Immediate next actions (in order)

1. **Smoke test A — confirm it worked.** Ask the user: *"did Kakashi return Habby when you asked him to call `mcp__asc__list_apps`?"* If not, start with `./scripts/server.sh logs` to see what the claude CLI subprocess hit.
2. **Run the bootstrap script (user action)** once smoke test A passes:
   ```bash
   cd /Users/manikanta/Documents/WorkArea/github/asc-mcp
   bun run scripts/bootstrap-analytics.ts
   ```
   This fires the one-time `POST /v1/analyticsReportRequests` that starts Apple's 24–48h warm-up. Saves `.state/bootstrap.json` with the request ID. **Do this early — everything else downstream is gated on the warm-up window.**
3. **Smoke test B (~48h after bootstrap).** Ask Kakashi to pull yesterday's funnel for Habby — he should chain `list_analytics_reports` → `list_analytics_report_segments` → `download_analytics_report_segment`.
4. **Only after hidden-leaf proves out: re-enable the habby wiring.** See "pending" below.

### Done this session

- **Phase 1** (user's manual work): API key generated (Admin role), `.p8` saved to `.secrets/`, `.env` populated with all 5 vars (KEY_ID, ISSUER_ID, P8_PATH, VENDOR_NUMBER, HABBY_APP_ID).
- **Phase 2 (code):**
  - `.gitignore` — added `.secrets/` and `.state/`
  - `src/index.ts` — refactored: `export class AppStoreConnectServer`, added public `connect(transport)` and `close()` methods, auto-run at bottom guarded with `import.meta.url === pathToFileURL(process.argv[1]).href` so imports don't kick off the stdio transport.
  - `src/http.ts` — **stateless per-request pattern** (`sessionIdGenerator: undefined`, fresh `AppStoreConnectServer` + `StreamableHTTPServerTransport` per POST). See gotcha #9 below — do NOT refactor this into a shared-instance design.
  - `package.json` — added `"http": "node dist/src/http.js"` script; bumped `@modelcontextprotocol/sdk` from `^1.15.0` to `^1.27.0` (1.15 install was broken locally — missing `dist/` directory, caused cascade of TS "Cannot find module" errors).
  - `scripts/server.sh` — start/stop/restart/status/logs. Uses `nohup` + PID file in `.state/`. Replaces the originally-planned launchd plist.
  - `scripts/bootstrap-analytics.ts` — one-shot warm-up trigger (not yet run).
- **Phase 2 (sibling repo):**
  - `villages/hidden-leaf/jutsu/map.ts` — added `asc` summoning entry next to the existing `astro` one. Kakashi (generalist ninja there) is the test lab.
  - `bun test` and `bunx tsc --noEmit` both green in the sibling.

### Pending / open

- **Smoke test A confirmation from user.** Server-side is verified (curl `initialize` returned proper MCP response, `tools/list` returned 27 tools). The final hop — claude CLI subprocess from LeafOS actually connecting and Kakashi answering "I see Habby" — was not confirmed in the last session's transcript.
- **Bootstrap script has NOT been run.** Apple's 24–48h warm-up clock has NOT started. Every day this slips pushes smoke test B later.
- **Habby village has uncommitted changes on disk** from earlier in the session, before the user pivoted to "test in hidden-leaf first." Files modified:
  - `villages/habby/jutsu/map.ts` — `asc` summoning entry appended
  - `villages/habby/ninjas/aso_specialist/identity.md` — ASC tool added, "never touch ASC" line softened, per-keyword caveat added
  These are uncommitted `git status` dirty, i.e. LeafOS will read them live if it restarts. User did not decide stash vs. discard vs. leave. **Next session: ask before touching habby.**

### Deviations from the original plan (section 7 steps may be out of date)

- **No launchd plist.** User explicitly said to skip the daemon — manual start via `./scripts/server.sh start`. The plist file was written and then deleted. Revisit only if the user complains about re-starting after reboot.
- **SDK bumped 1.15 → 1.27.** Drop-in compatible — no code change beyond `package.json`. 1.15's npm tarball lacked the `dist/` folder on install, breaking TypeScript module resolution under Node16. 1.27 ships proper per-subpath `exports` entries.
- **Test-in-hidden-leaf-first workflow.** The user doesn't want new infra touching the habby village until it's verified on Kakashi. All summoning/identity edits for new MCPs should land in `villages/hidden-leaf/` first.
- **`http.ts` is stateless, not session-stateful.** The plan originally said "~40–50 lines, route `/mcp` → transport" which reads like one shared transport. That pattern is broken for multi-client (see gotcha #9).

### Quick state check commands

```bash
# Is the ASC server up?
./scripts/server.sh status

# Did the last LeafOS-spawned claude CLI actually hit the server?
tail -30 /Users/manikanta/Documents/WorkArea/github/asc-mcp/.state/server.log

# Sanity-check the server over the wire
curl -sS -X POST http://127.0.0.1:8090/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 500

# Is the LeafOS daemon running?
launchctl print gui/$(id -u)/com.leafos.hidden-leaf | grep state

# Has Apple's warm-up been kicked off?
cat /Users/manikanta/Documents/WorkArea/github/asc-mcp/.state/bootstrap.json 2>/dev/null || echo "NOT YET RUN"
```

---

## 1. What this repo is

Fork of `JoshuaRileyDev/app-store-connect-mcp-server` (TypeScript MCP server for Apple's App Store Connect API). Cloned to `/Users/manikanta/Documents/WorkArea/github/asc-mcp/`.

It serves **Habby**, an iOS app owned by Mani, being used as a test lab for AI marketing agents. The consuming project is **LeafOS** (an agentic AI runtime) at `/Users/manikanta/Documents/WorkArea/github/hidden-leaf-village/`. Inside LeafOS, the **`aso_specialist` ninja** in the **`habby` village** is the first consumer.

**This fork is intentionally disposable.** Apple is expected to ship an official ASC MCP eventually. When they do, delete this fork and swap the URL in the LeafOS summoning map.

## 2. Architecture

```
[aso_specialist ninja] ──(Claude CLI)──> [MCP config JSON]
                                              │
                                              ├── leafos-jutsu (stdio, built-in)
                                              └── asc (HTTP, this fork)
                                                    │
                                                    └── POST /v1/analyticsReportRequests etc.
                                                        → api.appstoreconnect.apple.com
```

- LeafOS has a **Summoning** system (external MCP integration) that supports **HTTP/SSE URLs only** — not stdio. Source: `leaf-os/src/invoker/claude-cli.ts:17-22` in the sibling repo.
- The fork ships a stdio entry point (`src/index.ts`). **We add an HTTP entry point (`src/http.ts`) so Summoning can reach it.**
- A launchd daemon keeps the HTTP server alive on `127.0.0.1:8090`.
- Habby's village summoning map (`villages/habby/jutsu/map.ts` in the sibling repo) registers the URL. Already has `astro` on port 8089 as precedent.
- Ninja sees tools prefixed `mcp__asc__*` (Claude CLI naming convention — same as existing `mcp__astro__*`).

## 3. Key decisions (locked — don't re-litigate)

| Decision | Choice | Why |
|---|---|---|
| Use existing MCP vs. build from scratch | Use existing | 5 open-source options exist; JoshuaRileyDev covers all V1 endpoints |
| Which fork | JoshuaRileyDev | TS/Node matches LeafOS stack, 318 stars, only TS server covering Analytics Reports + metadata + apps list with named tools |
| Fork-and-modify vs. use upstream | Fork | User doesn't want to raise PRs upstream; wants freedom to add/remove tools |
| Run as MCP vs. port to SDK | Run as MCP (HTTP transport) | Disposable when Apple ships official; no ASC code lives in LeafOS repo |
| Read-only vs. writes | Read-only V1 | Gated writes later. Ninja's current identity.md line "You never touch ASC" gets relaxed to "read ASC, never write" |
| Data scope for V1 | Acquisition funnel (impressions → PPV → downloads) + metadata snapshot | Excludes: revenue, reviews, Search Ads, CPP, TestFlight, IAPs. Revenue stays with RevenueCat. Reviews are a fast-follow. |
| Strip tools from fork | **No, keep everything** | User: "it's okay if it has as much information as it can". Strip later only if tool-list clutter hurts ninja performance. |

## 4. Critical gotchas (the stuff that bites)

1. **ASC App Analytics does NOT break down impressions by keyword.** Only by traffic source (Search / Browse / Web Referrer / App Referrer / Campaign) and country. Per-keyword attribution exists only in Apple Search Ads (paid). The ninja's 28-day cycle tracks keyword rank via Astro — that data will never join with ASC funnel data at the keyword level. Apple fundamental limit.
2. **ASC API only exposes apps the key's account owns.** Zero competitor data from ASC. Competitors stay with Astro / iTunes Lookup / Rivioo.
3. **Analytics Reports API is async.** You `POST /v1/analyticsReportRequests` once per app → Apple spends ~24-48h warming up → then generates daily instances forever. Day-to-day queries after warm-up are 3 sync calls: `listAnalyticsReports` → `listAnalyticsReportSegments` → download segment URL → parse CSV. **The bootstrap POST in step 15 below starts the warm-up clock — do it early, even before the LeafOS wire-up is complete.**
4. **Sales Reports API is sync and separate.** `GET /v1/salesReports` returns gzipped TSV in one call. Use this for download counts. Don't confuse with Analytics Reports.
5. **LeafOS Summoning is HTTP/SSE only, not stdio.** The fork's `src/index.ts` is stdio — that's why we add `src/http.ts`.
6. **Reserved MCP name.** `leafos-jutsu` is reserved in `leaf-os/src/invoker/claude-cli.ts:14`. Our summoning entry name must be `asc` (or any non-reserved name).
7. **Admin role required for Analytics Reports.** When generating the ASC API key, pick Role = **Admin**. Finance / App Manager roles won't work for the full funnel.
8. **P8 file only downloadable once.** When you generate the key in ASC, Apple lets you download the `.p8` once. Save it immediately to `.secrets/` — don't close the tab.
9. **`src/http.ts` MUST create server+transport per request, not once at startup.** Sharing a single `AppStoreConnectServer` + `StreamableHTTPServerTransport` across requests causes the second client's `initialize` to be rejected with `"Server already initialized"`, and the claude CLI subprocess silently registers zero tools. Keep the stateless pattern: `sessionIdGenerator: undefined`, fresh instances inside the HTTP handler, cleaned up on `res.close`. The canonical reference is `node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStatelessStreamableHttp.js`. This bit us in session 2 — Kakashi silently got no tools until we rewrote http.ts.
10. **`Cannot find module '@modelcontextprotocol/sdk/...'` after `bun install`** = the installed package has no `dist/` directory. Version 1.15.0's tarball appears to ship broken; bump to `^1.27.0` (or newer) in `package.json`, `rm -rf node_modules bun.lock`, and `bun install` again.

## 5. Paths reference

**This fork** (`/Users/manikanta/Documents/WorkArea/github/asc-mcp/`):
- `src/index.ts` — existing stdio entry (keep, unused by LeafOS)
- `src/http.ts` — **NEW** (Phase 2, step 5): HTTP transport entry point
- `src/services/auth.ts` — JWT ES256 signer (existing, unchanged)
- `src/services/appstore-client.ts` — axios wrapper, gzip handling (existing)
- `src/handlers/analytics.ts` — has `createAnalyticsReportRequest`, `listAnalyticsReports`, `listAnalyticsReportSegments`, `downloadAnalyticsReportSegment`, `downloadSalesReport`, `downloadFinanceReport` — verified by reading the file
- `src/handlers/apps.ts`, `localizations.ts` — V1 needs these
- `src/handlers/beta.ts`, `bundles.ts`, `devices.ts`, `xcode.ts`, `users.ts` — not V1 but not stripped
- `src/http.ts` — stateless per-request HTTP entry point. DONE.
- `scripts/server.sh` — start/stop/restart/status/logs wrapper. DONE. Replaces the originally-planned launchd plist.
- `scripts/bootstrap-analytics.ts` — Apple warm-up kickoff. Written but NOT yet run.
- `.secrets/AuthKey_<KEY_ID>.p8` — in place.
- `.state/server.pid`, `.state/server.log` — runtime artifacts written by `server.sh` (gitignored).
- `.state/bootstrap.json` — will be written by `bootstrap-analytics.ts` on first run (gitignored).

**Sibling LeafOS repo** (`/Users/manikanta/Documents/WorkArea/github/hidden-leaf-village/`):
- `villages/hidden-leaf/jutsu/map.ts` — `asc` summoning entry added next to `astro`. DONE. Kakashi picks up `mcp__asc__*` tools via village-scope summoning.
- `villages/habby/jutsu/map.ts` — **uncommitted local edits** adding `asc` summoning (not yet desired per user's test-first workflow; pending stash/revert/leave decision).
- `villages/habby/ninjas/aso_specialist/identity.md` — **uncommitted local edits** (tool list + softened "never touch" line + per-keyword caveat). Same pending decision as above.
- `leaf-os/src/invoker/claude-cli.ts` — how claude CLI gets MCP config. Key insight: `writeTempMcpConfig()` writes `/tmp/leafos-mcp-<ninja>-<timestamp>.json` then unlinks it after the claude call. To debug "what MCP config did LeafOS send?", temporarily comment the `unlinkSync` in the finally block.
- `leaf-os/src/jutsu/map.ts` — `loadJutsuMap`, `mergeJutsuMaps`, `resolveJutsuMapForNinja`. Village map is loaded fresh each invocation via dynamic `import()`, so editing `map.ts` + bouncing the LeafOS daemon is sufficient — no build step.
- `leaf-os/daemon/com.leafos.hidden-leaf.plist` — existing LeafOS launchd plist. Bounce with `launchctl kickstart -k gui/$(id -u)/com.leafos.hidden-leaf`.

## 6. Who does what

| | You | Claude |
|---|---|---|
| ASC key generation + .p8 download | ✅ | — |
| Find vendor number + Habby app ID | ✅ | — |
| Drop .p8 in `.secrets/` | ✅ | — |
| Add `src/http.ts` to fork | — | ✅ |
| Add launchd plist to fork | — | ✅ |
| Add bootstrap script to fork | — | ✅ |
| Edit LeafOS summoning map | — | ✅ |
| Edit aso_specialist identity.md | — | ✅ |
| Build + install plist + launchctl load | ✅ (Claude gives commands) | — |
| Run bootstrap script | ✅ | — |
| Smoke test on Discord | ✅ | — |

## 7. Step-by-step

### Phase 1 — Mani prep (can run in parallel with Phase 2)

1. ASC → Users and Access → Integrations → App Store Connect API → "+" → Name "LeafOS", Role **Admin**. Download `.p8` immediately. Note **Key ID** and **Issuer ID**.
2. ASC → Payments and Financial Reports → note **Vendor Number**.
3. ASC → My Apps → Habby → App Information → note **Apple ID** (this is the ASC app ID).
4. Save `.p8` to `/Users/manikanta/Documents/WorkArea/github/asc-mcp/.secrets/AuthKey_<KEY_ID>.p8`.
5. Create `/Users/manikanta/Documents/WorkArea/github/asc-mcp/.env` with:
   ```
   APP_STORE_CONNECT_KEY_ID=<key-id>
   APP_STORE_CONNECT_ISSUER_ID=<issuer-id>
   APP_STORE_CONNECT_P8_PATH=/Users/manikanta/Documents/WorkArea/github/asc-mcp/.secrets/AuthKey_<KEY_ID>.p8
   APP_STORE_CONNECT_VENDOR_NUMBER=<vendor-number>
   HABBY_APP_ID=<apple-id>
   ```

### Phase 2 — Claude builds

6. Add `.gitignore` entries: `.secrets/`, `.env`, `.state/` in the fork root.
7. Create `src/http.ts`:
   - Extract server construction from `src/index.ts` into a shared factory function `createServer(config, client)` (refactor `src/index.ts` to use it too)
   - Import `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`
   - Spin up a Node `http.createServer` listening on `127.0.0.1:${PORT ?? 8090}`
   - Route `/mcp` → transport
   - Read env (same 4 vars as stdio entry)
   - ~40-50 lines
8. Update `package.json`:
   - `"http": "node dist/src/http.js"`
   - Ensure `sharp` remains optional (only used for image handling in one handler — don't break)
9. Create `launchd/com.leafos.asc-mcp.plist`:
   - `Label`: `com.leafos.asc-mcp`
   - `ProgramArguments`: `["node", "/Users/manikanta/Documents/WorkArea/github/asc-mcp/dist/src/http.js"]`
   - `EnvironmentVariables`: the 4 ASC vars + `PATH` + `PORT=8090`
   - `KeepAlive: true`, `RunAtLoad: true`
   - `StandardOutPath: /tmp/asc-mcp.out.log`, `StandardErrorPath: /tmp/asc-mcp.err.log`
   - Mirrors `leaf-os/daemon/com.leafos.hidden-leaf.plist` pattern
10. Create `scripts/bootstrap-analytics.ts`:
    - One-shot. Reads `HABBY_APP_ID` from env.
    - `POST /v1/analyticsReportRequests` with `accessType: "ONE_TIME_SNAPSHOT"` for that app ID.
    - Saves response to `.state/bootstrap.json` (request ID, timestamp).
    - Prints: "Bootstrap done. Apple warm-up is 24-48h. Request ID: <id>."
11. Edit `villages/habby/jutsu/map.ts` in the sibling LeafOS repo — append to `summoning`:
    ```ts
    {
      name: "asc",
      url: "http://127.0.0.1:8090/mcp",
      description: "App Store Connect — Habby's own-app analytics, sales reports, metadata snapshot. Tools: `mcp__asc__*`. Read-only. Per-keyword impressions NOT available (Apple limit — use Astro for rank).",
    }
    ```
12. Edit `villages/habby/ninjas/aso_specialist/identity.md`:
    - Under **Tools**, add: `- **ASC MCP** (`mcp__asc__*`) — Habby's own-app funnel analytics (impressions, product page views, conversion rate, downloads by source/country), sales reports (downloads by country), current metadata snapshot. Read-only.`
    - Under **Metadata You Own**, change `"Mani applies everything in App Store Connect. You never touch ASC."` to `"Mani applies every metadata change in App Store Connect. You read ASC (analytics, sales, current metadata) but never write."`
    - Under **ASO Foundations**, add: `- ASC App Analytics funnel is bucketed by traffic source (Search / Browse / Web Referrer / App Referrer / Campaign) and country — NOT by keyword. Per-keyword install attribution requires Apple Search Ads (out of V1 scope).`
13. Run in sibling repo: `bun test` + `bunx tsc --noEmit` (per hidden-leaf-village CLAUDE.md mandate). Fix any type errors in files touched.

### Phase 3 — Wire and verify (together)

14. Mani: `cd /Users/manikanta/Documents/WorkArea/github/asc-mcp && bun install && bun run build`.
15. Mani: `cp launchd/com.leafos.asc-mcp.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.leafos.asc-mcp.plist`.
16. Mani: verify `curl -v http://127.0.0.1:8090/mcp` returns something MCP-shaped (not connection refused). If fails, check `/tmp/asc-mcp.err.log`.
17. Mani: `cd /Users/manikanta/Documents/WorkArea/github/asc-mcp && bun run scripts/bootstrap-analytics.ts` — starts Apple warm-up clock. Save the request ID printed.
18. Mani: restart LeafOS daemon (or wait for next aso_specialist heartbeat — schedule is `0 7,19 * * *` per the ninja config).
19. Smoke test A (immediate, no warm-up needed): Discord to aso_specialist: *"use mcp__asc__list_apps — what apps do you see?"* → should return Habby. Validates auth + transport.
20. Smoke test B (after ~48h when warm-up completes): *"pull yesterday's funnel"* → ninja chains `mcp__asc__list_analytics_reports` → `list_analytics_report_segments` → `download_analytics_report_segment`.

## 8. Deferred items (explicit — do NOT do these in V1)

| Item | Why deferred | Fast-follow after V1? |
|---|---|---|
| `mcp__asc__get_funnel_daily` helper tool (wraps the 3-call async chain into one tool) | Ship raw tools first, see how the ninja handles chaining, then decide if the helper is worth it. Separate design doc will cover daily-cron vs. on-demand and where cached funnel data lives (shrine facts vs. ninja SQL schema). | Yes, first fast-follow |
| Writes (metadata submission, review replies) | Locked as V1 out-of-scope. Gated writes only when we know the usage pattern. | Later |
| Customer reviews pull | Covered by `mcp__asc__*` handlers already in the fork — just un-defer in identity.md when ready. | Yes, after funnel V1 proves out |
| Apple Search Ads | Weeks 11-12 of the 90-day roadmap | Per roadmap timing |
| Revenue / Sales & Finance proceeds | RevenueCat owns monetization per locked architecture boundary | No (belongs in separate RC MCP) |
| Stripping Beta / bundles / devices / xcode handlers | User explicitly said keep everything. Only strip if ninja performance degrades from tool-list clutter. | Maybe, based on observation |

## 9. Open questions (flag if any change)

- **Port 8090** — confirmed sibling to Astro's 8089. No conflicts known.
- **Plist location** — inside this fork, not in LeafOS, so the fork stays self-contained and disposable.
- **Fork branch strategy** — TBD. Consider working on a `leafos-main` branch so `main` can rebase upstream if needed. Not blocking.
- **When Apple ships official MCP** — swap the URL in `villages/habby/jutsu/map.ts`, unload this launchd plist, delete this repo. Clean exit.

## 10. Success criteria for V1 done

- [ ] Phase 1 steps 1-5 complete (keys + env).
- [ ] `src/http.ts` exists, builds, runs.
- [ ] launchd daemon loaded, `curl http://127.0.0.1:8090/mcp` responds.
- [ ] Bootstrap script run, request ID saved to `.state/bootstrap.json`.
- [ ] Habby summoning map has `asc` entry.
- [ ] aso_specialist identity.md updated (tool list, never-touch line, per-keyword caveat).
- [ ] Sibling repo `bun test` + `bunx tsc --noEmit` green.
- [ ] Smoke test A passes (ninja sees Habby via `mcp__asc__list_apps`).
- [ ] Smoke test B passes ~48h later (ninja pulls funnel data).

---

**For the next session:** Phase 1 and Phase 2 are done — start at section 0 above for current state and immediate next actions. The literal next thing is to confirm with Mani whether Kakashi's smoke test A passed, then run the bootstrap script. Don't re-litigate section 3 decisions; don't propose rebuilding `src/http.ts` to use a shared transport (see gotcha #9); don't touch `villages/habby/` until Mani gives the go-ahead.
