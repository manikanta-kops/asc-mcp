#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppStoreConnectClient } from '../src/services/index.js';

const client = new AppStoreConnectClient({
  keyId: process.env.APP_STORE_CONNECT_KEY_ID!,
  issuerId: process.env.APP_STORE_CONNECT_ISSUER_ID!,
  privateKeyPath: process.env.APP_STORE_CONNECT_P8_PATH!,
  vendorNumber: process.env.APP_STORE_CONNECT_VENDOR_NUMBER,
});

const stateDir = path.resolve(process.cwd(), '.state');
const files = ['bootstrap.json', 'bootstrap-ongoing.json'];

const MS_H = 3_600_000;

function fmtDuration(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  const totalMin = Math.floor(abs / 60_000);
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${sign}${d}d${h}h`;
  if (h > 0) return `${sign}${h}h${m}m`;
  return `${sign}${m}m`;
}

async function fetchAllReports(requestId: string): Promise<any[]> {
  const all: any[] = [];
  let url: string | null = `/analyticsReportRequests/${requestId}/reports`;
  let params: Record<string, any> | undefined = { limit: 200 };
  while (url) {
    const page: any = await client.get<any>(url, params);
    all.push(...(page.data ?? []));
    const next: string | undefined = page.links?.next;
    if (!next) break;
    url = next;
    params = undefined;
  }
  return all;
}

type CatStat = { total: number; withInstances: number; totalInstances: number };

for (const f of files) {
  const p = path.join(stateDir, f);
  let rec: any;
  try {
    rec = JSON.parse(await fs.readFile(p, 'utf8'));
  } catch (e: any) {
    console.log(`\n=== ${f} ===`);
    console.log(`(missing or unreadable: ${e.message ?? e})`);
    continue;
  }

  const now = new Date();
  const created = new Date(rec.createdAt);
  const age = now.getTime() - created.getTime();
  const warmupLow = new Date(created.getTime() + 24 * MS_H);
  const warmupHigh = new Date(created.getTime() + 48 * MS_H);

  console.log(`\n=== ${f}  [${rec.accessType}] ===`);
  console.log(`requestId: ${rec.requestId}`);
  console.log(`appId:     ${rec.appId}`);
  console.log(`created:   ${rec.createdAt}  (${fmtDuration(age)} ago)`);
  console.log(`warm-up:   24h @ ${warmupLow.toISOString()}   48h @ ${warmupHigh.toISOString()}`);
  if (now < warmupLow) {
    console.log(`           → inside the 24h lower bound (${fmtDuration(warmupLow.getTime() - now.getTime())} until 24h)`);
  } else if (now < warmupHigh) {
    console.log(`           → past 24h, within 48h window (${fmtDuration(warmupHigh.getTime() - now.getTime())} until 48h)`);
  } else {
    console.log(`           → past the 48h upper bound by ${fmtDuration(now.getTime() - warmupHigh.getTime())}`);
  }

  try {
    const req = await client.get<any>(`/analyticsReportRequests/${rec.requestId}`);
    const stopped = req.data?.attributes?.stoppedDueToInactivity;
    const stoppedNote = stopped ? '  ⚠ request halted — POST a new analyticsReportRequests to resume' : '';
    console.log(`stoppedDueToInactivity: ${stopped}${stoppedNote}`);
  } catch (e: any) {
    console.log(`request fetch error: ${e.message ?? e}`);
  }

  let reports: any[] = [];
  try {
    reports = await fetchAllReports(rec.requestId);
  } catch (e: any) {
    console.log(`reports fetch error: ${e.message ?? e}`);
    continue;
  }

  console.log(`\nreport definitions: ${reports.length}`);
  if (!reports.length) {
    console.log(`  (Apple has not populated the report catalog for this request yet)`);
    continue;
  }

  const byCat: Record<string, CatStat> = {};
  let totalWithInstances = 0;
  let totalInstances = 0;
  for (const r of reports) {
    const cat = r.attributes?.category ?? 'UNKNOWN';
    const ic = r.attributes?.instancesCount ?? 0;
    byCat[cat] ??= { total: 0, withInstances: 0, totalInstances: 0 };
    byCat[cat].total++;
    byCat[cat].totalInstances += ic;
    totalInstances += ic;
    if (ic > 0) {
      byCat[cat].withInstances++;
      totalWithInstances++;
    }
  }

  console.log(`reports with ≥1 instance: ${totalWithInstances} / ${reports.length}`);
  console.log(`total instances across all reports: ${totalInstances}`);
  console.log(`by category  (withInstances / total, instances):`);
  for (const [cat, s] of Object.entries(byCat).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${cat.padEnd(24)} ${String(s.withInstances).padStart(3)} / ${String(s.total).padEnd(3)}   (${s.totalInstances} instances)`);
  }

  const sample = reports.find((r: any) => (r.attributes?.instancesCount ?? 0) > 0);
  if (sample) {
    console.log(`\nsample produced report: "${sample.attributes?.name}" [${sample.attributes?.category}]  — ${sample.attributes?.instancesCount} instances`);
    try {
      const inst: any = await client.get<any>(`/analyticsReports/${sample.id}/instances`, { limit: 50 });
      const items: any[] = inst.data ?? [];
      const byGran: Record<string, { count: number; minDate?: string; maxDate?: string }> = {};
      for (const i of items) {
        const g = i.attributes?.granularity ?? 'UNKNOWN';
        const d = i.attributes?.processingDate ?? '';
        byGran[g] ??= { count: 0 };
        byGran[g].count++;
        if (d) {
          if (!byGran[g].minDate || d < byGran[g].minDate) byGran[g].minDate = d;
          if (!byGran[g].maxDate || d > byGran[g].maxDate) byGran[g].maxDate = d;
        }
      }
      console.log(`  instances by granularity (of first ${items.length}):`);
      for (const [g, s] of Object.entries(byGran)) {
        console.log(`    ${g.padEnd(10)} ${s.count}  (${s.minDate ?? '?'} → ${s.maxDate ?? '?'})`);
      }
      const firstInst = items[0];
      if (firstInst) {
        try {
          const segs: any = await client.get<any>(`/analyticsReportInstances/${firstInst.id}/segments`, { limit: 50 });
          const sItems: any[] = segs.data ?? [];
          const bytes = sItems.reduce((n, x) => n + (x.attributes?.sizeInBytes ?? 0), 0);
          console.log(`  first instance ${firstInst.id} [${firstInst.attributes?.granularity} ${firstInst.attributes?.processingDate}]: ${sItems.length} downloadable segment(s), ${(bytes / 1024).toFixed(1)} KB total`);
        } catch (e: any) {
          console.log(`  segments fetch error: ${e.message ?? e}`);
        }
      }
    } catch (e: any) {
      console.log(`  instances fetch error: ${e.message ?? e}`);
    }
  }

  console.log(`\nverdict:`);
  if (totalInstances === 0) {
    if (now < warmupHigh) {
      console.log(`  ⏳ warming up — zero report instances so far. Apple's 24-48h window ends ${warmupHigh.toISOString()} (${fmtDuration(warmupHigh.getTime() - now.getTime())} from now). No files to download yet.`);
    } else {
      console.log(`  ❗ past the 48h warm-up and still zero instances. Re-check stoppedDueToInactivity and that the app/team has analytics access.`);
    }
  } else if (rec.accessType === 'ONE_TIME_SNAPSHOT') {
    const pct = Math.round((100 * totalWithInstances) / reports.length);
    if (totalWithInstances === reports.length) {
      console.log(`  ✅ snapshot complete — every one of the ${reports.length} report definitions has at least one instance (${totalInstances} total). Files are ready to fetch via /analyticsReports/{id}/instances → /analyticsReportInstances/{id}/segments.`);
    } else {
      console.log(`  🟡 partial — ${totalWithInstances}/${reports.length} reports (${pct}%) have instances, ${totalInstances} total. Snapshots typically fill in over the 24-48h window; re-check after ${warmupHigh.toISOString()}.`);
    }
  } else {
    console.log(`  ✅ ongoing feed active — ${totalInstances} instances across ${totalWithInstances}/${reports.length} reports. ONGOING requests keep producing indefinitely; re-run later to see newer processingDates.`);
  }
}
