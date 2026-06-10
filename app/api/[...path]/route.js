import { Readable } from 'node:stream';
import server from '@/server';

// Node.js 런타임(메모리/Mongo/네이티브 의존) · 캐싱 없음 · 함수 최대 실행시간(Pro 기준)
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// 기존 server.js의 handle(req,res)를 그대로 재사용 — Node http req/res를 흉내내 어댑트
async function adapt(request) {
  const url = new URL(request.url);
  const method = request.method;

  let bodyStr = '';
  if (method !== 'GET' && method !== 'HEAD') {
    try { bodyStr = await request.text(); } catch (_) { bodyStr = ''; }
  }

  // readBody(req)가 req.on('data'/'end')를 쓰므로 Readable 스트림으로 흉내
  const req = Readable.from(bodyStr ? [bodyStr] : []);
  req.url = url.pathname + url.search;
  req.method = method;
  req.headers = { host: url.host };

  let status = 200;
  let headers = {};
  let body = '';

  await new Promise((resolve) => {
    const res = {
      writeHead(code, hdrs) { status = code; if (hdrs) headers = { ...headers, ...hdrs }; return res; },
      setHeader(k, v) { headers[k] = v; },
      end(chunk) { if (chunk != null) body = Buffer.isBuffer(chunk) ? chunk : String(chunk); resolve(); },
    };
    Promise.resolve(server.handle(req, res)).catch((e) => {
      status = 500;
      headers['Content-Type'] = 'application/json; charset=utf-8';
      body = JSON.stringify({ ok: false, error: String((e && e.message) || e) });
      resolve();
    });
  });

  return new Response(body, { status, headers });
}

export const GET = adapt;
export const POST = adapt;
export const PUT = adapt;
export const DELETE = adapt;
