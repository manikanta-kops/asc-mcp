# ASC MCP — Ingest-layer Build Plan (V1.1, this repo)

> **Scope:** this plan covers work inside the `asc-mcp` fork only. The complementary work in the LeafOS sibling repo (ingest jutsu, Supabase schema, cron) is in `plan-ingest-leafos.md`.
>
> **Read `plan.md` first.** V1 status (stateless HTTP server, 27 raw tools registered, ONGOING + ONE_TIME_SNAPSHOT bootstraps fired on 2026-04-22) is the precondition for this plan. Don't duplicate anything from there.

---

## 0. Goal

Add **high-level, date-range, parsed** MCP tools that the LeafOS ingest jutsu can call once per day to pull structured rows into Supabase. The existing 27 raw tools stay — they remain the ad-hoc surface for `aso_specialist`. The new tools are for the pipeline.

**Design principles (locked):**
- MCP stays **stateless**. No local cache, no DB, no knowledge of downstream storage.
- New tools do the Apple 3-call chain + CSV parse + date loop **server-side**. Caller gets one clean JSON response per tool call.
- Raw CSV never crosses the wire to the caller.
- Output is a flat array of structured rows — ready to UPSERT without transformation.

## 1. New tools to expose

### 1.1 `get_daily_engagement`

**Purpose:** funnel rows (impressions, product page views, downloads, conversion rate) by date × territory × source.

**Input:**
```ts
{
  app_id: string;            // required; Habby's app id from HABBY_APP_ID
  from: string;              // ISO date "YYYY-MM-DD", inclusive
  to: string;                // ISO date "YYYY-MM-DD", inclusive; max 90 days per call
  request_id?: string;       // optional; defaults to .state/bootstrap-ongoing.json's requestId
}
```

**Output:**
```ts
{
  rows: Array<{
    date: string;            // "YYYY-MM-DD"
    app_id: string;
    territory: string;       // ISO country code, e.g. "US", "JP"
    source: string;          // "App Store Search" | "App Store Browse" | "Web Referrer" | "App Referrer" | "Campaign" | "Unknown"
    impressions: number;
    product_page_views: number;
    downloads: number;
    conversion_rate: number; // 0..1
  }>;
  warnings: string[];        // per-date issues: "no report for 2026-04-20 (warm-up incomplete)", rate-limit notes, etc.
  meta: {
    request_id: string;
    date_range: { from: string; to: string };
    row_count: number;
    apple_report_name: string; // which APP_STORE_ENGAGEMENT report we used
  };
}
```

**Per-date algorithm (verified against Apple docs + forum reports — see §4):**
1. **Once per tool call:** `listAnalyticsReports(requestId)` — filter to `category=APP_STORE_ENGAGEMENT`. Paginate with `limit=200` (there are <30 reports per request in practice, but don't hard-cap at 100). Pick the DAILY-granularity engagement report by name; log `meta.apple_report_name`.
2. **Per date:** `GET /v1/analyticsReports/{reportId}/instances?filter[granularity]=DAILY&filter[processingDate]=YYYY-MM-DD`. Returns 0 or 1 instance. **This step does not exist in the current `AnalyticsHandlers` — we add `listAnalyticsReportInstances(reportId, { granularity, processingDate })` to `src/handlers/analytics.ts`.**
3. **Per date:** `GET /v1/analyticsReportInstances/{instanceId}/segments` → array of `{ url, checksum, sizeInBytes }`. An instance can split into multiple segments when the file is large; the aggregator must download and concatenate all of them. (Existing `listAnalyticsReportSegments` is keyed by `reportId`, not `instanceId` — we add the instance-keyed variant and leave the old one alone for backward compatibility.)
4. **Per segment:** `GET segment.url` **with NO bearer token** — it's an S3 pre-signed URL that already embeds AWS credentials; attaching `Authorization: Bearer ...` risks S3 rejecting the request. Use `responseType: 'arraybuffer'` so axios does not decode the gzip bytes as UTF-8. Optionally verify `sha256(body) === segment.checksum` when the checksum is a hex sha256.
5. Gunzip (Node's `zlib.gunzipSync`) → UTF-8 string → `csv-parse/sync` → row array.
6. Normalize column names to snake_case (Apple's CSV headers use spaces/title-case; they also drift over time — see §4).
7. Filter to the requested `app_id` (report CSV includes `app_apple_identifier` column and can cover multiple apps if the key owns more than one).

**Edge cases to handle:**
- Date earlier than warm-up completion (no matching instance) → skip + warning. Don't fail the whole call.
- Date within Apple's 48h completeness window (i.e., `processingDate >= today - 1`) → skip + warning. Apple's docs: "Data for a given day is considered complete two days after the reporting date." The safe ceiling is `today - 2`, not `today - 1` as originally drafted.
- Apple returns 429 (`RATE_LIMIT_EXCEEDED`) → exponential backoff (1s, 2s, 4s) respecting the `x-rate-limit` response header (`user-hour-rem` tells us how many calls remain in the rolling hour). After 3 retries, surface as warning and continue with the next date.
- Empty CSV / no data for territory-source combo → omit row, don't emit zero-rows. Downstream (Supabase) decides how to fill gaps.
- Segment checksum mismatch → retry once, then warn.

### 1.2 `get_daily_sales`

**Purpose:** sales & downloads by territory. Uses the **Sales Reports API** (separate, synchronous — see plan.md gotcha #4), *not* Analytics Reports.

**Input:**
```ts
{
  app_id: string;            // optional — Sales API returns all apps under VENDOR_NUMBER; we filter to app_id post-fetch
  from: string;              // inclusive
  to: string;                // inclusive; max 30 days per call (Sales API limit for DAILY granularity)
  vendor_number?: string;    // defaults to APP_STORE_CONNECT_VENDOR_NUMBER env
}
```

**Output:**
```ts
{
  rows: Array<{
    date: string;
    app_id: string;
    territory: string;
    units: number;
    proceeds_usd: number;
    sku?: string;            // for future IAP support
  }>;
  warnings: string[];
  meta: {
    vendor_number: string;
    date_range: { from: string; to: string };
    row_count: number;
  };
}
```

**Per-date algorithm (verified against Apple docs + forum thread 745052):**
1. `GET /v1/salesReports` with `filter[reportType]=SALES`, `filter[reportSubType]=SUMMARY`, `filter[frequency]=DAILY`, `filter[reportDate]=YYYY-MM-DD`, `filter[vendorNumber]=...`. **Omit `filter[version]` by default** — Apple has had recurring incidents where 1_0 is rejected for "latest version is 1_1" and 1_1 returns 404 on DAILY. Omitting the version parameter works across the fleet. If Apple later forces versioning, we add: `1_0` for dates before 2024-01-22, `1_1` for dates from 2024-01-22 onward. Expose `version?: string` on the tool input for manual override.
2. Request with `responseType: 'arraybuffer'` + `Accept-Encoding: gzip`. Response is **gzipped TSV** served inline (not a redirect to S3 — unlike analytics segments). Gunzip → UTF-8 → `csv-parse/sync` with `delimiter: '\t'`.
3. Filter rows by `app_id` (Apple returns all apps under the vendor key; filter on the `Apple Identifier` column).
4. Normalize columns. Keep for V1.1: `Begin Date`, `Units`, `Developer Proceeds`, `Country Code`, `Apple Identifier`, `SKU`.

**Edge cases:**
- Apple's Sales API returns `404` with body `"There were no sales for the date specified."` on days with zero units (weekend, pre-launch, free-only app with no paid sales). Treat as "no rows for that date" + warning. Do NOT fail.
- Apple also returns 404 (not 403) if the `version` is wrong for the date — distinguish the two by parsing the error body; if "invalid version" appears, retry with the other version before warning.
- Currency normalization: the TSV has `Customer Currency` and `Developer Proceeds` (already USD). We only persist USD proceeds in V1.1.
- DAILY sales for free apps are largely empty. That is expected data, not a bug — Habby is paid so this shouldn't bite us, but flag if we ever add a free app.

### 1.3 (Deferred — NOT in V1.1) `get_metadata_snapshot`

Not part of V1.1. Metadata is mutable state, not time-series; the ingest pattern is different (snapshot-on-change, not daily append). Revisit after the funnel + sales pipelines are live and validated.

Raw metadata tools (`get_app_info`, `list_app_localizations`, etc.) remain available on the MCP for ad-hoc use by `aso_specialist`.

## 2. Files to add / modify

| File | Change |
|---|---|
| `src/handlers/analytics-aggregated.ts` | **NEW.** Holds `getDailyEngagement()` and `getDailySales()` range functions. Wraps existing `AnalyticsHandlers` + `AppStoreConnectClient`. Does the per-date loop, rate-limit bookkeeping, and ONGOING/SNAPSHOT dual-source resolution. |
| `src/handlers/analytics.ts` | **MODIFY.** Add `listAnalyticsReportInstances(reportId, { granularity, processingDate, limit })` → hits `/v1/analyticsReports/{id}/instances`. Also add `listSegmentsForInstance(instanceId, { limit })` → hits `/v1/analyticsReportInstances/{id}/segments`. Existing methods untouched. Also: make `listAnalyticsReports` paginate beyond `limit=100`. |
| `src/services/appstore-client.ts` | **MODIFY.** Add `downloadBinaryPublic(url): Promise<Buffer>` that does a plain `axios.get(url, { responseType: 'arraybuffer' })` with **no Authorization header** — for segment pre-signed S3 URLs. Also add `getBinary(path, params)` for the salesReports gzipped TSV (adds `responseType: 'arraybuffer'` but keeps the bearer since it's a first-party ASC endpoint). Leave the existing `downloadFromUrl` alone for backward compat. |
| `src/services/parse.ts` | **NEW.** `parseGzippedDelimited(buffer: Buffer, delimiter: ','|'\t'): Row[]`. Uses Node's `zlib.gunzipSync` + `csv-parse/sync`. Shared by funnel (CSV) + sales (TSV). |
| `src/index.ts` | Register two new tools in the `tools/list` response. Route `tools/call` to the new handlers. Existing 27 raw tools untouched → total is **29**. |
| `src/http.ts` | Unchanged (stateless per-request pattern still applies — see plan.md gotcha #9). |
| `package.json` | Add `csv-parse` (~150KB, zero-dep) — the same package handles both comma and tab delimiters. Bump version to `0.3.0`. |
| `README.md` | Add "High-level ingest tools" section describing `get_daily_engagement` + `get_daily_sales`. |

**Explicitly NOT changing:**
- `src/services/auth.ts` — no change needed.
- `.state/bootstrap-ongoing.json`, `.state/bootstrap.json` — read-only consumption; ingest tools read `requestId` from here at request time.

**Per-tool-call caps** (enforced in input validation, not silently truncated):
- `get_daily_engagement`: max 90 days per call. Above cap → error `"range exceeds 90-day limit; caller should split the range"`.
- `get_daily_sales`: max 90 days per call. (Sales API has no intrinsic limit here; we self-impose for symmetry and to stay inside the 5-minute HTTP budget.)
- Wall-time budget: single tool call may take up to ~5 minutes for a full 90-day engagement fetch due to rate-limit pacing. MCP response is synchronous; callers should set a 360-second HTTP timeout. Noted in README.

## 3. Request-id resolution (date-aware)

The ingest tools need Apple's `requestId` — but which one depends on **the date range being asked for**, not on which bootstrap was run first. ONGOING starts generating instances only *after* the warm-up completes; SNAPSHOT is Apple's one-time historical drop (coverage is what Apple chooses, reportedly imperfect per forum reports).

**Resolution order, per date being fetched:**

1. If the tool input has an explicit `request_id`, use it as-is. No fallback logic. Caller knows what they want.
2. Otherwise, load both `.state/bootstrap-ongoing.json` and `.state/bootstrap.json` at the start of the call. If either is missing, the other is used unconditionally.
3. For each date in the requested range:
   - **Try ONGOING first** if the date is `>= ongoing.createdAt + 48h` (the warm-up completion threshold). Call `listAnalyticsReports(ongoing.requestId)` → `listInstances(reportId, processingDate=date)`. If an instance exists, use it.
   - **Fall back to SNAPSHOT** if ONGOING returned 0 instances for that date OR the date is before ONGOING's warm-up completion. Call the same chain with `snapshot.requestId`.
   - If both return 0 instances, emit a warning for that date and move on.
4. If neither bootstrap file exists → error: `"no bootstrap request found; run bun run scripts/bootstrap-analytics.ts {ongoing|snapshot}"`.

**Why try both:** correctness over cleverness. The MCP's job is "return rows that exist." If we pick one source by date heuristic and it's empty, we silently drop data that was in the other source. Trying both and letting empty-results be the filter costs at most one extra API call per date when ONGOING has it covered (cheap), and guarantees we surface everything Apple has.

**Caching in-request:** resolve `listAnalyticsReports` once per `(requestId, category)` tuple and reuse across dates in the same tool call. Saves ~N calls on an N-day loop. Still re-read state files on the next HTTP request (stateless server — see `plan.md` gotcha #9).

**Response `meta`** gains a `sources_used: { ongoing: number, snapshot: number }` counter so callers can see which dates came from where — useful for debugging backfill coverage.

## 4. Apple's report discovery quirks (things that will bite)

- **48h completeness window, not 24h.** Apple's official docs: "Data for a given day is considered complete two days after the reporting date." Default `to = today - 2`. Asking for `today - 1` can return partial data or an empty instance. Warn if caller asks for `to >= today - 1`.
- **Three-level hierarchy:** `AnalyticsReportRequest → Report (schema) → ReportInstance (one per processingDate+granularity) → Segment (downloadable file, pre-signed S3 URL)`. The shorthand `listAnalyticsReportSegments(reportId)` in the existing handler bypasses the instance layer and does not let you target a specific date — it's kept for ad-hoc debugging only. The ingest aggregator uses the instance-keyed chain.
- **Report categories.** For funnel data, we want the `APP_STORE_ENGAGEMENT` category. Apple also exposes `COMMERCE`, `APP_USAGE`, `FRAMEWORK_USAGE`, `PERFORMANCE` (note: Apple's live values are `COMMERCE`/`FRAMEWORK_USAGE` — earlier drafts of this plan and the TS `AnalyticsReportCategory` union mis-cited these as `APP_STORE_COMMERCE`/`FRAMEWORKS_USAGE`). The aggregator picks the specific report by name at runtime — Apple's exact naming is subject to minor drift; log the selected `apple_report_name` in `meta`.
- **Segment download URLs are pre-signed S3.** Do **not** send the ASC bearer token to these URLs. Apple's API returns links with embedded AWS credentials; attaching a bearer header risks the request being rejected or silently returning HTML error pages. Use a plain axios GET with `responseType: 'arraybuffer'`. This diverges from the existing `AppStoreConnectClient.downloadFromUrl` (which currently attaches the bearer) — either add a `downloadBinaryPublic(url)` method or inline the fetch in the aggregator.
- **Segments can be multi-file.** A single instance may have N segments if the CSV is large (Apple splits by group). Download all of them per date and concatenate rows post-parse.
- **Granularity filter.** `listAnalyticsReports` returns DAILY, WEEKLY, MONTHLY — always filter to DAILY for this pipeline.
- **Territory encoding.** Apple uses ISO 3166-1 alpha-2 codes in recent reports but has legacy quirks — `"US"` is fine, but some niche territories use non-standard codes. Pass through as-is for V1.1; normalize later if Supabase queries hit issues.
- **Rate limits.** Documented: 3600 requests per rolling hour per key. Undocumented soft cap: ~300/min bursts trigger 429. Apple echoes usage in the `x-rate-limit` header (`user-hour-lim:3600;user-hour-rem:<n>;`). The aggregator:
  - Reads the header after every call; if `user-hour-rem < 200`, inserts a cooldown (sleep to next hour boundary or abort with warning).
  - Inserts a deliberate ~250ms gap between Apple calls to stay under the per-minute cap. For a 90-day engagement fetch (~360 calls: 1 listReports + 90 listInstances + 90 × ~3 segments downloads on average), that's ~90s of deliberate gap, comfortably inside the 5-minute budget.

## 5. Testing approach (pragmatic, not exhaustive)

V1.1 testing is **end-to-end smoke via the ingest jutsu**, not unit tests. Rationale:
- The existing fork has no test infra.
- Apple's API can't be faithfully mocked for CSV shape quirks.
- The real signal is: does a full backfill land clean rows in Supabase?

Hand-smoke checklist before declaring this plan done:

1. `bun run build` passes.
2. `./scripts/server.sh restart`. `./scripts/server.sh status` green.
3. Curl the new tools directly (after warm-up — ~Apr 24):
   ```bash
   curl -sS -X POST http://127.0.0.1:8090/mcp \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_daily_engagement","arguments":{"app_id":"'"$HABBY_APP_ID"'","from":"2026-04-22","to":"2026-04-23"}}}' | jq
   ```
   Expect: `rows` array with at least a handful of territory×source combos, `meta.row_count > 0`.
4. Same for `get_daily_sales`.
5. Confirm `warnings` field is empty (or populated with legitimate date-skip warnings, not errors).

## 6. Work breakdown (ordered)

1. [ ] `bun add csv-parse` + commit `bun.lock` (currently untracked).
2. [ ] Extend `src/services/appstore-client.ts`:
   - [ ] `getBinary<T=Buffer>(path, params)` — axios `responseType: 'arraybuffer'`, keeps bearer. For salesReports gzipped TSV.
   - [ ] `downloadBinaryPublic(url)` — plain axios `GET` with `responseType: 'arraybuffer'`, **no Authorization header**. For analytics segment pre-signed S3 URLs.
3. [ ] Extend `src/handlers/analytics.ts`:
   - [ ] `listAnalyticsReportInstances(reportId, { granularity, processingDate, limit })`.
   - [ ] `listSegmentsForInstance(instanceId, { limit })`.
   - [ ] Paginate `listAnalyticsReports` past `limit=100` via `links.next`.
4. [ ] Write `src/services/parse.ts` (gunzip + `csv-parse/sync`, delimiter arg, ~40 lines).
5. [ ] Write `src/handlers/analytics-aggregated.ts`:
   - [ ] `loadBootstraps()` helper — reads both `.state/bootstrap-ongoing.json` and `.state/bootstrap.json` using paths anchored to `process.env.STATE_DIR ?? <repo-root>/.state`.
   - [ ] `getDailyEngagement()` — per-date loop with ONGOING-first, SNAPSHOT-fallback dual source; rate-limit pacing (~250ms gap + `x-rate-limit` header monitoring); 90-day cap; 48h lag clamp.
   - [ ] `getDailySales()` — direct `getBinary('/salesReports', ...)` per date; 404 body parsing to distinguish "no data" from "bad version"; 90-day cap.
   - [ ] Shared: column normalization, `meta` aggregation including `sources_used`.
6. [ ] Register `get_daily_engagement` + `get_daily_sales` in `src/index.ts` tool map + `tools/call` dispatcher. Verify `tools/list` returns 29.
7. [ ] Update `README.md`: new "High-level ingest tools" section; note the 5-minute worst-case latency + 360s client timeout recommendation.
8. [ ] `bun run build`. `./scripts/server.sh restart`. Smoke-curl both tools (§5.3, §5.4).
9. [ ] Commit: `feat: add get_daily_engagement and get_daily_sales range tools for ingest pipeline`.

**Estimate:** ~6–8 hours of focused work once warm-up completes. Before warm-up, steps 1–7 can land and build; only the smoke tests in §5.3+ are blocked on the clock. Added work vs. the prior estimate: the `analytics.ts` handler additions, binary response handling in the client, and the dual-source resolution logic each cost ~1h.

## 7. Success criteria

- [ ] Two new tools present in `tools/list` response: `get_daily_engagement`, `get_daily_sales`.
- [ ] Each returns a flat array of structured rows, no raw CSV / TSV text anywhere in the response.
- [ ] Per-date errors (missing instance, warm-up not done, 404-no-sales) become warnings in `meta.warnings`, not failures.
- [ ] Max-range-per-call cap of 90 days enforced for both tools with a clean error if exceeded.
- [ ] `meta.sources_used` populated for engagement — shows how many dates came from ONGOING vs SNAPSHOT.
- [ ] `meta.rate_limit_remaining` reports Apple's last-seen `user-hour-rem` so callers can pace themselves.
- [ ] Existing 27 raw tools still work unchanged (no regression — curl `tools/list` should show **29** tools).
- [ ] `./scripts/server.sh logs` shows no errors during a clean 2-day range call; 90-day call completes within 5 minutes.

## 8. Deferred

- Metadata snapshot tool (see §1.3).
- Review ingest.
- Multi-app support in a single call (V1.1 is single-app per call; the ingest jutsu passes `HABBY_APP_ID`).
- Weekly/monthly granularity helpers — Supabase can always aggregate DAILY rows.
- Streaming / chunked response for >30-day ranges — if a caller wants 365 days, they loop; MCP enforces per-call caps.

---

**For the next session implementing this plan:** the right starting point is §6, step 1. Expect the `apple_report_name` in `APP_STORE_ENGAGEMENT` to need one round of empirical discovery once warm-up completes — prepare to log-and-adjust rather than hardcoding the exact report name up front.

**Research notes — sources used to verify the details above (2026-04-22):**
- Apple docs: `GET /v1/analyticsReports/{id}/instances`, `GET /v1/analyticsReportInstances/{id}/segments`, `GET /v1/salesReports`, and the Identifying Rate Limits page.
- Apple docs (Analytics Reports overview): "Data for a given day is considered complete two days after the reporting date."
- polpiella.dev walkthrough: confirms the 5-step chain (reportRequests → reports → instances → segments → download).
- Medium (Leonardo Gonzalez): segment URLs are S3 pre-signed; no bearer token on download.
- Apple Developer Forum thread 745052: history of salesReports DAILY + version parameter quirks; Apple-staff-confirmed fix but with residual "omit version" guidance that survives today.
- Apple Developer Forum thread 731014: rate limit header format `user-hour-lim:3600;user-hour-rem:N`; per-minute soft cap ~300–350 reported.
