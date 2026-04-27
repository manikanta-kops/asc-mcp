#!/usr/bin/env bun
/**
 * One-shot: POST /v1/analyticsReportRequests for HABBY_APP_ID to start
 * Apple's Analytics Reports warm-up clock (~24-48h before the first
 * report instance appears). Saves the request ID to .state/bootstrap.json
 * so later funnel queries can find it.
 *
 * Env vars required (bun auto-loads .env):
 *   APP_STORE_CONNECT_KEY_ID
 *   APP_STORE_CONNECT_ISSUER_ID
 *   APP_STORE_CONNECT_P8_PATH
 *   HABBY_APP_ID
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AppStoreConnectClient } from '../src/services/index.js';

const required = [
  'APP_STORE_CONNECT_KEY_ID',
  'APP_STORE_CONNECT_ISSUER_ID',
  'APP_STORE_CONNECT_P8_PATH',
  'HABBY_APP_ID',
] as const;

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing env: ${key}`);
    process.exit(1);
  }
}

const appId = process.env.HABBY_APP_ID!;

const arg = (process.argv[2] ?? 'snapshot').toLowerCase();
const accessType = arg === 'ongoing' ? 'ONGOING' : 'ONE_TIME_SNAPSHOT';
const stateFilename = accessType === 'ONGOING' ? 'bootstrap-ongoing.json' : 'bootstrap.json';

const client = new AppStoreConnectClient({
  keyId: process.env.APP_STORE_CONNECT_KEY_ID!,
  issuerId: process.env.APP_STORE_CONNECT_ISSUER_ID!,
  privateKeyPath: process.env.APP_STORE_CONNECT_P8_PATH!,
  vendorNumber: process.env.APP_STORE_CONNECT_VENDOR_NUMBER,
});

const body = {
  data: {
    type: 'analyticsReportRequests',
    attributes: { accessType },
    relationships: {
      app: { data: { id: appId, type: 'apps' } },
    },
  },
};

const response = await client.post<{ data: { id: string; attributes: { accessType: string; stoppedDueToInactivity: boolean } } }>(
  '/analyticsReportRequests',
  body,
);

const requestId = response.data.id;
const stateDir = path.resolve(process.cwd(), '.state');
await fs.mkdir(stateDir, { recursive: true });
const statePath = path.join(stateDir, stateFilename);

const record = {
  requestId,
  appId,
  accessType: response.data.attributes.accessType,
  createdAt: new Date().toISOString(),
  raw: response.data,
};
await fs.writeFile(statePath, JSON.stringify(record, null, 2));

console.log(`Bootstrap done. Apple warm-up is 24-48h. Request ID: ${requestId}`);
console.log(`Saved to ${statePath}`);
