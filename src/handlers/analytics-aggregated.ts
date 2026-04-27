import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppStoreConnectClient, BinaryResponse, parseGzippedDelimited, normalizeRow } from '../services/index.js';
import { AnalyticsHandlers } from './analytics.js';
import {
  AnalyticsReport,
  AnalyticsReportInstance,
  AnalyticsReportSegment,
} from '../types/index.js';

// --- Public tool input/output shapes ---------------------------------------

export interface EngagementInput {
  app_id: string;
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  request_id?: string; // explicit override
}

export interface EngagementRow {
  date: string;
  app_id: string;
  territory: string;
  source: string;
  impressions: number;
  product_page_views: number;
  downloads: number;
  conversion_rate: number;
}

export interface EngagementOutput {
  rows: EngagementRow[];
  warnings: string[];
  meta: {
    request_id?: string; // last used
    date_range: { from: string; to: string };
    row_count: number;
    apple_report_name?: string;
    sources_used: { ongoing: number; snapshot: number };
    rate_limit_remaining?: number;
  };
}

export interface SalesInput {
  app_id?: string; // optional filter; Sales returns all apps for the vendor
  from: string;
  to: string;
  vendor_number?: string;
  version?: string; // optional override: "1_0" | "1_1"
}

export interface SalesRow {
  date: string;
  app_id: string;
  territory: string;
  units: number;
  proceeds_usd: number;
  sku?: string;
}

export interface SalesOutput {
  rows: SalesRow[];
  warnings: string[];
  meta: {
    vendor_number: string;
    date_range: { from: string; to: string };
    row_count: number;
    rate_limit_remaining?: number;
  };
}

// --- Caps ------------------------------------------------------------------

const MAX_RANGE_DAYS = 90;
const APPLE_LAG_DAYS = 2; // "Data is complete two days after the reporting date."
const INTER_CALL_DELAY_MS = 250; // under the ~300/min soft cap

// --- Bootstrap state -------------------------------------------------------

interface BootstrapFile {
  requestId: string;
  appId: string;
  accessType: 'ONGOING' | 'ONE_TIME_SNAPSHOT';
  createdAt: string;
}

interface Bootstraps {
  ongoing?: BootstrapFile;
  snapshot?: BootstrapFile;
}

function stateDir(): string {
  if (process.env.STATE_DIR) return process.env.STATE_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  // This file compiles to dist/src/handlers/analytics-aggregated.js, so repo root = ../../..
  // In TS it lives at src/handlers/, so repo root = ../../
  // Resolving via both candidates keeps it robust.
  const candidates = [resolve(here, '../../../.state'), resolve(here, '../../.state')];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0]; // default for error messaging
}

export function loadBootstraps(): Bootstraps {
  const dir = stateDir();
  const out: Bootstraps = {};
  const ongoingPath = resolve(dir, 'bootstrap-ongoing.json');
  const snapshotPath = resolve(dir, 'bootstrap.json');

  if (existsSync(ongoingPath)) {
    try {
      out.ongoing = JSON.parse(readFileSync(ongoingPath, 'utf8')) as BootstrapFile;
    } catch {
      // ignore malformed file; caller will error if neither is usable
    }
  }
  if (existsSync(snapshotPath)) {
    try {
      out.snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as BootstrapFile;
    } catch {
      // ignore
    }
  }
  return out;
}

// --- Date utilities --------------------------------------------------------

function parseIsoDate(s: string): Date {
  const d = new Date(`${s}T00:00:00Z`);
  if (isNaN(d.getTime())) throw new Error(`invalid date: ${s}`);
  return d;
}

function formatIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function enumerateDates(from: string, to: string): string[] {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (start > end) return [];
  const out: string[] = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(formatIsoDate(d));
  }
  return out;
}

function clampToCompletenessWindow(to: string): { clamped: string; warning?: string } {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const safeCeiling = new Date(today);
  safeCeiling.setUTCDate(safeCeiling.getUTCDate() - APPLE_LAG_DAYS);
  const requested = parseIsoDate(to);
  if (requested > safeCeiling) {
    return {
      clamped: formatIsoDate(safeCeiling),
      warning: `'to' clamped from ${to} to ${formatIsoDate(safeCeiling)} (Apple completeness window is T-${APPLE_LAG_DAYS}d)`,
    };
  }
  return { clamped: to };
}

function validateRange(from: string, to: string): { warnings: string[] } {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  const span = daysBetween(start, end) + 1;
  if (span > MAX_RANGE_DAYS) {
    throw new Error(`range ${from}..${to} is ${span} days; max is ${MAX_RANGE_DAYS}`);
  }
  if (span < 1) {
    throw new Error(`range ${from}..${to} is empty (from > to)`);
  }
  return { warnings: [] };
}

// --- Rate-limit bookkeeping ------------------------------------------------

function readRateRemaining(headers: Record<string, string>): number | undefined {
  // Apple returns "x-rate-limit: user-hour-lim:3600;user-hour-rem:N;"
  const raw = headers['x-rate-limit'];
  if (!raw) return undefined;
  const match = /user-hour-rem:(\d+)/.exec(raw);
  return match ? Number(match[1]) : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

// --- Engagement aggregation ------------------------------------------------

// Candidate header names for each output field. Apple's column names have drifted
// historically; trying multiple keeps us resilient to that without silently
// miscategorizing. Order = priority (first match wins).
const ENGAGEMENT_FIELD_CANDIDATES: Record<keyof Omit<EngagementRow, 'date' | 'app_id' | 'territory' | 'source'>, string[]> = {
  impressions: ['impressions_unique_devices', 'impressions'],
  product_page_views: ['product_page_views_unique_devices', 'product_page_views'],
  downloads: ['total_downloads', 'first_time_downloads', 'downloads'],
  conversion_rate: ['conversion_rate'],
};

const ENGAGEMENT_DATE_CANDIDATES = ['date', 'processing_date'];
const ENGAGEMENT_APP_CANDIDATES = ['app_apple_identifier', 'app_id', 'apple_identifier'];
const ENGAGEMENT_TERRITORY_CANDIDATES = ['territory', 'country_code'];
const ENGAGEMENT_SOURCE_CANDIDATES = ['source', 'source_type', 'traffic_source'];

function pickField(row: Record<string, string>, candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (row[c] !== undefined && row[c] !== '') return row[c];
  }
  return undefined;
}

function toNumber(v: string | undefined): number {
  if (v == null || v === '') return 0;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export async function getDailyEngagement(
  client: AppStoreConnectClient,
  analytics: AnalyticsHandlers,
  input: EngagementInput,
): Promise<EngagementOutput> {
  if (!input.app_id) throw new Error('app_id is required');
  const rangeWarnings: string[] = [];
  const clampResult = clampToCompletenessWindow(input.to);
  if (clampResult.warning) rangeWarnings.push(clampResult.warning);
  const toClamped = clampResult.clamped;
  validateRange(input.from, toClamped);

  const bootstraps = loadBootstraps();
  const explicit = input.request_id;
  const hasOngoing = !!bootstraps.ongoing;
  const hasSnapshot = !!bootstraps.snapshot;

  if (!explicit && !hasOngoing && !hasSnapshot) {
    throw new Error(
      "no bootstrap request found; run 'bun run bootstrap:ongoing' (and/or 'bun run bootstrap:snapshot')",
    );
  }

  // Sources: ordered list of (label, requestId) to try per date.
  // If caller gave explicit, only use that. Otherwise ONGOING first, SNAPSHOT fallback.
  const sources: Array<{ label: 'ongoing' | 'snapshot' | 'explicit'; requestId: string }> = [];
  if (explicit) {
    sources.push({ label: 'explicit', requestId: explicit });
  } else {
    if (bootstraps.ongoing) sources.push({ label: 'ongoing', requestId: bootstraps.ongoing.requestId });
    if (bootstraps.snapshot) sources.push({ label: 'snapshot', requestId: bootstraps.snapshot.requestId });
  }

  // Cache the engagement report per source (the schema list doesn't change during a call).
  const reportCache = new Map<string, AnalyticsReport | undefined>();
  let lastRateRemaining: number | undefined;
  let reportNameLogged: string | undefined;
  const sourcesUsed = { ongoing: 0, snapshot: 0 };
  const warnings = [...rangeWarnings];
  const rows: EngagementRow[] = [];

  async function resolveEngagementReport(requestId: string): Promise<AnalyticsReport | undefined> {
    if (reportCache.has(requestId)) return reportCache.get(requestId);
    const reports = await analytics.listAllAnalyticsReports({
      reportRequestId: requestId,
      filter: { category: 'APP_STORE_ENGAGEMENT' },
    });
    // Prefer the "Discovery and Engagement" daily report; Apple's exact name may drift.
    // Match case-insensitive on both "discovery" AND "engagement" in the name.
    const picked =
      reports.find(r => {
        const n = r.attributes.name.toLowerCase();
        return n.includes('discovery') && n.includes('engagement');
      }) ?? reports[0];
    reportCache.set(requestId, picked);
    if (picked && !reportNameLogged) reportNameLogged = picked.attributes.name;
    return picked;
  }

  const dates = enumerateDates(input.from, toClamped);
  for (const date of dates) {
    let dateHandled = false;

    for (const source of sources) {
      try {
        const report = await resolveEngagementReport(source.requestId);
        await sleep(INTER_CALL_DELAY_MS);
        if (!report) {
          warnings.push(`${date}: no APP_STORE_ENGAGEMENT report on ${source.label}`);
          continue;
        }

        const instancesResp = await analytics.listAnalyticsReportInstances({
          reportId: report.id,
          granularity: 'DAILY',
          processingDate: date,
        });
        await sleep(INTER_CALL_DELAY_MS);
        const instance: AnalyticsReportInstance | undefined = instancesResp.data?.[0];
        if (!instance) {
          // This source doesn't have it; fall through to next source.
          continue;
        }

        const segmentsResp = await analytics.listSegmentsForInstance({ instanceId: instance.id });
        await sleep(INTER_CALL_DELAY_MS);
        const segments: AnalyticsReportSegment[] = segmentsResp.data ?? [];
        if (segments.length === 0) {
          warnings.push(`${date}: instance ${instance.id} has no segments (${source.label})`);
          dateHandled = true;
          break;
        }

        for (const seg of segments) {
          const dl: BinaryResponse = await client.downloadBinaryPublic(seg.attributes.url);
          lastRateRemaining = readRateRemaining(dl.headers) ?? lastRateRemaining;
          await sleep(INTER_CALL_DELAY_MS);

          const parsed = parseGzippedDelimited(dl.body, ',').map(normalizeRow);
          for (const raw of parsed) {
            const rowAppId = pickField(raw, ENGAGEMENT_APP_CANDIDATES);
            if (rowAppId && rowAppId !== input.app_id) continue;

            const rowDate = pickField(raw, ENGAGEMENT_DATE_CANDIDATES) ?? date;
            const territory = pickField(raw, ENGAGEMENT_TERRITORY_CANDIDATES);
            const srcLabel = pickField(raw, ENGAGEMENT_SOURCE_CANDIDATES);
            if (!territory || !srcLabel) continue;

            const impressions = toNumber(pickField(raw, ENGAGEMENT_FIELD_CANDIDATES.impressions));
            const productPageViews = toNumber(pickField(raw, ENGAGEMENT_FIELD_CANDIDATES.product_page_views));
            const downloads = toNumber(pickField(raw, ENGAGEMENT_FIELD_CANDIDATES.downloads));
            const convRaw = pickField(raw, ENGAGEMENT_FIELD_CANDIDATES.conversion_rate);
            const conversion_rate = toNumber(convRaw);

            // Skip pure-zero rows to keep payload tight; downstream decides how to densify.
            if (impressions === 0 && productPageViews === 0 && downloads === 0) continue;

            rows.push({
              date: rowDate,
              app_id: input.app_id,
              territory,
              source: srcLabel,
              impressions,
              product_page_views: productPageViews,
              downloads,
              conversion_rate,
            });
          }
        }

        if (source.label === 'ongoing') sourcesUsed.ongoing++;
        else if (source.label === 'snapshot') sourcesUsed.snapshot++;
        dateHandled = true;
        break;
      } catch (err: any) {
        const status = err?.response?.status;
        const detail = err?.response?.data?.errors?.[0]?.detail ?? err?.message ?? String(err);
        if (status === 429) {
          warnings.push(`${date}: rate-limited by Apple (${source.label}); continuing`);
          await sleep(2000);
        } else {
          warnings.push(`${date}: ${source.label} failed: ${detail}`);
        }
      }
    }

    if (!dateHandled) {
      warnings.push(`${date}: no data available from any source`);
    }
  }

  return {
    rows,
    warnings,
    meta: {
      request_id: sources[0]?.requestId,
      date_range: { from: input.from, to: toClamped },
      row_count: rows.length,
      apple_report_name: reportNameLogged,
      sources_used: sourcesUsed,
      rate_limit_remaining: lastRateRemaining,
    },
  };
}

// --- Sales aggregation -----------------------------------------------------

const SALES_DATE_COLS = ['begin_date'];
const SALES_APP_COLS = ['apple_identifier'];
const SALES_TERRITORY_COLS = ['country_code'];
const SALES_UNITS_COLS = ['units'];
const SALES_PROCEEDS_COLS = ['developer_proceeds'];
const SALES_SKU_COLS = ['sku'];

// Convert Apple's "MM/DD/YYYY" begin date to ISO "YYYY-MM-DD".
function salesDateToIso(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d; // already ISO
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return d;
}

export async function getDailySales(
  client: AppStoreConnectClient,
  input: SalesInput,
  defaultVendorNumber?: string,
): Promise<SalesOutput> {
  const vendor = input.vendor_number ?? defaultVendorNumber;
  if (!vendor) throw new Error('vendor_number required (or set APP_STORE_CONNECT_VENDOR_NUMBER)');

  const rangeWarnings: string[] = [];
  // Sales has its own lag behavior but T-1 is typically available; T-2 to be safe.
  const clampResult = clampToCompletenessWindow(input.to);
  if (clampResult.warning) rangeWarnings.push(clampResult.warning);
  const toClamped = clampResult.clamped;
  validateRange(input.from, toClamped);

  const dates = enumerateDates(input.from, toClamped);
  const warnings = [...rangeWarnings];
  const rows: SalesRow[] = [];
  let lastRateRemaining: number | undefined;

  for (const date of dates) {
    const attempts: Array<string | undefined> = input.version
      ? [input.version]
      : [undefined, '1_1', '1_0']; // omit-version first, then try versioned as fallback

    let handled = false;
    let lastError: string | undefined;

    for (const version of attempts) {
      const params: Record<string, string> = {
        'filter[reportType]': 'SALES',
        'filter[reportSubType]': 'SUMMARY',
        'filter[frequency]': 'DAILY',
        'filter[reportDate]': date,
        'filter[vendorNumber]': vendor,
      };
      if (version) params['filter[version]'] = version;

      try {
        const resp: BinaryResponse = await client.getBinary('/salesReports', params);
        lastRateRemaining = readRateRemaining(resp.headers) ?? lastRateRemaining;
        await sleep(INTER_CALL_DELAY_MS);

        if (resp.status === 404) {
          // Decide between "no data" and "bad version".
          const text = resp.body.toString('utf8');
          if (/invalid.*version/i.test(text)) {
            lastError = `version ${version ?? '(none)'} rejected: ${text.slice(0, 200)}`;
            continue; // try next version attempt
          }
          // Genuine no-data case.
          warnings.push(`${date}: no sales data`);
          handled = true;
          break;
        }

        const parsed = parseGzippedDelimited(resp.body, '\t').map(normalizeRow);
        for (const raw of parsed) {
          const rowAppId = pickField(raw, SALES_APP_COLS);
          if (input.app_id && rowAppId !== input.app_id) continue;

          const rawBeginDate = pickField(raw, SALES_DATE_COLS);
          const rowDate = rawBeginDate ? salesDateToIso(rawBeginDate) : date;
          const territory = pickField(raw, SALES_TERRITORY_COLS);
          const units = toNumber(pickField(raw, SALES_UNITS_COLS));
          const proceeds_usd = toNumber(pickField(raw, SALES_PROCEEDS_COLS));
          const sku = pickField(raw, SALES_SKU_COLS);

          if (!territory || !rowAppId) continue;
          if (units === 0 && proceeds_usd === 0) continue;

          rows.push({
            date: rowDate,
            app_id: rowAppId,
            territory,
            units,
            proceeds_usd,
            sku: sku && sku !== '' ? sku : undefined,
          });
        }
        handled = true;
        break;
      } catch (err: any) {
        const status = err?.response?.status;
        const detail = err?.response?.data?.errors?.[0]?.detail ?? err?.message ?? String(err);
        if (status === 429) {
          warnings.push(`${date}: rate-limited by Apple on sales; retrying after backoff`);
          await sleep(2000);
          continue;
        }
        lastError = detail;
      }
    }

    if (!handled && lastError) {
      warnings.push(`${date}: sales fetch failed: ${lastError}`);
    }
  }

  return {
    rows,
    warnings,
    meta: {
      vendor_number: vendor,
      date_range: { from: input.from, to: toClamped },
      row_count: rows.length,
      rate_limit_remaining: lastRateRemaining,
    },
  };
}
