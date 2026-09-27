/**
 * YouTube Sync Server
 * 
 * WebSocket server that manages synchronized playback sessions.
 * Implements NTP-like clock synchronization to measure each client's
 * clock offset relative to the server, enabling sub-50ms sync accuracy.
 */

const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8765;

// ─── Session Store ───────────────────────────────────────────────

/**
 * Each session tracks:
 *   - clients: Map<ws, ClientInfo>
 *   - state: { videoId, currentTime, isPlaying, playbackRate, lastUpdated }
 *   - hostId: the client who created the session
 */
const sessions = new Map();

/**
 * @typedef {Object} ClientInfo
 * @property {string} id          - unique client ID
 * @property {number} clockOffset - estimated (clientClock - serverClock) in ms
 * @property {number} rtt         - last measured round-trip time in ms
 * @property {string} name        - display name
 * @property {boolean} isHost     - whether this client is the session host
 */

// ─── Helpers ─────────────────────────────────────────────────────

function generateSessionCode() {
  // 6-character alphanumeric code, easy to type
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function broadcastToSession(sessionId, message, excludeWs = null) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const payload = JSON.stringify(message);
  for (const [ws, client] of session.clients) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(payload);
    }
  }
}

function sendTo(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function getSessionClientList(session) {
  const list = [];
  for (const [, client] of session.clients) {
    list.push({
      id: client.id,
      name: client.name,
      isHost: client.isHost,
      rtt: client.rtt,
    });
  }
  return list;
}

function findSessionByClient(ws) {
  for (const [sessionId, session] of sessions) {
    if (session.clients.has(ws)) {
      return { sessionId, session };
    }
  }
  return { sessionId: null, session: null };
}

// ─── Server ──────────────────────────────────────────────────────

const http = require('http');

// Create an HTTP server (required for Railway/cloud reverse proxies)
const server = http.createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// Attach WebSocket server to the HTTP server
const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  console.log(`🎵 YouTube Sync Server running on port ${PORT}`);
});

wss.on('connection', (ws) => {
  const clientId = uuidv4().slice(0, 8);
  ws._clientId = clientId;

  console.log(`[+] Client connected: ${clientId}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error(`[!] WebSocket error for ${clientId}:`, err.message);
  });
});

// ─── Message Handler ─────────────────────────────────────────────

function handleMessage(ws, msg) {
  switch (msg.type) {

    // ── Clock Sync (NTP-like) ──
    case 'clock-sync-request': {
      // Client sends { type, t0 } where t0 = client's send timestamp.
      // Server responds with { type, t0, t1 } where t1 = server's receive timestamp.
      // Client uses (t0, t1, t2=receive time) to calculate offset & RTT.
      sendTo(ws, {
        type: 'clock-sync-response',
        t0: msg.t0,
        t1: Date.now(),
      });
      break;
    }

    case 'clock-offset-report': {
      // Client computed its offset and RTT — store it
      const { sessionId, session } = findSessionByClient(ws);
      if (session) {
        const client = session.clients.get(ws);
        if (client) {
          client.clockOffset = msg.offset; // clientClock - serverClock
          client.rtt = msg.rtt;
        }
      }
      break;
    }

    // ── Session Management ──
    case 'create-session': {
      const code = generateSessionCode();
      const serverNow = Date.now();
      const session = {
        clients: new Map(),
        state: {
          videoId: msg.videoId || null,
          currentTime: msg.currentTime || 0,
          isPlaying: !!msg.isPlaying,
          playbackRate: msg.playbackRate || 1,
          lastUpdated: serverNow,
        },
        timeline: {
          anchorServerTime: serverNow,
          anchorVideoTime: 0,
          isPlaying: false,
          playbackRate: 1,
          videoId: null,
          version: 1,
        },
        hostId: ws._clientId,
      };

      const clientInfo = {
        id: ws._clientId,
        clockOffset: 0,
        rtt: 0,
        name: msg.name || 'Host',
        isHost: true,
      };

      session.clients.set(ws, clientInfo);
      sessions.set(code, session);

      sendTo(ws, {
        type: 'session-created',
        sessionCode: code,
        clientId: ws._clientId,
        timeline: session.timeline,
        clients: getSessionClientList(session),
      });

      console.log(`[S] Session ${code} created by ${ws._clientId} (${clientInfo.name})`);
      break;
    }

    case 'join-session': {
      const code = msg.sessionCode?.toUpperCase();
      const session = sessions.get(code);

      if (!session) {
        sendTo(ws, { type: 'error', message: 'Session not found. Check the code and try again.' });
        return;
      }

      // Check if already in a session
      const existing = findSessionByClient(ws);
      if (existing.session) {
        removeClientFromSession(ws, existing.sessionId, existing.session);
      }

      const clientInfo = {
        id: ws._clientId,
        clockOffset: 0,
        rtt: 0,
        name: msg.name || `User-${ws._clientId.slice(0, 4)}`,
        isHost: false,
      };

      session.clients.set(ws, clientInfo);

      // Send current state and canonical timeline to the joining client
      sendTo(ws, {
        type: 'session-joined',
        sessionCode: code,
        clientId: ws._clientId,
        state: session.state,
        timeline: session.timeline,
        clients: getSessionClientList(session),
      });

      // Notify others
      broadcastToSession(code, {
        type: 'client-joined',
        client: { id: clientInfo.id, name: clientInfo.name, isHost: false },
        clients: getSessionClientList(session),
      }, ws);

      console.log(`[S] ${clientInfo.name} (${ws._clientId}) joined session ${code}`);
      break;
    }

    case 'leave-session': {
      const { sessionId, session } = findSessionByClient(ws);
      if (session) {
        removeClientFromSession(ws, sessionId, session);
      }
      sendTo(ws, { type: 'session-left' });
      break;
    }

    // ── Playback Sync ──
    case 'sync-action': {
      /**
       * Host performed a playback action (play, pause, seek, video-change).
       * All other devices follow the host.
       */
      const { sessionId, session } = findSessionByClient(ws);
      if (!session) return;

      const client = session.clients.get(ws);
      // Only the host controls playback in the session
      if (!client || !client.isHost) {
        console.log(`[!] Ignored sync-action from non-host client ${ws._clientId}`);
        return;
      }

      const serverNow = Date.now();

      // Find the maximum RTT in the session to guarantee delivery before execution
      let maxRtt = 0;
      for (const [, client] of session.clients) {
        if (client.rtt > maxRtt) maxRtt = client.rtt;
      }

      // Pause, seek, and video-change are executed immediately; play has minimal buffer
      const isInstant = (msg.action === 'pause' || msg.action === 'seek' || msg.action === 'video-change');
      const executionDelay = isInstant ? 0 : Math.max(30, Math.min(60, Math.ceil(maxRtt / 2) + 20));
      const serverExecuteAt = serverNow + executionDelay;

      const targetVideoTime = msg.currentTime ?? session.state.currentTime ?? 0;
      const isPlaying = (msg.action === 'play') ? true :
                        (msg.action === 'pause') ? false :
                        (msg.isPlaying ?? session.state.isPlaying);
      const playbackRate = msg.playbackRate ?? session.state.playbackRate ?? 1;
      const videoId = msg.videoId || session.state.videoId || null;

      session.timeline = {
        anchorServerTime: serverExecuteAt,
        anchorVideoTime: targetVideoTime,
        isPlaying,
        playbackRate,
        videoId,
        version: ((session.timeline && session.timeline.version) || 0) + 1,
      };

      // Update session state
      session.state = {
        videoId: videoId || session.state.videoId,
        currentTime: targetVideoTime,
        isPlaying,
        playbackRate,
        lastUpdated: serverNow,
      };

      // Broadcast to ALL clients (including sender) with coordinated execution time
      for (const [clientWs, client] of session.clients) {
        const clientExecuteAt = serverExecuteAt + client.clockOffset;

        sendTo(clientWs, {
          type: 'sync-execute',
          action: msg.action,
          videoId: session.state.videoId,
          currentTime: targetVideoTime,
          playbackRate,
          isPlaying,
          executeAt: clientExecuteAt, // in the client's local clock
          sourceClientId: ws._clientId,
        });
      }

      console.log(`[▶] ${msg.action} in session ${sessionId} by ${ws._clientId} | delay=${executionDelay}ms pos=${targetVideoTime.toFixed(2)}s`);
      break;
    }

    // ── Heartbeat / Position Report ──
    case 'position-report': {
      /**
       * Periodic position report from client.
       * Used to compute transit-compensated drift corrections for non-host clients.
       */
      const { sessionId, session } = findSessionByClient(ws);
      if (!session) return;

      const client = session.clients.get(ws);
      if (!client) return;

      const clientTimestamp = msg.timestamp || msg.clientTimestamp;
      client.lastPosition = msg.currentTime;
      client.lastPositionTimestamp = clientTimestamp;
      client.lastPositionServerTime = Date.now();

      // If this is the host, update session state and broadcast transit-compensated target time
      if (client.isHost) {
        session.state.currentTime = msg.currentTime;
        session.state.isPlaying = msg.isPlaying;
        if (msg.videoId) session.state.videoId = msg.videoId;
        if (msg.playbackRate) session.state.playbackRate = msg.playbackRate;
        session.state.lastUpdated = Date.now();

        // Translate host's reading timestamp to server wall-clock time
        const hostServerTime = (clientTimestamp && typeof client.clockOffset === 'number')
          ? (clientTimestamp - client.clockOffset)
          : (Date.now() - Math.round((client.rtt || 0) / 2));

        const now = Date.now();

        // Broadcast drift-correction to non-host clients with exact transit compensation
        for (const [clientWs, otherClient] of session.clients) {
          if (clientWs === ws) continue; // skip host

          const arrivalServerTime = now + Math.round((otherClient.rtt || 0) / 2);
          let elapsedSec = (arrivalServerTime - hostServerTime) / 1000;
          // Clamp bounds (0s to 1.5s) to guard against any temporary clock skew spikes
          if (elapsedSec < 0 || elapsedSec > 1.5) {
            elapsedSec = Math.max(0, ((otherClient.rtt || 50) + (client.rtt || 50)) / 2000);
          }

          const expectedTargetTime = msg.isPlaying
            ? msg.currentTime + (elapsedSec * (session.state.playbackRate || 1))
            : msg.currentTime;

          sendTo(clientWs, {
            type: 'drift-correction',
            videoId: session.state.videoId,
            targetTime: expectedTargetTime,
            hostTime: expectedTargetTime,
            isPlaying: msg.isPlaying,
            playbackRate: session.state.playbackRate || 1,
            serverTimestamp: now,
          });
        }
      }
      break;
    }

    // ── Ping/Pong for keep-alive ──
    case 'ping': {
      sendTo(ws, { type: 'pong', timestamp: Date.now() });
      break;
    }

    default:
      console.log(`[?] Unknown message type: ${msg.type}`);
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────

function removeClientFromSession(ws, sessionId, session) {
  const client = session.clients.get(ws);
  if (!client) return;

  session.clients.delete(ws);

  console.log(`[-] ${client.name} (${client.id}) left session ${sessionId}`);

  if (session.clients.size === 0) {
    // Session is empty, delete it
    sessions.delete(sessionId);
    console.log(`[S] Session ${sessionId} destroyed (empty)`);
  } else {
    // If the host left, promote the next client
    if (client.isHost) {
      const [nextWs, nextClient] = session.clients.entries().next().value;
      nextClient.isHost = true;
      session.hostId = nextClient.id;

      sendTo(nextWs, {
        type: 'promoted-to-host',
        message: 'You are now the session host.',
      });

      console.log(`[S] ${nextClient.name} promoted to host in session ${sessionId}`);
    }

    broadcastToSession(sessionId, {
      type: 'client-left',
      clientId: client.id,
      clientName: client.name,
      clients: getSessionClientList(session),
    });
  }
}

function handleDisconnect(ws) {
  console.log(`[-] Client disconnected: ${ws._clientId}`);
  const { sessionId, session } = findSessionByClient(ws);
  if (session) {
    removeClientFromSession(ws, sessionId, session);
  }
}

// ─── Periodic Cleanup of Stale Sessions ──────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions) {
    // Remove sessions inactive for 30 minutes
    if (now - session.state.lastUpdated > 30 * 60 * 1000 && session.clients.size === 0) {
      sessions.delete(code);
      console.log(`[GC] Cleaned up stale session ${code}`);
    }
  }
}, 60 * 1000);
