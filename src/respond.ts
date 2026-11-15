// Small response helpers shared by the four surface handlers.

import type { ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length), ...headers });
  res.end(body);
}

export function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), ...headers });
  res.end(body);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers);
  res.end();
}
