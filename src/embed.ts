export async function embedText(text: string, env: any) {
  if (!env.WORKER_AI_ENDPOINT || !env.WORKER_AI_KEY) throw new Error('WORKER_AI_ENDPOINT or WORKER_AI_KEY not configured');
  const res = await fetch(`${env.WORKER_AI_ENDPOINT.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.WORKER_AI_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text })
  });
  if (!res.ok) throw new Error('embeddings API error');
  const j = await res.json();
  return j.data[0].embedding;
}
