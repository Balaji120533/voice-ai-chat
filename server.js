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

// Ask Ollama and stream the reply back to the browser
function askOllama(clientWs, history, userText) {
  return new Promise((resolve) => {
    try {
      // Convert chat history from Gemini format → Ollama format
      const messages = history.map(h => ({
        role: h.role === 'model' ? 'assistant' : 'user',
        content: h.parts[0].text,
      }));
      messages.push({ role: 'user', content: userText });

      const body = JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true });

      const req = http.request(
        { hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          if (res.statusCode !== 200) {
            let errText = '';
            res.on('data', d => errText += d);
            res.on('end', () => {
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
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete last line
                                                                                                     
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
            if (clientWs.readyState === WebSocket.OPEN)
              clientWs.send(JSON.stringify({ type: 'ai_done', full: fullReply }));
            resolve(fullReply || null);
          });
        }
      );

      req.on('error', (err) => {
        console.error('Ollama error:', err.message);
        if (clientWs.readyState === WebSocket.OPEN)
          clientWs.send(JSON.stringify({ type: 'error', message: 'Ollama error: ' + err.message }));
        resolve(null);
      });
      req.write(body);
      req.end();
    } catch (err) {
      console.error('Ollama error:', err.message);
      if (clientWs.readyState === WebSocket.OPEN)
        clientWs.send(JSON.stringify({ type: 'error', message: 'Ollama error: ' + err.message }));
      resolve(null);
    }
  });
}

// WebSocket proxy: browser <-> Deepgram, with Gemini chat
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
  console.log('Browser connected — opening Deepgram stream');

  // Conversation history for this session
  const chatHistory = [];

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
      // Send user message to browser
      clientWs.send(JSON.stringify({ type: 'user_message', text }));

      // Add to history and ask Ollama
      chatHistory.push({ role: 'user', parts: [{ text }] });
      const reply = await askOllama(clientWs, chatHistory.slice(0, -1), text);

      if (reply) {
        chatHistory.push({ role: 'model', parts: [{ text: reply }] });
      }
    } else {
      // Interim result — show as typing indicator
      clientWs.send(JSON.stringify({ type: 'interim', text }));
    }
  });

  // Forward browser audio → Deepgram; handle JSON control messages
  clientWs.on('message', async (data, isBinary) => {
    if (!isBinary) {
      // Text frame = JSON control message from browser
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'force_send' && msg.text) {
          // User stopped mic with pending interim text — treat as final transcript
          clientWs.send(JSON.stringify({ type: 'user_message', text: msg.text }));
          chatHistory.push({ role: 'user', parts: [{ text: msg.text }] });
          const reply = await askOllama(clientWs, chatHistory.slice(0, -1), msg.text);
          if (reply) chatHistory.push({ role: 'model', parts: [{ text: reply }] });
        }
      } catch { /* ignore unknown text frames */ }
      return;
    }
    // Binary frame = audio PCM → forward to Deepgram
    if (dgWs.readyState === WebSocket.OPEN) dgWs.send(data);
  });

  clientWs.on('close', () => {
    console.log('Browser disconnected');
    if (dgWs.readyState === WebSocket.OPEN) dgWs.close();
  });

  dgWs.on('close', () => {
    // Deepgram closed (e.g. mic stopped) — don't force-close client;
    // it will close itself after the AI finishes responding.
    console.log('Deepgram stream closed');
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
