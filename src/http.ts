#!/usr/bin/env node

import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AppStoreConnectServer } from './index.js';

const PORT = Number(process.env.PORT ?? 8090);
const HOST = process.env.HOST ?? '127.0.0.1';

const jsonError = (res: http.ServerResponse, status: number, code: number, message: string) => {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
  );
};

const httpServer = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }

  if (req.method !== 'POST') {
    jsonError(res, 405, -32000, 'Method not allowed.');
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    jsonError(res, 400, -32700, 'Parse error');
    return;
  }

  // Stateless: fresh server + transport per request. Keeps initialize idempotent
  // and avoids cross-client state pollution. Overhead is negligible on localhost.
  const server = new AppStoreConnectServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('Error handling MCP request:', err);
    jsonError(res, 500, -32603, 'Internal server error');
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(`App Store Connect MCP HTTP server listening on http://${HOST}:${PORT}/mcp`);
});
