# Voice AI Chat

Speak into your microphone — your words are transcribed in real time and answered by a local AI model. No cloud AI costs; the LLM runs entirely on your machine via Ollama.

## How it works

```
Microphone → AudioWorklet (PCM) → WebSocket → Deepgram STT → Ollama LLM → Chat UI
```

- Browser captures microphone audio and streams raw PCM over WebSocket
- [Deepgram](https://deepgram.com) transcribes the audio in real time (interim + final results)
- Transcribed text is sent to [Ollama](https://ollama.com) — a local LLM with no API costs
- The AI reply streams back word-by-word into the chat UI

## Requirements

- Node.js 16+
- [Ollama](https://ollama.com) installed and running locally
- A Deepgram API key ([free tier](https://console.deepgram.com) gives 200 hours/month)

## Setup

1. **Install dependencies**

   ```
   npm install
   ```

2. **Start Ollama and pull a model**

   ```
   ollama serve
   ollama pull llama3:8b
   ```

   > If `ollama serve` says "address already in use", Ollama is already running — skip it.

3. **Add your Deepgram key**

   ```
   cp .env.example .env
   ```

   Edit `.env` and paste your key:

   ```
   DEEPGRAM_API_KEY=your_key_here
   ```

4. **Start the server**

   ```
   npm start
   ```

5. Open `http://localhost:3000` and allow microphone access.

## Usage

| Action | Result |
|---|---|
| Click 🎙️ | Opens mic, connects to Deepgram |
| Speak | Words appear in real time as you talk |
| Pause speaking | Deepgram finalises the transcript → AI responds |
| Click ⏹️ mid-sentence | Sends whatever you've said so far → AI responds |
| Click ⏹️ while AI is replying | Mic stops; AI **keeps generating** until done |

## Configuration

| Variable in `server.js` | Default | Description |
|---|---|---|
| `OLLAMA_MODEL` | `llama3:8b` | Any model from `ollama list` |
| `PORT` | `3000` | HTTP port |

Deepgram is set to `en-IN` (Indian English). To change language, edit the `language` param in `DG_URL` inside `server.js`. See [Deepgram language codes](https://developers.deepgram.com/docs/language).

## TOON — Compact Context for Faster AI Responses

As a conversation grows, every new message requires the model to re-read the entire chat history. Standard JSON is verbose — each message repeats the same field names (`role`, `content`) over and over. This project uses [TOON (Token-Oriented Object Notation)](https://github.com/toon-format/toon) to compress that history before sending it to Ollama, reducing the number of tokens the model has to process on every turn.

### How it's integrated

When the conversation has 2 or more prior exchanges, the history is encoded as TOON and placed in a system message. Only the latest user message is sent in the standard slot:

<table>
<tr>
<th>Without TOON — verbose JSON</th>
<th>With TOON — same data, fewer tokens</th>
</tr>
<tr>
<td>

```json
[
  { "role": "user",      "content": "what is photosynthesis" },
  { "role": "assistant", "content": "Photosynthesis is the process..." },
  { "role": "user",      "content": "give me a simple example" },
  { "role": "assistant", "content": "Think of a leaf in sunlight..." }
]
```

</td>
<td>

```
messages[4]{role,content}:
  user,what is photosynthesis
  assistant,Photosynthesis is the process...
  user,give me a simple example
  assistant,Think of a leaf in sunlight...
```

</td>
</tr>
</table>

Field names (`role`, `content`) are declared once in the header `{role,content}` and dropped from every row. Values are comma-separated, making each row much shorter than the equivalent JSON object.

### Why it matters here

| Turns in history | JSON tokens (approx.) | TOON tokens (approx.) | Saving |
|---|---|---|---|
| 2 messages | ~80 | ~35 | ~56% |
| 6 messages | ~240 | ~100 | ~58% |
| 12 messages | ~480 | ~200 | ~58% |

Since Ollama runs **locally**, there is no API cost — but token count directly affects **inference speed**. Fewer tokens in the context window = the model starts generating your reply sooner. In longer conversations this compounds: without TOON, response latency grows with every exchange; with TOON it stays nearly flat.

TOON applies only when there are 2+ prior messages. For the first exchange it falls back to plain JSON, so there is no risk of a small model being confused by an unfamiliar format before any conversation pattern is established.

## Switching to a Different LLM

The entire LLM integration lives in one function — `askOllama()` in `server.js`. To swap in a paid API, you only need to replace that function. Everything else (Deepgram, WebSocket, TOON encoding, streaming to the browser) stays the same.

The function signature to keep:
```js
function askLLM(clientWs, history, userText) {
  // must send: ai_start → ai_chunk (repeated) → ai_done
  // must resolve with the full reply string (or null on error)
}
```

### OpenAI (GPT-4o, GPT-4 Turbo, etc.)

1. Add your key to `.env`:
   ```
   OPENAI_API_KEY=sk-...
   ```

2. Install the SDK:
   ```
   npm install openai
   ```

3. Replace `askOllama` in `server.js`:
   ```js
   const OpenAI = require('openai');
   const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

   async function askOllama(clientWs, history, userText) {
     const ollamaHistory = history.map(h => ({
       role: h.role === 'model' ? 'assistant' : 'user',
       content: h.parts[0].text,
     }));

     let messages;
     if (ollamaHistory.length >= 2) {
       const toon = encodeToon(ollamaHistory);
       messages = [
         { role: 'system', content: `Prior conversation history in TOON format:\n\`\`\`toon\n${toon}\n\`\`\`` },
         { role: 'user', content: userText },
       ];
     } else {
       messages = [...ollamaHistory, { role: 'user', content: userText }];
     }

     clientWs.send(JSON.stringify({ type: 'ai_start' }));
     let fullReply = '';

     const stream = await openai.chat.completions.create({
       model: 'gpt-4o',
       messages,
       stream: true,
     });

     for await (const chunk of stream) {
       const text = chunk.choices[0]?.delta?.content || '';
       if (text) {
         fullReply += text;
         if (clientWs.readyState === WebSocket.OPEN)
           clientWs.send(JSON.stringify({ type: 'ai_chunk', text }));
       }
     }

     if (clientWs.readyState === WebSocket.OPEN)
       clientWs.send(JSON.stringify({ type: 'ai_done', full: fullReply }));
     return fullReply || null;
   }
   ```

### Anthropic (Claude)

1. Add your key to `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

2. Install the SDK:
   ```
   npm install @anthropic-ai/sdk
   ```

3. Replace `askOllama` in `server.js`:
   ```js
   const Anthropic = require('@anthropic-ai/sdk');
   const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

   async function askOllama(clientWs, history, userText) {
     const ollamaHistory = history.map(h => ({
       role: h.role === 'model' ? 'assistant' : 'user',
       content: h.parts[0].text,
     }));

     let systemPrompt = '';
     let messages;
     if (ollamaHistory.length >= 2) {
       const toon = encodeToon(ollamaHistory);
       systemPrompt = `Prior conversation history in TOON format:\n\`\`\`toon\n${toon}\n\`\`\``;
       messages = [{ role: 'user', content: userText }];
     } else {
       messages = [...ollamaHistory, { role: 'user', content: userText }];
     }

     clientWs.send(JSON.stringify({ type: 'ai_start' }));
     let fullReply = '';

     const stream = anthropic.messages.stream({
       model: 'claude-opus-4-8',
       max_tokens: 1024,
       system: systemPrompt || undefined,
       messages,
     });

     for await (const chunk of stream) {
       if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
         const text = chunk.delta.text;
         fullReply += text;
         if (clientWs.readyState === WebSocket.OPEN)
           clientWs.send(JSON.stringify({ type: 'ai_chunk', text }));
       }
     }

     if (clientWs.readyState === WebSocket.OPEN)
       clientWs.send(JSON.stringify({ type: 'ai_done', full: fullReply }));
     return fullReply || null;
   }
   ```

### Any OpenAI-compatible API (Groq, Together AI, Mistral, etc.)

These providers follow the same OpenAI API format. Use the OpenAI SDK with a custom `baseURL`:

```js
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',   // swap for your provider's URL
});
// then use the same OpenAI example above, change model to e.g. 'llama3-70b-8192'
```

| Provider | Base URL | Models |
|---|---|---|
| Groq | `https://api.groq.com/openai/v1` | `llama3-70b-8192`, `mixtral-8x7b-32768` |
| Together AI | `https://api.together.xyz/v1` | `meta-llama/Llama-3-70b-chat-hf` |
| Mistral | `https://api.mistral.ai/v1` | `mistral-large-latest` |
| OpenRouter | `https://openrouter.ai/api/v1` | any model via unified API |

## Project structure

```
├── server.js       # Node HTTP + WebSocket server, Deepgram proxy, Ollama client
├── index.html      # HTML markup only
├── style.css       # All styles and animations
├── app.js          # Frontend logic — WebSocket, AudioWorklet, chat UI
├── .env            # Your API keys (never committed)
├── .env.example    # Template for .env
└── package.json
```

