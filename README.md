# my-worker-ai

This repository contains a Cloudflare Worker and a small public UI to upload PDFs and let the Worker "learn" them (store embeddings & snippets) so you can query later.

## What is included
- `src/index.ts` — Worker code (upload, ingest, chat with retrieval)
- `src/embed.ts` — helper to call embeddings API (uses WORKER_AI_ENDPOINT and WORKER_AI_KEY)
- `src/chat.ts` — simple retrieval + chat completion helper
- `public/` — small UI to upload PDFs and ask questions
- `wrangler.toml` — minimal bindings (fill in your KV/R2 ids in the Dashboard)

## Important: Secrets (Cloudflare Dashboard only)
Do NOT put your API key in code. Add these in Cloudflare Dashboard > Workers > Your Worker > Settings > Variables:
- `WORKER_AI_KEY` = your Cloudflare AI API token
- `WORKER_AI_ENDPOINT` = your AI run endpoint base (e.g. https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/run)

## How to deploy (no terminal)
1. Create a GitHub repository and upload this project using the GitHub web UI (click "Add file" > "Upload files").
2. For static `public/` site: use Cloudflare Pages connected to the GitHub repo (deploy `public/` as the site). For the Worker:
   - Open Cloudflare Dashboard > Workers > Create a Worker
   - Open the Quick Editor and paste the contents of `src/index.ts` (single-file worker) into the editor.
   - Under Settings > Variables add `WORKER_AI_KEY` and `WORKER_AI_ENDPOINT` as **Secrets**.
   - In the Worker editor, configure bindings for KV and R2 (EMBEDS_KV, DOCS_KV, API_KEYS_KV, R2_BUCKET).
   - Save & Deploy.
3. Alternatively, if you prefer to use Wrangler (CLI), follow the standard Wrangler deploy flow.

## How to use
- Open the public page and upload a PDF via the UI. If PDF.js is included, the UI will extract text client-side and upload chunks.
- Use the Ask box to query the worker; it will retrieve relevant chunks and call chat completion.

## Notes
- For production, use proper auth, content moderation, and a robust vector DB if you have lots of documents.
- This example is educational and a starting point.
