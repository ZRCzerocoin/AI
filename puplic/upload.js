/*
Client-side: extracts text from PDF in the browser (using PDF.js) and posts JSON chunks to /upload.
This file uses a tiny PDF text extraction approach if pdf.js is available.
For large PDF support include PDF.js library on the page.
*/
async function arrayBufferFromFile(file) {
  return await file.arrayBuffer();
}

async function extractTextWithPdfJS(arrayBuffer) {
  if (typeof window.pdfjsLib === 'undefined') {
    return null;
  }
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items.map(i => i.str).join(' ');
    text += '\n\n' + pageText;
  }
  return text;
}

function chunkText(text, maxChars = 1500) {
  const out = [];
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
  return out;
}

document.getElementById('btn').addEventListener('click', async () => {
  const f = document.getElementById('file').files[0];
  if (!f) return alert('Pick a PDF file first');
  const status = document.getElementById('status');
  status.innerText = 'Reading file...';
  const buf = await arrayBufferFromFile(f);
  status.innerText = 'Trying to extract text (if pdf.js loaded)...';
  let text = await extractTextWithPdfJS(buf);
  if (!text) {
    status.innerText = 'No pdf.js found. Uploading raw file to server (you will need to extract text server-side later).';
    const res = await fetch('/upload', { method: 'POST', headers: { 'x-filename': f.name }, body: buf });
    const j = await res.json();
    status.innerText = 'Raw file saved to R2: ' + (j.id || JSON.stringify(j));
    return;
  }
  status.innerText = 'Text extracted. Chunking and uploading...';
  const chunks = chunkText(text, 1500);
  const apiKey = prompt('Enter your API key (stored only in your browser session):');
  for (let i = 0; i < chunks.length; i++) {
    const body = { title: f.name + ' — chunk ' + i, text: chunks[i] };
    await fetch('/upload', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }, body: JSON.stringify(body) });
    status.innerText = `Uploaded chunk ${i+1}/${chunks.length}`;
  }
  status.innerText = 'All chunks uploaded!';
});

document.getElementById('ask').addEventListener('click', async () => {
  const q = document.getElementById('q').value;
  const apiKey = prompt('API key for chat:');
  const res = await fetch('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }, body: JSON.stringify({ messages: [{ role: 'user', content: q }], retrieve_docs: true })});
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  document.getElementById('answer').innerText = out;
});
