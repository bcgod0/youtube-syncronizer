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
          videoId: null,
          currentTime: 0,
          isPlaying: false,
          playbackRate: 1,
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
       * A client performed a playback action.
       * We calculate the future execution time so all clients apply the action
       * at the exact same physical millisecond.
       */
      const { sessionId, session } = findSessionByClient(ws);
      if (!session) return;

      const serverNow = Date.now();

      // Find the maximum RTT in the session to guarantee delivery before execution
      let maxRtt = 0;
      for (const [, client] of session.clients) {
        if (client.rtt > maxRtt) maxRtt = client.rtt;
      }

      // Half RTT is the delivery time from server to client.
      // Pause is executed immediately; play/seek needs enough buffer so every client receives it.
      const isInstantPause = (msg.action === 'pause');
      const executionDelay = isInstantPause ? 0 : Math.max(40, Math.ceil(maxRtt / 2) + 40);
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

      session.state = {
        videoId,
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
          videoId,
          currentTime: targetVideoTime,
          playbackRate,
          isPlaying,
          executeAt: clientExecuteAt, // in the client's local clock
          timeline: session.timeline,
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
       * Used to anchor the reference timeline with zero transit delay.
       */
      const { sessionId, session } = findSessionByClient(ws);
      if (!session) return;

      const client = session.clients.get(ws);
      if (!client) return;

      const clientTimestamp = msg.timestamp || msg.clientTimestamp;
      client.lastPosition = msg.currentTime;
      client.lastPositionTimestamp = clientTimestamp;
      client.lastPositionServerTime = Date.now();

      // If this is the host, update the canonical timeline
      if (client.isHost) {
        // Translate client's sampling timestamp to server wall-clock time
        // serverTime = clientTime - clockOffset
        const hostServerTime = clientTimestamp
          ? (clientTimestamp - client.clockOffset)
          : (Date.now() - Math.round(client.rtt / 2));

        session.state.currentTime = msg.currentTime;
        session.state.isPlaying = msg.isPlaying;
        session.state.lastUpdated = Date.now();

        if (!session.timeline) {
          session.timeline = { version: 0 };
        }
        session.timeline.anchorServerTime = hostServerTime;
        session.timeline.anchorVideoTime = msg.currentTime;
        session.timeline.isPlaying = msg.isPlaying;
        session.timeline.playbackRate = msg.playbackRate || session.state.playbackRate || 1;
        if (msg.videoId) session.timeline.videoId = msg.videoId;
        session.timeline.version++;

        // Broadcast timeline-update to non-host clients
        for (const [clientWs] of session.clients) {
          if (clientWs === ws) continue; // skip host

          sendTo(clientWs, {
            type: 'timeline-update',
            timeline: session.timeline,
            serverNow: Date.now(),
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
