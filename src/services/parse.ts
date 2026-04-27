import { gunzipSync } from 'node:zlib';
import { parse as csvParseSync } from 'csv-parse/sync';

// Returns rows as objects keyed by the first row's column names.
// Works for comma (analytics) and tab (sales) delimited payloads.
export function parseGzippedDelimited(
  buffer: Buffer,
  delimiter: ',' | '\t',
): Record<string, string>[] {
  const decompressed = maybeGunzip(buffer);
  const text = decompressed.toString('utf8');
  if (!text.trim()) return [];

  return csvParseSync(text, {
    delimiter,
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    bom: true,
  }) as Record<string, string>[];
}

// Apple reports are always gzipped in the happy path, but be lenient: if the
// first two bytes aren't the gzip magic number, pass through as-is. Saves us
// from a mysterious failure mode if Apple ever serves a non-compressed error body.
function maybeGunzip(buffer: Buffer): Buffer {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return gunzipSync(buffer);
  }
  return buffer;
}

// Snake_case a header from Apple's title-case / space-separated form.
// "Product Page Views (Unique Devices)" -> "product_page_views_unique_devices"
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[()\/]/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

export function normalizeRow(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    out[normalizeHeader(k)] = v;
  }
  return out;
}
