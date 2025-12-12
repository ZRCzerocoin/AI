// index.ts - Cloudflare Worker (TypeScript)
// Endpoints:
// POST /upload  -> accept JSON { title, text } OR binary with x-filename header -> stores to R2 + ingests text embeddings
// POST /chat    -> accepts { messages: [{role,content}], retrieve_docs: boolean } -> responds with streaming model output

export interface Env {
  EMBEDS_KV: KVNamespace;
  DOCS_KV: KVNamespace;
  API_KEYS_KV: KVNamespace;
  RATE_LIMIT_KV?: KVNamespace;
  WORKER_AI_ENDPOINT?: string; // set in Cloudflare Dashboard (Secret)
  WORKER_AI_KEY?: string;      // set in Cloudflare Dashboard (Secret)
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MAX_HISTORY_TOKENS = 3000;

function now() { return Date.now(); }
function errorJson(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

async function requireApiKey(env: Env, req: Request) {
  const auth = req.headers.get('Authorization') || req.headers.get('x-api-key');
  if (!auth) return null;
  const key = auth.replace(/^Bearer\s+/i, '').trim();
  const record = await env.API_KEYS_KV.get(key);
  if (!record) return null;
  try { return JSON.parse(record); } catch { return { userId: record }; }
}

async function rateLimit(env: Env, userId: string) {
  if (!env.RATE_LIMIT_KV) return true;
  const key = `rl:${userId}`;
  const quota = 40;
  const windowSec = 60;
  const raw = await env.RATE_LIMIT_KV.get(key);
  const nowTs = Math.floor(Date.now() / 1000);
  let state = raw ? JSON.parse(raw) : { count: 0, expires: nowTs + windowSec };
  if (state.expires <= nowTs) { state = { count: 0, expires: nowTs + windowSec } }
  if (state.count >= quota) { await env.RATE_LIMIT_KV.put(key, JSON.stringify(state), { expiration: state.expires }); return false; }
  state.count += 1;
  await env.RATE_LIMIT_KV.put(key, JSON.stringify(state), { expiration: state.expires });
  return true;
}

function estimateTokensFromText(text: string) { return Math.ceil(text.length / 4); }
function trimMessages(messages: { role: string; content: string }[], maxTokens = MAX_HISTORY_TOKENS) {
  let total = 0; const kept: typeof messages = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateTokensFromText(messages[i].content);
    if (total + t > maxTokens) break;
    total += t; kept.unshift(messages[i]);
  }
  return kept;
}

function dot(a: number[], b: number[]) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a: number[]) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]*a[i]; return Math.sqrt(s); }
function cosine(a: number[], b: number[]) { const n = norm(a) * norm(b); if (n === 0) return 0; return dot(a,b)/n; }

async function callEmbeddings(env: Env, text: string) {
  if (!env.WORKER_AI_ENDPOINT || !env.WORKER_AI_KEY) throw new Error('WORKER_AI_ENDPOINT or WORKER_AI_KEY not configured');
  const url = `${env.WORKER_AI_ENDPOINT.replace(/\/$/, '')}/embeddings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.WORKER_AI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!res.ok) throw new Error(`embeddings failed: ${res.status}`);
  const j = await res.json();
  return j.data[0].embedding as number[];
}

async function callChatStream(env: Env, messages: { role:string; content:string }[], signal?: AbortSignal) {
  if (!env.WORKER_AI_ENDPOINT || !env.WORKER_AI_KEY) throw new Error('WORKER_AI_ENDPOINT or WORKER_AI_KEY not configured');
  const url = `${env.WORKER_AI_ENDPOINT.replace(/\/$/, '')}/chat/stream`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.WORKER_AI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages }),
    signal,
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`chat failed ${res.status}: ${text}`); }
  return res.body;
}

async function ingestText(env: Env, userId: string, title: string, text: string) {
  const id = `doc:${userId}:${crypto.randomUUID()}`;
  const embedding = await callEmbeddings(env, text);
  const meta = { id, title, createdAt: now(), userId, textSnippet: text.slice(0, 200) };
  await env.DOCS_KV.put(id, JSON.stringify(meta));
  const embKey = `emb:${id}`;
  await env.EMBEDS_KV.put(embKey, JSON.stringify({ id, embedding }));
  return id;
}

async function saveFileToR2(env: Env, userId: string, filename: string, data: ArrayBuffer) {
  const key = `file:${userId}/${Date.now()}-${filename}`;
  await env.R2_BUCKET.put(key, data);
  const meta = { id: key, filename, userId, createdAt: now() };
  await env.DOCS_KV.put(key, JSON.stringify(meta));
  return key;
}

async function retrieveSimilar(env: Env, queryEmbedding: number[], k=4) {
  const list = [];
  for await (const key of env.EMBEDS_KV.list({ prefix: 'emb:' })) {
    const v = await env.EMBEDS_KV.get(key.name);
    if (!v) continue;
    const parsed = JSON.parse(v);
    const sim = cosine(queryEmbedding, parsed.embedding);
    list.push({ id: parsed.id, sim });
  }
  list.sort((a,b) => b.sim - a.sim);
  const top = list.slice(0,k);
  const results = [];
  for (const t of top) {
    const meta = await env.DOCS_KV.get(t.id);
    results.push({ id: t.id, sim: t.sim, meta: meta ? JSON.parse(meta) : null });
  }
  return results;
}

async function moderateText(env: Env, text: string) {
  const lower = text.toLowerCase();
  const blocked = ['<script', 'eval(', 'password', 'suicide', 'bomb'];
  for (const b of blocked) if (lower.includes(b)) return { ok: false, reason: 'content blocked by heuristics' };
  return { ok: true };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
  } as Record<string,string>;
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    try {
      const user = await requireApiKey(env, request);
      if (!user) return errorJson('Unauthorized', 401);
      if (!await rateLimit(env, user.userId)) return errorJson('Rate limit exceeded', 429);

      if (url.pathname === '/upload' && request.method === 'POST') return await handleUpload(request, env, user.userId);
      if (url.pathname === '/chat' && request.method === 'POST') return await handleChat(request, env, user.userId);
      if (url.pathname === '/docs' && request.method === 'GET') return await handleListDocs(request, env, user.userId);
      return new Response('Not found', { status: 404 });
    } catch (err: any) {
      console.error('worker error', err);
      return errorJson(err?.message || String(err), 500);
    }
  }
}

async function handleUpload(request: Request, env: Env, userId: string) {
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    const body = await request.json();
    const { title = 'uploaded-text', text } = body;
    if (!text) return errorJson('Missing text');
    const mod = await moderateText(env, text);
    if (!mod.ok) return errorJson(`rejected: ${mod.reason}`, 400);
    const id = await ingestText(env, userId, title, text);
    return new Response(JSON.stringify({ id }), { status: 201, headers: { ...JSON_HEADERS, ...corsHeaders() } });
  }
  const filename = request.headers.get('x-filename');
  if (filename) {
    const buf = await request.arrayBuffer();
    const key = await saveFileToR2(env, userId, filename, buf);
    return new Response(JSON.stringify({ id: key }), { status: 201, headers: { ...JSON_HEADERS, ...corsHeaders() } });
  }
  return errorJson('Unsupported upload content type. Send JSON {title, text} or binary with x-filename header');
}

async function handleListDocs(request: Request, env: Env, userId: string) {
  const docs = [] as any[];
  for await (const item of env.DOCS_KV.list({ prefix: `doc:${userId}:` })) {
    const v = await env.DOCS_KV.get(item.name);
    if (v) docs.push(JSON.parse(v));
  }
  for await (const obj of env.R2_BUCKET.list({ prefix: `file:${userId}/` })) {
    const meta = await env.DOCS_KV.get(obj.key);
    docs.push(meta ? JSON.parse(meta) : { id: obj.key, filename: obj.key });
  }
  return new Response(JSON.stringify({ docs }), { headers: { ...JSON_HEADERS, ...corsHeaders() } });
}

async function handleChat(request: Request, env: Env, userId: string) {
  const body = await request.json();
  let { messages = [], retrieve_docs = true } = body;
  if (!Array.isArray(messages)) return errorJson('messages array required');
  messages = messages.map((m: any) => ({ role: String(m.role), content: String(m.content) }));
  for (const m of messages) {
    if (m.role === 'user') {
      const ok = await moderateText(env, m.content);
      if (!ok.ok) return errorJson(`Message rejected: ${ok.reason}`);
    }
  }
  messages = trimMessages(messages);
  if (retrieve_docs) {
    const latestUser = [...messages].reverse().find((m:any)=>m.role==='user');
    if (latestUser) {
      const qEmb = await callEmbeddings(env, latestUser.content);
      const similar = await retrieveSimilar(env, qEmb, 4);
      if (similar.length) {
        for (const s of similar) {
          if (s.meta && s.meta.textSnippet) {
            messages.unshift({ role: 'system', content: `Document(${s.id}) context: ${s.meta.textSnippet}` });
          }
        }
      }
    }
  }
  const controller = new AbortController();
  request.signal.addEventListener('abort', () => { controller.abort(); });
  let modelStream: ReadableStream<Uint8Array> | null = null;
  try { modelStream = await callChatStream(env, messages, controller.signal); } catch (err: any) { return errorJson(`model error: ${err.message}`); }
  const stream = new ReadableStream({
    async start(rs) {
      const reader = modelStream!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          rs.enqueue(value);
        }
        rs.close();
      } catch (e) {
        rs.error(e);
      } finally {
        reader.releaseLock();
      }
    },
    cancel() { try { controller.abort(); } catch (e) { /* ignore */ } }
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', ...corsHeaders() } });
}
