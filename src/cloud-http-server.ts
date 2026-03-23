#!/usr/bin/env node
/**
 * Cloud HTTP server for n8n-MCP
 *
 * Thin wrapper that accepts n8n credentials via URL params / headers
 * so the server can be deployed to DigitalOcean Apps (or similar)
 * and used from Claude Code / Claude Web without OAuth.
 *
 * Credential passing (checked in order):
 *   1. Headers:  x-n8n-url, x-n8n-key
 *   2. Header:   Authorization: Bearer <key>  (requires N8N_API_URL env or x-n8n-url header)
 *   3. Query:    ?n8n_api_url=…&n8n_api_key=…
 *   4. Env:      N8N_API_URL + N8N_API_KEY  (fallback, all sessions share same creds)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { N8NDocumentationMCPServer } from './mcp/server';
import type { InstanceContext } from './types/instance-context';

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_NAME = 'n8n-mcp-cloud';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: N8NDocumentationMCPServer;
  context: InstanceContext;
}

const sessions = new Map<string, SessionEntry>();

// ── helpers ──────────────────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function headerVal(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (!v) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Extract n8n credentials from request (headers → query → env).
 */
function extractCredentials(req: IncomingMessage): { apiUrl?: string; apiKey?: string } {
  // 1. Headers
  let apiUrl = headerVal(req, 'x-n8n-url');
  let apiKey = headerVal(req, 'x-n8n-key');
  if (apiUrl && apiKey) return { apiUrl, apiKey };

  // 2. Authorization: Bearer <key>
  const auth = headerVal(req, 'authorization');
  if (auth?.startsWith('Bearer ')) {
    apiKey = auth.slice(7);
    apiUrl = apiUrl || headerVal(req, 'x-n8n-url');
  }

  // 3. URL query params
  if (req.url) {
    const url = new URL(req.url, 'http://localhost');
    apiUrl = apiUrl || url.searchParams.get('n8n_api_url') || url.searchParams.get('x-n8n-url') || undefined;
    apiKey = apiKey || url.searchParams.get('n8n_api_key') || url.searchParams.get('x-n8n-key') || undefined;
  }

  // 4. Env fallback
  apiUrl = apiUrl || process.env.N8N_API_URL;
  apiKey = apiKey || process.env.N8N_API_KEY;

  return { apiUrl, apiKey };
}

function setCorsHeaders(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-n8n-url, x-n8n-key, mcp-session-id'
  );
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── HTTP server ──────────────────────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = new URL(req.url || '/', 'http://localhost').pathname;

  if (pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      server: SERVER_NAME,
      sessions: sessions.size,
    });
    return;
  }

  if (pathname !== '/mcp') {
    sendJson(res, 404, { error: 'Not found. MCP endpoint is at /mcp' });
    return;
  }

  try {
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      // Existing session
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.transport.handleRequest(req, res, body);
        return;
      }

      // New session — must be an initialize request
      if (!sessionId && isInitializeRequest(body)) {
        const { apiUrl, apiKey } = extractCredentials(req);

        if (!apiUrl || !apiKey) {
          sendJson(res, 401, {
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message:
                'Missing n8n credentials. Provide via headers (x-n8n-url + x-n8n-key), ' +
                'Authorization: Bearer <key>, or query params (?n8n_api_url=…&n8n_api_key=…)',
            },
            id: null,
          });
          return;
        }

        const context: InstanceContext = {
          n8nApiUrl: apiUrl,
          n8nApiKey: apiKey,
          instanceId: randomUUID(),
        };

        const mcpServer = new N8NDocumentationMCPServer(context);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server: mcpServer, context });
            console.error(`Session ${sid} initialized`);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            const entry = sessions.get(sid)!;
            sessions.delete(sid);
            entry.server.close().catch(() => {});
            console.error(`Session ${sid} closed`);
          }
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
    } else if (req.method === 'GET') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        sendJson(res, 400, { error: 'Invalid or missing session ID' });
        return;
      }
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
    } else if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        sendJson(res, 400, { error: 'Invalid or missing session ID' });
        return;
      }
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
    } else {
      res.writeHead(405);
      res.end('Method not allowed');
    }
  } catch (error) {
    console.error('Error handling request:', error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

httpServer.listen(PORT, () => {
  console.error(`${SERVER_NAME} listening on port ${PORT}`);
  console.error(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.error(`Health check: http://localhost:${PORT}/health`);
});

async function shutdown() {
  console.error('Shutting down...');
  for (const [sid, session] of sessions.entries()) {
    try {
      await session.transport.close();
      await session.server.close();
      sessions.delete(sid);
    } catch (error) {
      console.error(`Error closing session ${sid}:`, error);
    }
  }
  httpServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
