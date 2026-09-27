/**
 * Content Script
 * 
 * Injected into YouTube pages. Bridges between the page's YouTube player
 * (via injected.js in world: MAIN) and the background service worker.
 * 
 * Responsibilities:
 * - Listens for authoritative player events from injected.js
 * - Receives sync commands from background.js and forwards to injected.js
 * - Sends periodic position reports from host for transit-compensated drift correction
 * - Periodically syncs session state for 100% resilient connection recovery
 */

// ─── State ───────────────────────────────────────────────────────

let isInSession = false;
let isHost = false;
let suppressEvents = false;
let positionReportTimer = null;
const POSITION_REPORT_INTERVAL = 1000; // ms — 1s heartbeat from host

// ─── Communication with injected.js (via window.postMessage) ────

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'yt-sync-injected') return;

  const msg = event.data;

  switch (msg.type) {
    case 'player-event': {
      // ONLY the host broadcasts player actions! Followers follow the host.
      if (!isInSession || !isHost || suppressEvents) return;

      const { action, videoId, currentTime, playbackRate, isPlaying } = msg;

      // Forward to background → server
      chrome.runtime.sendMessage({
        type: 'sync-action',
        action,
        videoId,
        currentTime,
        playbackRate,
        isPlaying,
      });
      break;
    }

    case 'player-ready': {
      // YouTube player detected or responded to ping
      syncSessionStatus();
      break;
    }

    case 'position-response': {
      // Heartbeat position from host player
      if (!isInSession || !isHost) return;
      chrome.runtime.sendMessage({
        type: 'position-report',
        currentTime: msg.currentTime,
        isPlaying: msg.isPlaying,
        playbackRate: msg.playbackRate,
        videoId: msg.videoId,
        clientTimestamp: msg.clientTimestamp || Date.now(),
      });
      break;
    }
  }
});

function sendToInjected(message) {
  window.postMessage({
    source: 'yt-sync-content',
    ...message,
  }, '*');
}

// ─── Session State Synchronization ──────────────────────────────

function syncSessionStatus() {
  chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.isConnected && response.sessionCode) {
      const wasInSession = isInSession;
      const wasHost = isHost;

      isInSession = true;
      isHost = (response.isHost === true);

      sendToInjected({
        type: 'session-status',
        isInSession: true,
        isHost: isHost,
      });

      if (!isHost && response.state && response.state.videoId) {
        if (!wasInSession) {
          applyState(response.state);
        }
      }

      if (isHost) {
        startPositionReporting();
      } else {
        stopPositionReporting();
      }
    } else {
      if (isInSession) {
        isInSession = false;
        isHost = false;
        sendToInjected({
          type: 'session-status',
          isInSession: false,
          isHost: false,
        });
        stopPositionReporting();
      }
    }
  });
}

// Startup handshake and periodic sync check
syncSessionStatus();
sendToInjected({ type: 'ping' });

// Poll every 2.5s so tabs recover effortlessly from SPA navigation or background reconnects
setInterval(() => {
  syncSessionStatus();
  sendToInjected({ type: 'ping' });
}, 2500);

// ─── Messages from Background ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'session-update': {
      isInSession = true;
      isHost = (msg.isHost === true);

      sendToInjected({
        type: 'session-status',
        isInSession: true,
        isHost: isHost,
      });

      // Apply initial state for non-host clients
      if (!isHost && msg.state && msg.state.videoId) {
        applyState(msg.state);
      }

      if (isHost) {
        startPositionReporting();
      } else {
        stopPositionReporting();
      }

      showNotification(`Connected to session ${msg.sessionCode}`);
      break;
    }

    case 'session-left': {
      isInSession = false;
      isHost = false;
      sendToInjected({
        type: 'session-status',
        isInSession: false,
        isHost: false,
      });
      stopPositionReporting();
      showNotification('Left the sync session');
      break;
    }

    case 'promoted-to-host': {
      isHost = true;
      sendToInjected({
        type: 'session-status',
        isInSession: true,
        isHost: true,
      });
      startPositionReporting();
      showNotification('You are now the session host');
      break;
    }

    case 'client-joined': {
      if (msg.client) {
        showNotification(`${msg.client.name} joined the session`);
      }
      break;
    }

    case 'client-left': {
      if (msg.clientName) {
        showNotification(`${msg.clientName} left the session`);
      }
      break;
    }

    case 'sync-execute': {
      if (isHost) return;
      executeSyncAction(msg);
      break;
    }

    case 'drift-correction': {
      if (isHost) return;
      sendToInjected({
        type: 'drift-correction',
        videoId: msg.videoId,
        targetTime: msg.targetTime,
        hostTime: msg.hostTime,
        isPlaying: msg.isPlaying,
        playbackRate: msg.playbackRate,
      });
      break;
    }

    case 'error': {
      showNotification(`Error: ${msg.message}`, true);
      break;
    }
  }
});

// ─── Sync Execution ─────────────────────────────────────────────

function executeSyncAction(msg) {
  const isInstant = (msg.action === 'pause' || msg.action === 'seek' || msg.action === 'video-change');
  const now = Date.now();
  const delay = isInstant ? 0 : Math.max(0, Math.min(80, (msg.executeAt || now) - now));

  const runAction = () => {
    suppressEvents = true;

    sendToInjected({
      type: 'execute-action',
      action: msg.action,
      videoId: msg.videoId,
      currentTime: msg.currentTime,
      playbackRate: msg.playbackRate,
      isPlaying: msg.isPlaying,
      timeline: msg.timeline,
    });

    setTimeout(() => {
      suppressEvents = false;
    }, 400);
  };

  if (delay <= 0) {
    runAction();
  } else {
    setTimeout(runAction, delay);
  }
}

function applyState(state) {
  suppressEvents = true;

  sendToInjected({
    type: 'apply-state',
    videoId: state.videoId,
    currentTime: state.currentTime,
    isPlaying: state.isPlaying,
    playbackRate: state.playbackRate,
  });

  setTimeout(() => {
    suppressEvents = false;
  }, 1000);
}

// ─── Position Reporting ─────────────────────────────────────────

function startPositionReporting() {
  stopPositionReporting();
  if (!isHost) return;

  // Immediate reading for instant anchor
  sendToInjected({ type: 'get-position' });

  positionReportTimer = setInterval(() => {
    sendToInjected({ type: 'get-position' });
  }, POSITION_REPORT_INTERVAL);
}

function stopPositionReporting() {
  if (positionReportTimer) {
    clearInterval(positionReportTimer);
    positionReportTimer = null;
  }
}

// ─── UI Notification ─────────────────────────────────────────────

function showNotification(text, isError = false) {
  const existing = document.getElementById('yt-sync-notification');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'yt-sync-notification';
  el.textContent = text;
  Object.assign(el.style, {
    position: 'fixed',
    top: '20px',
    right: '20px',
    zIndex: '999999',
    padding: '12px 20px',
    borderRadius: '12px',
    fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    fontSize: '14px',
    fontWeight: '500',
    color: '#fff',
    background: isError
      ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
      : 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255,255,255,0.1) inset',
    backdropFilter: 'blur(20px)',
    transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
    transform: 'translateY(-10px)',
    opacity: '0',
    pointerEvents: 'none',
  });

  document.body.appendChild(el);

  requestAnimationFrame(() => {
    el.style.transform = 'translateY(0)';
    el.style.opacity = '1';
  });

  setTimeout(() => {
    el.style.transform = 'translateY(-10px)';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }, 3000);
}
