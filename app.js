const WORKLET_CODE = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++)
        pcm[i] = Math.max(-32768, Math.min(32767, ch[i] * 32768));
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

(function () {
  const SAMPLE_RATE = 16000;

  const chatEl    = document.getElementById('chat');
  const micBtn    = document.getElementById('micBtn');
  const statusEl  = document.getElementById('status');
  const interimEl = document.getElementById('interim-bubble');

  let ws           = null;
  let audioCtx     = null;
  let workletNode  = null;
  let micSource    = null;
  let micStream    = null;
  let listening    = false;
  let aiPending    = false;  // true while Ollama is streaming a reply
  let pendingClose = false;  // close WS after AI done (mic stopped mid-generation)
  let aiBubble     = null;   // current streaming AI bubble

  /* ── helpers ── */
  function setStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function scrollDown() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function addBubble(role, text) {
    const div = document.createElement('div');
    div.className = 'bubble ' + role;
    if (role === 'ai') {
      const avatar = document.createElement('div');
      avatar.className = 'ai-avatar';
      avatar.textContent = '🤖';
      const content = document.createElement('div');
      content.className = 'ai-content';
      content.textContent = text;
      div.appendChild(avatar);
      div.appendChild(content);
    } else {
      div.textContent = text;
    }
    chatEl.appendChild(div);
    scrollDown();
    return div;
  }

  function showTyping() {
    const div = document.createElement('div');
    div.className = 'bubble ai streaming';
    const avatar = document.createElement('div');
    avatar.className = 'ai-avatar';
    avatar.textContent = '🤖';
    const content = document.createElement('div');
    content.className = 'ai-content';
    content.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
    div.appendChild(avatar);
    div.appendChild(content);
    chatEl.appendChild(div);
    scrollDown();
    return div;
  }

  /* ── WebSocket message handler ── */
  function handleMessage(e) {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case 'ready':
        startMic();
        break;

      case 'user_message':
        interimEl.style.display = 'none';
        interimEl.textContent = '';
        addBubble('user', msg.text);
        break;

      case 'interim':
        interimEl.textContent = msg.text;
        interimEl.style.display = 'block';
        chatEl.appendChild(interimEl);
        scrollDown();
        break;

      case 'ai_start':
        aiPending = true;
        aiBubble = showTyping();
        break;

      case 'ai_chunk':
        if (aiBubble) {
          const contentEl = aiBubble.querySelector('.ai-content');
          if (contentEl) {
            if (contentEl.querySelector('.dots')) contentEl.innerHTML = '';
            contentEl.textContent += msg.text;
          }
          scrollDown();
        }
        break;

      case 'ai_done':
        aiPending = false;
        if (aiBubble) {
          aiBubble.classList.remove('streaming');
          aiBubble = null;
        }
        // Mic was stopped while AI was generating — now safe to close
        if (pendingClose) {
          pendingClose = false;
          if (ws && ws.readyState === WebSocket.OPEN) { ws.close(); ws = null; }
          micBtn.disabled = false;
          setStatus('Click the mic to start');
        }
        break;

      case 'error':
        setStatus('Error: ' + msg.message, 'error');
        stopRecording();
        break;
    }
  }

  /* ── recording ── */
  async function startRecording() {
    setStatus('Connecting…', 'loading');
    micBtn.disabled = true;

    ws = new WebSocket('ws://localhost:3000/ws');
    ws.binaryType = 'arraybuffer';
    ws.onmessage = handleMessage;

    ws.onerror = () => {
      setStatus('WebSocket error — is the server running?', 'error');
      stopRecording();
    };
    ws.onclose = () => {
      if (listening) { setStatus('Disconnected', 'error'); stopRecording(); }
    };
  }

  async function startMic() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
    } catch {
      setStatus('Microphone denied — allow mic in browser settings.', 'error');
      stopRecording();
      return;
    }

    audioCtx    = new AudioContext({ sampleRate: SAMPLE_RATE });
    const blob  = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url   = URL.createObjectURL(blob);
    await audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    micSource   = audioCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
    workletNode.port.onmessage = (e) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    micSource.connect(workletNode);

    listening = true;
    micBtn.disabled = false;
    micBtn.classList.add('listening');
    micBtn.textContent = '⏹️';
    document.getElementById('micWrapper').classList.add('listening-active');
    setStatus('Listening… speak now', 'active');
  }

  // Called when user clicks stop — stops audio only, keeps WS open if AI is responding
  function stopMicOnly() {
    listening = false;

    if (workletNode) { workletNode.disconnect(); workletNode = null; }
    if (micSource)   { micSource.disconnect();   micSource   = null; }
    if (audioCtx)    { audioCtx.close();          audioCtx    = null; }
    if (micStream)   { micStream.getTracks().forEach(t => t.stop()); micStream = null; }

    micBtn.classList.remove('listening');
    micBtn.textContent = '🎙️';
    document.getElementById('micWrapper').classList.remove('listening-active');

    // If interim text is showing, send it as a message before stopping
    const pendingText = interimEl.textContent.trim();
    interimEl.style.display = 'none';
    interimEl.textContent = '';

    if (pendingText && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'force_send', text: pendingText }));
    }

    if (aiPending || pendingText) {
      // Keep WS open so AI can finish; close after ai_done
      pendingClose = true;
      micBtn.disabled = true;
      setStatus('AI is responding…');
    } else {
      if (ws && ws.readyState === WebSocket.OPEN) { ws.close(); ws = null; }
      micBtn.disabled = false;
      setStatus('Click the mic to start');
    }
  }

  // Full teardown — used on errors and page unload
  function stopRecording() {
    listening = false;
    aiPending = false;
    pendingClose = false;

    if (workletNode) { workletNode.disconnect(); workletNode = null; }
    if (micSource)   { micSource.disconnect();   micSource   = null; }
    if (audioCtx)    { audioCtx.close();          audioCtx    = null; }
    if (micStream)   { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (ws && ws.readyState === WebSocket.OPEN) { ws.close(); ws = null; }

    micBtn.classList.remove('listening');
    micBtn.textContent = '🎙️';
    micBtn.disabled = false;
    document.getElementById('micWrapper').classList.remove('listening-active');
    interimEl.style.display = 'none';
    interimEl.textContent = '';
    setStatus('Click the mic to start');
  }

  micBtn.addEventListener('click', () => {
    if (listening) stopMicOnly(); else startRecording();
  });
})();
