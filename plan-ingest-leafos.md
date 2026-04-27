# LeafOS Ingest Pipeline — Build Plan (V1.1, sibling repo)

> **Scope:** this plan describes work that happens in **the LeafOS sibling repo** at `/Users/manikanta/Documents/WorkArea/github/hidden-leaf-village/`. This file lives in the `asc-mcp` repo only for session continuity — copy it into the sibling repo or keep it here as the design anchor.
>
> **Precondition:** `plan-ingest-mcp.md` (this repo) is shipped. **Status as of 2026-04-22:** MCP is built, deployed on `127.0.0.1:8090`, tools registered (29 total including the two new ones). End-to-end smoke-called successfully (`get_daily_sales` returned live Apple data with rate-limit header; `get_daily_engagement` confirmed chain works — rows empty only because Apple's 48h warm-up is still in progress, completes ~2026-04-24). The exact MCP tool shapes below reflect what's actually shipped, not the original design doc.

---

## 0. Goal

Build the **ingest side** of the ASC analytics pipeline: a scheduled TypeScript jutsu in LeafOS that calls the ASC MCP, parses the response, and UPSERTs rows into Supabase. After this ships, other ninjas (not just `aso_specialist`) can query Habby's analytics by reading Supabase tables — no MCP knowledge required.

**Design principles (locked):**
- Ingest is **code, not LLM reasoning.** The data never lands in a ninja's context window. The ninja only triggers the jutsu and sees a summary.
- **Cron-driven, idempotent.** Re-runs are safe (UPSERTs on natural keys). If a run fails, the next one catches up automatically.
- **Self-bootstrapping schema.** First run creates the tables; subsequent runs are no-ops on the DDL.
- **Cursor = the data itself.** `SELECT MAX(date) FROM fact_table` tells the jutsu where to resume. No separate cursor table.
- **MCP stays decoupled.** If we ever swap the fork for Apple's official MCP, only the URL changes in the summoning map; the ingest jutsu still works.

## 1. Open questions to answer before coding

These depend on LeafOS conventions that aren't in this repo. Surface answers before starting §3:

- **Supabase credentials:** where do they live in LeafOS today? (`.env`? Keychain? Config module?) Ingest needs the **service-role key** (schema DDL + writes), not the anon key.
- **Existing Supabase client:** is there a shared `supabase-js` wrapper in `leaf-os/src/`? If yes, reuse it. If not, we stand up one.
- **Jutsu conventions:** are jutsus TS functions imported via `villages/*/jutsu/map.ts`, or is there a different pattern for non-MCP jutsus? (The summoning map is for MCP; we need the in-repo jutsu path.)
- **Cron mechanism:** does LeafOS have an internal scheduler, or do we use system `launchd`? The existing aso_specialist heartbeat (`0 7,19 * * *`) is configured somewhere — same path for ingest.
- **Where village-scope documentation lives:** the message to other ninjas ("query Supabase, don't touch MCP") goes into `villages/habby/CLAUDE.md`? `villages/habby/ninjas/*/identity.md`? Both?

**Action:** ask Mani / read the sibling repo's `CLAUDE.md` and jutsu scaffolding before starting §3.

## 2. Supabase schema

### 2.1 `asc_daily_engagement`

```sql
CREATE TABLE IF NOT EXISTS asc_daily_engagement (
  date                date    NOT NULL,
  app_id              text    NOT NULL,
  territory           text    NOT NULL,
  source              text    NOT NULL,
  impressions         bigint,
  product_page_views  bigint,
  downloads           bigint,
  conversion_rate     numeric,
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, app_id, territory, source)
);

CREATE INDEX IF NOT EXISTS idx_asc_daily_engagement_app_date
  ON asc_daily_engagement (app_id, date DESC);
```

### 2.2 `asc_daily_sales`

```sql
CREATE TABLE IF NOT EXISTS asc_daily_sales (
  date          date    NOT NULL,
  app_id        text    NOT NULL,
  territory     text    NOT NULL,
  units         bigint,
  proceeds_usd  numeric,
  sku           text,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, app_id, territory, COALESCE(sku, ''))
);

CREATE INDEX IF NOT EXISTS idx_asc_daily_sales_app_date
  ON asc_daily_sales (app_id, date DESC);
```

Postgres gotcha: `COALESCE(sku, '')` in a composite PK requires expression indexes. If that's fiddly with Supabase migrations, simplify to `(date, app_id, territory, sku)` with `sku` set to `''` (empty string) when absent in the app logic — same effect, cleaner DDL.

### 2.3 `asc_ingest_runs` (optional but recommended)

```sql
CREATE TABLE IF NOT EXISTS asc_ingest_runs (
  id                    bigserial PRIMARY KEY,
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  from_date             date,
  to_date               date,
  table_name            text    NOT NULL,
  rows_written          bigint,
  warnings              jsonb,
  rate_limit_remaining  integer,        -- last-seen x-rate-limit user-hour-rem from Apple
  sources_used          jsonb,          -- { ongoing: N, snapshot: N } — engagement only
  apple_report_name     text,           -- which engagement report was selected (Standard vs Detailed)
  error                 text
);

CREATE INDEX IF NOT EXISTS idx_asc_ingest_runs_time
  ON asc_ingest_runs (started_at DESC);
```

Observability layer. One row per (table, range) invocation. Lets us debug "why are the last 3 days missing from engagement?" without re-running, and "did we use Detailed or Standard today?" without log diving.

## 3. The ingest jutsu

**Proposed location:** `leaf-os/src/jutsu/asc-ingest.ts` (or wherever LeafOS convention puts cross-village jutsus — needs confirmation per §1).

### 3.1 Entry points

```ts
// Primary — cron-driven, no args.
export async function ingestAscFunnel(opts?: {
  from?: string;       // ISO date; default = MAX(date) + 1 from Supabase
  to?: string;         // ISO date; default = today - 2 (Apple's 48h completeness window)
  app_id?: string;     // default = HABBY_APP_ID env
  request_id?: string; // optional explicit ASC analyticsReportRequests id; skips MCP's dual-source fallback
  dry_run?: boolean;   // skip UPSERTs, log what would be written
}): Promise<IngestSummary>;

export async function ingestAscSales(opts?: {
  from?: string;
  to?: string;
  app_id?: string;
  vendor_number?: string;
  version?: string;    // override Apple's sales report version; default is to omit the parameter
  dry_run?: boolean;
}): Promise<IngestSummary>;

type IngestSummary = {
  table: string;
  date_range: { from: string; to: string };
  rows_written: number;
  warnings: string[];          // includes both MCP-forwarded warnings and ingest-side issues
  rate_limit_remaining?: number; // forwarded from MCP meta
  sources_used?: { ongoing: number; snapshot: number }; // engagement only
  error?: string;
  duration_ms: number;
};
```

**MCP tool shapes (verbatim, what's actually registered):**

```ts
// get_daily_engagement
input  = { app_id: string; from: string; to: string; request_id?: string }
output = {
  rows: Array<{
    date: string; app_id: string; territory: string; source: string;
    impressions: number; product_page_views: number;
    downloads: number; conversion_rate: number;
  }>;
  warnings: string[];
  meta: {
    request_id?: string;
    date_range: { from: string; to: string };
    row_count: number;
    apple_report_name?: string;       // "App Store Discovery and Engagement Standard" or Detailed
    sources_used: { ongoing: number; snapshot: number };
    rate_limit_remaining?: number;
  };
}

// get_daily_sales
input  = { app_id?: string; from: string; to: string; vendor_number?: string; version?: string }
output = {
  rows: Array<{
    date: string; app_id: string; territory: string;
    units: number; proceeds_usd: number; sku?: string;
  }>;
  warnings: string[];
  meta: {
    vendor_number: string;
    date_range: { from: string; to: string };
    row_count: number;
    rate_limit_remaining?: number;
  };
}
```

### 3.2 Algorithm (applies to both funnel and sales)

```
1. ensureSchema()                         — idempotent CREATE TABLE IF NOT EXISTS.
2. resolveDateRange(opts)
     from = opts.from ?? (SELECT MAX(date) FROM <table> WHERE app_id = ?) + 1 day
     to   = opts.to   ?? today - 2        // Apple's 48h completeness window;
                                          // the MCP also clamps to today-2 with a warning if asked for later.
     if from > to → return early: "up to date"
     if (to - from) > 90 days → split into chunks of 90 days and loop   // MCP enforces a 90-day cap per call
3. insertRun({ started_at, from, to, table }) → runId       [if §2.3 enabled]
4. for each 90-day chunk:
     mcpClient.callTool(toolName, {...})  // HTTP POST 127.0.0.1:8090/mcp, 360s timeout (engagement can take ~5min at full range)
5. validateResponse(rows)                 — shape + bounds check
6. chunk rows into 1000-row batches
   for each batch: supabase.from(table).upsert(batch, { onConflict: <pk columns> })
7. updateRun({ runId, finished_at, rows_written, warnings, rate_limit_remaining, sources_used })
8. return IngestSummary
```

### 3.3 Failure handling

| Failure | Behavior |
|---|---|
| MCP server unreachable | Log error, write failed run row, return with `error` set. Cron retries next cycle; no cursor advanced since nothing was written. |
| MCP returns `warnings` but also rows | UPSERT the rows, log warnings, mark run successful. Typical cause: a few dates empty due to Apple privacy-suppression in the Detailed report, or 404-no-sales on zero-sale days. |
| MCP forwards Apple 429 in warnings | MCP handles rate-limit pacing internally (~250ms between calls + `x-rate-limit` header monitoring) and surfaces 429s as warnings per affected date. Jutsu treats per-date 429 warnings as partial success. If `rate_limit_remaining` in meta drops below ~500, the ingest log should flag it so the cron cadence can be reviewed. |
| Supabase write error mid-batch | Abort remaining batches for this run, write failed run row. Rows already UPSERTed stay (idempotent — next run re-UPSERTs cleanly). |
| Apple returns empty for a date | MCP surfaces as warning (`"YYYY-MM-DD: no data available from any source"` for engagement, `"YYYY-MM-DD: no sales data"` for sales); jutsu treats as "no data" (row_count 0 is valid). |
| Warm-up incomplete (pre-2026-04-24) | First runs return warnings for all engagement dates with `sources_used = { ongoing: 0, snapshot: 0 }`. That's fine; cursor doesn't advance, later runs catch up. Sales has no warm-up concept and works immediately. |
| 90-day cap exceeded | MCP returns an error (not a warning). Jutsu MUST chunk — the algorithm in §3.2 step 2 enforces this. |
| Wall-time on large ranges | 90-day engagement call ≈ 5 minutes. The MCP client MUST set a 360-second read timeout. Default fetch timeouts (often 30–120s) will cut off legitimate calls. |

### 3.4 MCP client

Thin `fetch()` wrapper — ~40 lines. Implements:

- `callTool(name, args)` → `POST http://127.0.0.1:8090/mcp` with headers `Content-Type: application/json` + `Accept: application/json, text/event-stream` (the MCP HTTP transport returns SSE-framed JSON: `event: message\ndata: {json}\n\n`).
- **Timeout: 360s** (`AbortController` with `setTimeout(..., 360_000)`). Default fetch timeouts kill 5-minute engagement calls.
- Parse the SSE frame by stripping the `data: ` prefix, JSON-parsing, then reading `result.content[0].text`, then JSON-parsing THAT (the MCP wraps the tool's JSON in a text content block).
- On `result.isError` or top-level `error`, throw with the `message`.
- Retry once on network failure (ECONNREFUSED, timeout). Do NOT retry on a semantic error — the cron will retry tomorrow if the Apple side is having a bad day.

```ts
// Skeleton
async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 360_000);
  try {
    const res = await fetch('http://127.0.0.1:8090/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await res.text();
    // Strip SSE frame(s); for our MCP only one `data: ` line comes back.
    const dataLine = text.split('\n').find(l => l.startsWith('data: '));
    if (!dataLine) throw new Error(`malformed MCP response: ${text.slice(0, 200)}`);
    const envelope = JSON.parse(dataLine.slice('data: '.length));
    if (envelope.error) throw new Error(envelope.error.message ?? 'MCP error');
    const payload = envelope.result?.content?.[0]?.text;
    if (!payload) throw new Error('MCP returned no content');
    return JSON.parse(payload) as T;
  } finally {
    clearTimeout(timer);
  }
}
```

**Don't** try to use the `@modelcontextprotocol/sdk` client on the LeafOS side — it's overkill for a two-tool pipeline.

## 4. Cron / scheduling

**Recommendation:** dedicated cron at **09:00 local time daily**. Apple's daily generation typically lands between 3:00–8:00 local; 9:00 gives a buffer. Note that because the MCP clamps `to` to `today - 2` for completeness, 09:00 vs noon vs evening doesn't affect data freshness — the cron is writing yesterday-minus-one regardless. Pick 09:00 for operational predictability.

Two options depending on §1 answers:

- **Option A — system `launchd`** (if LeafOS doesn't have an internal scheduler):
  - New plist at `~/Library/LaunchAgents/com.leafos.asc-ingest.plist`.
  - `ProgramArguments`: invoke a one-shot node/bun entry (e.g., `bun run leaf-os/src/jutsu/asc-ingest.ts`) that calls both `ingestAscFunnel()` and `ingestAscSales()` and exits.
  - `StartCalendarInterval`: `{ Hour = 9, Minute = 0 }`.
  - `StandardOutPath` / `StandardErrorPath` to `/tmp/asc-ingest.{out,err}.log`.

- **Option B — LeafOS internal scheduler** (if one exists, e.g., for ninja heartbeats):
  - Register as a scheduled jutsu alongside ninja cron entries.
  - Preferred if available — one scheduler to manage.

Both options call the same `ingestAscFunnel()` + `ingestAscSales()` entry points.

## 5. Ninja integration

### 5.1 Triggering tool for `aso_specialist`

Expose the ingest jutsu as a tool on `aso_specialist` (not other ninjas). Name: `ingest_asc_now` or similar. Arguments optional (passes through to `ingestAscFunnel` / `ingestAscSales`).

**Use case:** manual backfill, gap recovery, or "run it now to pull today's data before the ninja answers the user."

Result returned to the ninja = `IngestSummary` (NOT the raw rows). Typically < 200 bytes in context.

### 5.2 Village documentation for other ninjas

Add to `villages/habby/CLAUDE.md` (or equivalent):

```markdown
## ASC analytics data

Habby's App Store Connect analytics land in Supabase via a daily cron (09:00 local).
Query the following tables directly — do NOT call the ASC MCP for analytics:

- `asc_daily_engagement(date, app_id, territory, source, impressions,
   product_page_views, downloads, conversion_rate)` — funnel rows
- `asc_daily_sales(date, app_id, territory, units, proceeds_usd, sku)` — sales rows

Both tables go back to the earliest warm-up date (~2026-04-24). Data has a 48h completeness lag
(Apple: "data for a given day is considered complete two days after the reporting date").
Cron writes through `today - 2`.

The ASC MCP (`mcp__asc__*`) remains available for ad-hoc metadata questions
(current title, localizations, app info). Do NOT use it for analytics; use Supabase.
```

Update `villages/habby/ninjas/aso_specialist/identity.md`:
- Tools section: add `ingest_asc_now` (manual trigger).
- "Data sources" section: clarify `asc_daily_*` tables for analytics, MCP for metadata.

## 6. Backfill

Once the jutsu is live:

1. Manually invoke `ingestAscFunnel({ from: '2026-04-24', to: <today-2> })` once warm-up completes. Confirm by reading `.state/bootstrap-ongoing.json` in the `asc-mcp` repo: if the `createdAt` there + 48h is past, warm-up is done.
2. For historical backfill: call `ingestAscFunnel({ from: '<earliest-date>', to: '2026-04-23' })`. The MCP's dual-source logic tries ONGOING first (empty for historical dates), then SNAPSHOT (has Apple's one-time historical drop). `meta.sources_used` in the run log will show the `{ ongoing: 0, snapshot: N }` breakdown. Note Apple's SNAPSHOT coverage is not guaranteed to be perfectly continuous — forum reports suggest Apple sometimes selects dates non-deterministically — so audit `SELECT date FROM asc_daily_engagement` for gaps and re-run targeted chunks if needed.
3. Chunking: if the total range exceeds 90 days, the jutsu's §3.2 step 2 loop handles this by splitting into 90-day windows automatically.
4. Sales backfill: same pattern, no warm-up concept. Apple's Sales API serves historicals directly.

After backfill, cron takes over.

## 7. Work breakdown (ordered)

1. [ ] Answer §1 open questions — read LeafOS conventions, confirm with Mani.
2. [ ] Write SQL for §2 tables. Store as `leaf-os/src/jutsu/asc-ingest-schema.sql` OR inline in the jutsu's `ensureSchema()`.
3. [ ] Write `leaf-os/src/jutsu/mcp-client.ts` (thin HTTP wrapper, §3.4).
4. [ ] Write `leaf-os/src/jutsu/asc-ingest.ts`:
   - [ ] `ensureSchema()`
   - [ ] `resolveDateRange()` (Supabase cursor read)
   - [ ] `ingestAscFunnel()` + `ingestAscSales()` + shared helpers
   - [ ] Run-log writes to `asc_ingest_runs`
5. [ ] Register cron (Option A or B per §4).
6. [ ] Add `ingest_asc_now` as an `aso_specialist` tool (§5.1).
7. [ ] Update `villages/habby/CLAUDE.md` and `aso_specialist/identity.md` (§5.2).
8. [ ] Manual backfill run (§6).
9. [ ] Verify: `SELECT date, COUNT(*) FROM asc_daily_engagement GROUP BY date ORDER BY date` shows continuous daily coverage.
10. [ ] Sibling repo `bun test` + `bunx tsc --noEmit` green (per hidden-leaf-village CLAUDE.md mandate).
11. [ ] Commit + tag: `feat: ASC daily analytics ingest pipeline`.

**Estimate:** ~1–2 days, assuming §1 answers are straightforward. The schema and jutsu are small; most of the time is in wiring to LeafOS conventions and verifying backfill completeness.

## 8. Success criteria

- [ ] Both Supabase tables exist and are auto-created by first jutsu run (no manual migration step needed).
- [ ] Cron runs daily at 09:00 local; `asc_ingest_runs` shows a successful row each day.
- [ ] `SELECT MAX(date) FROM asc_daily_engagement` advances by 1 every day.
- [ ] `aso_specialist` can manually trigger `ingest_asc_now` and gets back an `IngestSummary` (< 1 KB response).
- [ ] Other ninjas (e.g., a sales-ops ninja) can answer "what were Habby's US downloads last Tuesday?" by reading Supabase — without ever touching `mcp__asc__*`.
- [ ] Removing the `asc` summoning entry from the village map does NOT break analytics queries (proves the decoupling). Restore it afterward.

## 9. Deferred

- **Reviews ingest.** Similar pattern — new MCP tool + new Supabase table + same jutsu scaffolding. After funnel + sales prove out.
- **Metadata snapshot ingest.** Different access pattern (snapshot-on-change, not daily append). Design pass needed.
- **Keyword rank merge with Astro data.** Separate jutsu, joins `asc_daily_engagement` with Astro's rank table. Cross-source analysis.
- **Multi-app support.** V1.1 is Habby-only. Generalize when we add a second app.
- **Materialized views** for common rollups (weekly totals, 7-day rolling averages). Add if ninjas' query latency matters.
- **Standard-vs-Detailed picker tuning.** The MCP's current picker (first report whose name contains "discovery" and "engagement") landed on "Standard" for Habby — correct for a small app because Apple's privacy thresholding suppresses more rows in "Detailed" (Detailed omits any row with <5 users/devices). Re-evaluate after Habby's daily territory×source cells routinely clear 5+ uniques; at that point the MCP picker should bias toward "Detailed" for richer breakdowns. Currently no action needed.

---

**For the next session implementing this plan:** §1 is the real first step — don't start on code until you've read the LeafOS jutsu scaffolding and know where Supabase credentials and cron live in that repo. Once those are clear, §2 → §3 → §4 → §5 → §6 is a straight line.

---

## Appendix A — Quick-reference MCP contract (as actually shipped)

- **URL:** `http://127.0.0.1:8090/mcp`
- **Transport:** HTTP + SSE-framed JSON (responses prefixed `event: message\ndata: {json}\n\n`)
- **Tool names:** `get_daily_engagement`, `get_daily_sales`
- **Per-call caps:** 90 days both tools. Request ranges larger than 90d → MCP returns an error.
- **Lag clamp:** `to` auto-clamped to `today - 2` (48h completeness window) with a warning when the caller asks for more recent.
- **Timeout budget:** 360 seconds. A 90-day engagement call can legitimately run ~5 minutes due to Apple's rate-limit pacing.
- **Rate limit echo:** `meta.rate_limit_remaining` forwards Apple's `user-hour-rem` from the last call; useful for the ingest to pace if multiple tools run back-to-back.
- **Data sources (engagement):** tries ONGOING bootstrap first per date, falls back to SNAPSHOT. `meta.sources_used = { ongoing: N, snapshot: N }` reports what actually produced rows.
- **Data sources (sales):** single source — Apple's `/v1/salesReports` synchronous endpoint. No bootstrap needed.
- **Zero-row policy:** MCP omits rows where all metrics are zero. The ingest SHOULD NOT try to fill these with zeros on UPSERT — let the data be sparse; densify at read time with `LEFT JOIN calendar × territory` if needed.
- **Warning semantics:** Empty per-date results surface as warnings like `"2026-04-20: no data available from any source"`. These are NOT errors; the jutsu stores them in the run log and moves on.

To verify the MCP is up before kicking off a run:
```bash
curl -sS -X POST http://127.0.0.1:8090/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | sed -n 's/^data: //p' | jq '.result.tools | length'
# Expect: 29
```
