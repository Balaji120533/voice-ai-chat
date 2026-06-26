const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = 3000;
const ROOT = __dirname;

const OLLAMA_MODEL = 'llama3:8b';  // change to any model you have: `ollama list`

// Parse .env
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });
} catch (_) {}

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
if (!DEEPGRAM_API_KEY) {
  console.error('Missing DEEPGRAM_API_KEY in .env');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';

  const filePath = path.join(ROOT, url);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

const DG_URL =
  'wss://api.deepgram.com/v1/listen' +
  '?model=nova-2' +
  '&language=en-IN' +
  '&encoding=linear16' +
  '&sample_rate=16000' +
  '&channels=1' +
  '&interim_results=true' +
  '&smart_format=true' +
  '&punctuate=true';

// Encode a uniform [{role, content}] array as TOON for compact LLM context
function encodeToon(msgs) {
  const rows = msgs.map(m => {
    const content = /[,"\n\r]/.test(m.content)
      ? `"${m.content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
      : m.content;
    return `  ${m.role},${content}`;
  });
  return `messages[${msgs.length}]{role,content}:\n${rows.join('\n')}`;
}

// Ask Ollama and stream the reply back to the browser.
// setAbort(fn) is called with an abort function once the HTTP request is open;
// called with null when the request ends normally.
function askOllama(clientWs, history, userText, setAbort) {
  return new Promise((resolve) => {
    try {
      const ollamaHistory = history.map(h => ({
        role: h.role === 'model' ? 'assistant' : 'user',
        content: h.parts[0].text,
      }));

      let messages;
      if (ollamaHistory.length >= 2) {
        const toon = encodeToon(ollamaHistory);
        messages = [
          { role: 'system', content: `Prior conversation history in TOON format (compact JSON encoding):\n\`\`\`toon\n${toon}\n\`\`\`` },
          { role: 'user', content: userText },
        ];
      } else {
        messages = [...ollamaHistory, { role: 'user', content: userText }];
      }

      const body = JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true });
      let aborted = false;

      const req = http.request(
        { hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          if (res.statusCode !== 200) {
            let errText = '';
            res.on('data', d => errText += d);
            res.on('end', () => {
              setAbort(null);
              const msg = `Ollama ${res.statusCode}: ${errText}`;
              console.error(msg);
              if (clientWs.readyState === WebSocket.OPEN)
                clientWs.send(JSON.stringify({ type: 'error', message: msg }));
              resolve(null);
            });
            return;
          }

          let fullReply = '';
          let buffer = '';
          clientWs.send(JSON.stringify({ type: 'ai_start' }));

          res.on('data', (chunk) => {
            if (aborted) return;
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line);
                const text = obj.message?.content || '';
                if (text) {
                  fullReply += text;
                  if (clientWs.readyState === WebSocket.OPEN)
                    clientWs.send(JSON.stringify({ type: 'ai_chunk', text }));
                }
              } catch { /* skip malformed line */ }
            }
          });

          res.on('end', () => {
            if (aborted) return;
            setAbort(null);
            if (clientWs.readyState === WebSocket.OPEN)
              clientWs.send(JSON.stringify({ type: 'ai_done', full: fullReply }));
            resolve(fullReply || null);
          });
        }
      );

      req.on('error', (err) => {
        setAbort(null);
        if (aborted) {
          // Intentional abort — tell browser generation stopped
          if (clientWs.readyState === WebSocket.OPEN)
            clientWs.send(JSON.stringify({ type: 'ai_stopped' }));
          resolve(null);
          return;
        }
        console.error('Ollama error:', err.message);
        if (clientWs.readyState === WebSocket.OPEN)
          clientWs.send(JSON.stringify({ type: 'error', message: 'Ollama error: ' + err.message }));
        resolve(null);
      });

      // Expose abort so the connection handler can call it on interrupt/disconnect
      setAbort(() => { aborted = true; req.destroy(); });
      req.write(body);
      req.end();
    } catch (err) {
      setAbort(null);
      console.error('Ollama error:', err.message);
      if (clientWs.readyState === WebSocket.OPEN)
        clientWs.send(JSON.stringify({ type: 'error', message: 'Ollama error: ' + err.message }));
      resolve(null);
    }
  });
}

// WebSocket proxy: browser <-> Deepgram, with Ollama chat
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
  console.log('Browser connected — opening Deepgram stream');

  const chatHistory = [];
  let abortOllama = null;
  const setAbort = (fn) => { abortOllama = fn; };

  const dgWs = new WebSocket(DG_URL, { headers: { Authorization: 'Token ' + DEEPGRAM_API_KEY } });

  dgWs.on('open', () => {
    console.log('Deepgram stream open');
    if (clientWs.readyState === WebSocket.OPEN)
      clientWs.send(JSON.stringify({ type: 'ready' }));
  });

  // Forward Deepgram transcript → check if final → ask Ollama
  dgWs.on('message', async (data) => {
    const raw = data.toString();
    if (clientWs.readyState !== WebSocket.OPEN) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
    if (!alt) return;

    const text = alt.transcript;
    if (!text || !text.trim()) return;

    if (msg.is_final) {
      // Abort any in-progress Ollama call before starting a new one
      if (abortOllama) { abortOllama(); abortOllama = null; }
      clientWs.send(JSON.stringify({ type: 'user_message', text }));
      chatHistory.push({ role: 'user', parts: [{ text }] });
      const reply = await askOllama(clientWs, chatHistory.slice(0, -1), text, setAbort);
      if (reply) chatHistory.push({ role: 'model', parts: [{ text: reply }] });
    } else {
      clientWs.send(JSON.stringify({ type: 'interim', text }));
    }
  });

  // Forward browser audio → Deepgram; handle JSON control messages
  clientWs.on('message', async (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'force_send' && msg.text) {
          clientWs.send(JSON.stringify({ type: 'user_message', text: msg.text }));
          chatHistory.push({ role: 'user', parts: [{ text: msg.text }] });
          const reply = await askOllama(clientWs, chatHistory.slice(0, -1), msg.text, setAbort);
          if (reply) chatHistory.push({ role: 'model', parts: [{ text: reply }] });
        } else if (msg.type === 'interrupt') {
          // User clicked mic during generation — abort Ollama immediately
          if (abortOllama) { abortOllama(); abortOllama = null; }
        } else if (msg.type === 'close_deepgram') {
          // Mic stopped with no interim text — flush any buffered audio via CloseStream
          if (dgWs.readyState === WebSocket.OPEN)
            dgWs.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch { /* ignore unknown text frames */ }
      return;
    }
    if (dgWs.readyState === WebSocket.OPEN) dgWs.send(data);
  });

  clientWs.on('close', () => {
    console.log('Browser disconnected');
    if (dgWs.readyState === WebSocket.OPEN) dgWs.close();
    if (abortOllama) { abortOllama(); abortOllama = null; }
  });

  dgWs.on('close', () => {
    console.log('Deepgram stream closed');
    // If no AI call is running, tell the browser nothing is pending so it can clean up
    if (!abortOllama && clientWs.readyState === WebSocket.OPEN)
      clientWs.send(JSON.stringify({ type: 'session_end' }));
  });

  dgWs.on('error', (err) => {
    console.error('Deepgram error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN)
      clientWs.send(JSON.stringify({ type: 'error', message: err.message }));
  });
});

server.listen(PORT, () => {
  console.log('\n  Voice Chat  →  http://localhost:' + PORT + '\n');
});
