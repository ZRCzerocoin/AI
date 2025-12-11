import { embedText } from './embed';

function dot(a: number[], b: number[]) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a: number[]) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]*a[i]; return Math.sqrt(s); }
function cosine(a: number[], b: number[]) { const n = norm(a)*norm(b); if (n === 0) return 0; return dot(a,b)/n; }

export async function answerChat(question: string, env: any) {
  const list = await env.EMBEDS_KV.list();
  const questionVec = await embedText(question, env);
  let best = { text: '', score: -Infinity };
  for (const key of list.keys) {
    const data = await env.EMBEDS_KV.get(key.name, 'json');
    if (!data) continue;
    const sim = cosine(data.embedding, questionVec);
    if (sim > best.score) best = { text: data.text, score: sim };
  }
  const res = await fetch(`${env.WORKER_AI_ENDPOINT.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.WORKER_AI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Answer using the provided context.' },
        { role: 'system', content: best.text },
        { role: 'user', content: question }
      ]
    })
  });
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? '';
}
