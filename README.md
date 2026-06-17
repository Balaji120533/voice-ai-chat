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

## Project structure

```
├── server.js       # Node HTTP + WebSocket server, Deepgram proxy, Ollama client
├── index.html      # Single-page frontend (AudioWorklet, WebSocket, chat UI)
├── .env            # Your API keys (never committed)
├── .env.example    # Template for .env
└── package.json
```

