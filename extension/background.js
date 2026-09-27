/**
 * Background Service Worker
 * 
 * Manages the persistent WebSocket connection to the sync server,
 * performs NTP-like clock synchronization, and relays messages
 * between the popup/content scripts and the server.
 */

// ─── State ───────────────────────────────────────────────────────

let ws = null;
let serverUrl = 'wss://youtube-syncronizer-production.up.railway.app';
let sessionCode = null;
let clientId = null;
let clientName = 'User';
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 1000;

// Clock sync state
let clockOffset = 0;       // our clock - server clock (ms)
let clockRtt = Infinity;
let clockSyncSamples = [];
const CLOCK_SYNC_INTERVAL = 2000;  // re-sync every 2s for tighter accuracy
const CLOCK_SYNC_SAMPLES = 8;      // more samples = better offset estimate
let clockSyncTimer = null;
let clockSyncCount = 0;            // total sync rounds completed

// ─── WebSocket Connection ────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    ws = new WebSocket(serverUrl);
  } catch (e) {
    console.error('[BG] WebSocket creation failed:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[BG] Connected to sync server');
    isConnected = true;
    reconnectAttempts = 0;
    broadcastConnectionStatus();
    startClockSync();
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  };

  ws.onclose = () => {
    console.log('[BG] Disconnected from sync server');
    isConnected = false;
    stopClockSync();
    broadcastConnectionStatus();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[BG] WebSocket error');
  };
}

function disconnect() {
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // prevent auto-reconnect
  if (ws) {
    ws.close();
    ws = null;
  }
  isConnected = false;
  sessionCode = null;
  clientId = null;
  stopClockSync();
  broadcastConnectionStatus();
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
  const delay = RECONNECT_BASE_DELAY * Math.pow(2, Math.min(reconnectAttempts, 5));
  reconnectAttempts++;
  console.log(`[BG] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  setTimeout(connect, delay);
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Clock Synchronization (NTP-like) ───────────────────────────

function startClockSync() {
  stopClockSync();
  performClockSync();
  clockSyncTimer = setInterval(performClockSync, CLOCK_SYNC_INTERVAL);
}

function stopClockSync() {
  if (clockSyncTimer) {
    clearInterval(clockSyncTimer);
    clockSyncTimer = null;
  }
}

function performClockSync() {
  clockSyncSamples = [];
  sendClockSyncPing();
}

function sendClockSyncPing() {
  sendToServer({
    type: 'clock-sync-request',
    t0: Date.now(),
  });
}

function handleClockSyncResponse(msg) {
  const t2 = Date.now(); // client receive time
  const t0 = msg.t0;     // client send time
  const t1 = msg.t1;     // server timestamp

  const rtt = t2 - t0;
  // Estimated offset: clientClock - serverClock
  // offset = ((t0 - t1) + (t2 - t1)) / 2 = (t0 + t2) / 2 - t1
  const offset = (t0 + t2) / 2 - t1;

  clockSyncSamples.push({ offset, rtt });

  if (clockSyncSamples.length < CLOCK_SYNC_SAMPLES) {
    // Send another ping rapidly for burst measurement
    setTimeout(sendClockSyncPing, 20);
  } else {
    // Pick the sample with the lowest RTT (most accurate)
    clockSyncSamples.sort((a, b) => a.rtt - b.rtt);
    // Average the best 3 samples for stability
    const bestN = clockSyncSamples.slice(0, 3);
    const avgOffset = bestN.reduce((s, x) => s + x.offset, 0) / bestN.length;
    const bestRtt = bestN[0].rtt;

    // Exponential moving average to smooth offset across rounds
    clockSyncCount++;
    if (clockSyncCount <= 1) {
      clockOffset = avgOffset;
    } else {
      // Weight new measurement 40%, history 60%
      clockOffset = clockOffset * 0.6 + avgOffset * 0.4;
    }
    clockRtt = bestRtt;

    // Report to server
    sendToServer({
      type: 'clock-offset-report',
      offset: clockOffset,
      rtt: clockRtt,
    });

    console.log(`[BG] Clock sync #${clockSyncCount}: offset=${clockOffset.toFixed(1)}ms, RTT=${clockRtt}ms`);
  }
}

// ─── Server Message Handler ─────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'clock-sync-response':
      handleClockSyncResponse(msg);
      break;

    case 'session-created':
      sessionCode = msg.sessionCode;
      clientId = msg.clientId;
      broadcastToContentScripts({
        type: 'session-update',
        sessionCode,
        clientId,
        clients: msg.clients,
        isHost: true,
      });
      broadcastConnectionStatus();
      break;

    case 'session-joined':
      sessionCode = msg.sessionCode;
      clientId = msg.clientId;
      broadcastToContentScripts({
        type: 'session-update',
        sessionCode,
        clientId,
        clients: msg.clients,
        state: msg.state,
        isHost: false,
      });
      broadcastConnectionStatus();
      break;

    case 'session-left':
      sessionCode = null;
      broadcastToContentScripts({ type: 'session-left' });
      broadcastConnectionStatus();
      break;

    case 'client-joined':
    case 'client-left':
      broadcastToContentScripts({
        type: msg.type,
        clients: msg.clients,
        clientId: msg.clientId,
        clientName: msg.clientName,
        client: msg.client,
      });
      break;

    case 'promoted-to-host':
      broadcastToContentScripts({ type: 'promoted-to-host' });
      break;

    case 'sync-execute':
      // Forward to content scripts for execution
      broadcastToContentScripts({
        type: 'sync-execute',
        action: msg.action,
        videoId: msg.videoId,
        currentTime: msg.currentTime,
        playbackRate: msg.playbackRate,
        isPlaying: msg.isPlaying,
        executeAt: msg.executeAt,
        sourceClientId: msg.sourceClientId,
      });
      break;

    case 'drift-correction':
      broadcastToContentScripts({
        type: 'drift-correction',
        hostTime: msg.hostTime,
        isPlaying: msg.isPlaying,
        playbackRate: msg.playbackRate,
      });
      break;

    case 'error':
      broadcastToContentScripts({ type: 'error', message: msg.message });
      // Also send to popup
      broadcastConnectionStatus(msg.message);
      break;

    case 'pong':
      break;
  }
}

// ─── Content Script Communication ───────────────────────────────

function broadcastToContentScripts(message) {
  chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://youtube.com/*'] }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

function broadcastConnectionStatus(errorMessage = null) {
  const status = {
    type: 'connection-status',
    isConnected,
    sessionCode,
    clientId,
    clockOffset: Math.round(clockOffset),
    clockRtt: Math.round(clockRtt),
    serverUrl,
    error: errorMessage,
  };

  // Send to all YouTube tabs
  broadcastToContentScripts(status);

  // Send to popup (it lives in the extension context, not a tab)
  chrome.runtime.sendMessage(status).catch(() => {});
}

// ─── Message Listener (from popup and content scripts) ──────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'get-status':
      sendResponse({
        isConnected,
        sessionCode,
        clientId,
        clientName,
        clockOffset: Math.round(clockOffset),
        clockRtt: Math.round(clockRtt),
        serverUrl,
      });
      return true;

    case 'connect':
      serverUrl = msg.serverUrl || serverUrl;
      clientName = msg.name || clientName;
      reconnectAttempts = 0;
      connect();
      sendResponse({ ok: true });
      return true;

    case 'disconnect':
      disconnect();
      sendResponse({ ok: true });
      return true;

    case 'create-session':
      clientName = msg.name || clientName;
      sendToServer({ type: 'create-session', name: clientName });
      sendResponse({ ok: true });
      return true;

    case 'join-session':
      clientName = msg.name || clientName;
      sendToServer({ type: 'join-session', sessionCode: msg.sessionCode, name: clientName });
      sendResponse({ ok: true });
      return true;

    case 'leave-session':
      sendToServer({ type: 'leave-session' });
      sessionCode = null;
      broadcastConnectionStatus();
      sendResponse({ ok: true });
      return true;

    case 'sync-action':
      // Forward playback action to server
      sendToServer({
        type: 'sync-action',
        action: msg.action,
        videoId: msg.videoId,
        currentTime: msg.currentTime,
        playbackRate: msg.playbackRate,
      });
      sendResponse({ ok: true });
      return true;

    case 'position-report':
      sendToServer({
        type: 'position-report',
        currentTime: msg.currentTime,
        isPlaying: msg.isPlaying,
        timestamp: Date.now(),
      });
      return false;

    case 'update-server-url':
      serverUrl = msg.serverUrl;
      chrome.storage.local.set({ serverUrl });
      sendResponse({ ok: true });
      return true;
  }
});

// ─── Startup ─────────────────────────────────────────────────────

chrome.storage.local.get(['serverUrl', 'clientName'], (data) => {
  if (data.serverUrl) serverUrl = data.serverUrl;
  if (data.clientName) clientName = data.clientName;
});

// Keep-alive ping every 25s to prevent service worker termination
setInterval(() => {
  if (isConnected) {
    sendToServer({ type: 'ping' });
  }
}, 25000);
