/**
 * Popup Script
 *
 * Controls the extension popup UI. Communicates with the background
 * service worker to manage connection and session state.
 */

// ─── DOM Elements ────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);

const els = {
  // Panels
  connectPanel: $('#connectPanel'),
  sessionPanel: $('#sessionPanel'),
  activePanel: $('#activePanel'),

  // Connection
  serverUrl: $('#serverUrl'),
  userName: $('#userName'),
  connectBtn: $('#connectBtn'),
  disconnectBtn: $('#disconnectBtn'),
  connectionDot: $('#connectionDot .dot'),

  // Session
  createSessionBtn: $('#createSessionBtn'),
  joinSessionBtn: $('#joinSessionBtn'),
  joinCode: $('#joinCode'),
  leaveSessionBtn: $('#leaveSessionBtn'),

  // Active session
  sessionCodeDisplay: $('#sessionCodeDisplay'),
  copyCodeBtn: $('#copyCodeBtn'),
  latencyValue: $('#latencyValue'),
  offsetValue: $('#offsetValue'),
  syncStatus: $('#syncStatus'),
  membersList: $('#membersList'),

  // Toast
  toast: $('#toast'),
};

// ─── State ───────────────────────────────────────────────────────

let currentClients = [];

// ─── Initialization ──────────────────────────────────────────────

async function init() {
  // Load saved settings
  const data = await chrome.storage.local.get(['serverUrl', 'clientName']);
  if (data.serverUrl) els.serverUrl.value = data.serverUrl;
  if (data.clientName) els.userName.value = data.clientName;

  // Get current status from background
  chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response) {
      updateUI(response);
    }
  });

  // Bind events
  els.connectBtn.addEventListener('click', handleConnect);
  els.disconnectBtn.addEventListener('click', handleDisconnect);
  els.createSessionBtn.addEventListener('click', handleCreateSession);
  els.joinSessionBtn.addEventListener('click', handleJoinSession);
  els.leaveSessionBtn.addEventListener('click', handleLeaveSession);
  els.copyCodeBtn.addEventListener('click', handleCopyCode);

  // Enter key handlers
  els.joinCode.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') handleJoinSession();
  });
  els.userName.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') handleConnect();
  });
}

// ─── Event Handlers ──────────────────────────────────────────────

async function handleConnect() {
  let serverUrl = els.serverUrl.value.trim();
  const name = els.userName.value.trim() || 'User';

  if (!serverUrl) {
    showToast('Please enter a server URL', true);
    return;
  }

  // Auto-prepend wss:// if no protocol is specified
  if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
    serverUrl = 'wss://' + serverUrl;
    els.serverUrl.value = serverUrl;
  }

  // Save settings
  await chrome.storage.local.set({ serverUrl, clientName: name });

  els.connectBtn.disabled = true;
  els.connectBtn.textContent = 'Connecting...';

  chrome.runtime.sendMessage({
    type: 'connect',
    serverUrl,
    name,
  }, () => {
    // The background will notify us when connected
    // via the message listener below
  });

  // Timeout fallback
  setTimeout(() => {
    els.connectBtn.disabled = false;
    els.connectBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 12h14M12 5l7 7-7 7"/>
      </svg>
      Connect
    `;
  }, 5000);
}

function handleDisconnect() {
  chrome.runtime.sendMessage({ type: 'disconnect' });
  showPanel('connect');
  els.connectionDot.classList.remove('connected');
}

function handleCreateSession() {
  const name = els.userName.value.trim() || 'Host';
  chrome.runtime.sendMessage({ type: 'create-session', name });
}

function handleJoinSession() {
  const code = els.joinCode.value.trim().toUpperCase();
  const name = els.userName.value.trim() || 'User';

  if (!code || code.length < 4) {
    showToast('Please enter a valid session code', true);
    return;
  }

  chrome.runtime.sendMessage({ type: 'join-session', sessionCode: code, name });
}

function handleLeaveSession() {
  chrome.runtime.sendMessage({ type: 'leave-session' });
  showPanel('session');
}

async function handleCopyCode() {
  const code = els.sessionCodeDisplay.textContent;
  try {
    await navigator.clipboard.writeText(code);
    showToast('Session code copied!');
  } catch {
    showToast('Could not copy code', true);
  }
}

// ─── Message Listener ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'connection-status':
      updateUI(msg);
      if (msg.clients && Array.isArray(msg.clients)) {
        currentClients = msg.clients;
        renderMembers();
      }
      if (msg.error) {
        showToast(msg.error, true);
      }
      break;

    case 'session-update':
      els.sessionCodeDisplay.textContent = msg.sessionCode;
      currentClients = msg.clients || [];
      renderMembers();
      showPanel('active');
      break;

    case 'client-joined':
    case 'client-left':
      currentClients = msg.clients || [];
      renderMembers();
      break;

    case 'promoted-to-host':
      showToast('You are now the session host');
      break;

    case 'error':
      showToast(msg.message, true);
      break;
  }
});

// ─── UI Updates ──────────────────────────────────────────────────

function updateUI(status) {
  if (status.isConnected) {
    els.connectionDot.classList.add('connected');

    if (status.sessionCode) {
      els.sessionCodeDisplay.textContent = status.sessionCode;
      showPanel('active');

      if (status.clients && Array.isArray(status.clients)) {
        currentClients = status.clients;
        renderMembers();
      }

      // Update stats
      const rtt = status.clockRtt;
      const offset = status.clockOffset;

      els.latencyValue.textContent = (rtt !== undefined && rtt < 3000) ? `${rtt}ms` : '--';
      els.offsetValue.textContent = (offset !== undefined && Math.abs(offset) < 10000) ? `${offset}ms` : '--';

      if (rtt < 100) {
        els.syncStatus.textContent = 'Excellent';
        els.syncStatus.className = 'stat-value sync-good';
      } else if (rtt < 250) {
        els.syncStatus.textContent = 'Good';
        els.syncStatus.className = 'stat-value sync-good';
      } else if (rtt < 500) {
        els.syncStatus.textContent = 'Synced';
        els.syncStatus.className = 'stat-value sync-good';
      } else {
        els.syncStatus.textContent = 'High Ping';
        els.syncStatus.className = 'stat-value sync-warn';
      }
    } else {
      showPanel('session');
    }
  } else {
    els.connectionDot.classList.remove('connected');
    showPanel('connect');
  }

  // Reset connect button
  els.connectBtn.disabled = false;
  els.connectBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 12h14M12 5l7 7-7 7"/>
    </svg>
    Connect
  `;
}

function showPanel(name) {
  els.connectPanel.classList.toggle('hidden', name !== 'connect');
  els.sessionPanel.classList.toggle('hidden', name !== 'session');
  els.activePanel.classList.toggle('hidden', name !== 'active');
}

// ─── Members List ────────────────────────────────────────────────

const AVATAR_COLORS = [
  'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)',
  'linear-gradient(135deg, #ec4899 0%, #db2777 100%)',
  'linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%)',
  'linear-gradient(135deg, #34d399 0%, #059669 100%)',
  'linear-gradient(135deg, #fbbf24 0%, #d97706 100%)',
  'linear-gradient(135deg, #f87171 0%, #dc2626 100%)',
  'linear-gradient(135deg, #a3e635 0%, #65a30d 100%)',
  'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)',
];

function renderMembers() {
  els.membersList.innerHTML = '';

  currentClients.forEach((client, i) => {
    const li = document.createElement('li');
    li.className = 'member-item';

    const initial = (client.name || 'U').charAt(0).toUpperCase();
    const color = AVATAR_COLORS[i % AVATAR_COLORS.length];

    li.innerHTML = `
      <div class="member-avatar" style="background: ${color}">${initial}</div>
      <span class="member-name">${escapeHtml(client.name || 'Unknown')}</span>
      ${client.isHost ? '<span class="member-badge">Host</span>' : ''}
      ${client.rtt > 0 ? `<span class="member-rtt">${client.rtt}ms</span>` : ''}
    `;

    els.membersList.appendChild(li);
  });
}

// ─── Toast Notification ──────────────────────────────────────────

let toastTimer = null;

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.className = `toast${isError ? ' error' : ''}`;

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.add('hidden');
  }, 3000);
}

// ─── Utility ─────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Start ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
