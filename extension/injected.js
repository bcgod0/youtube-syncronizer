/**
 * Injected Page Script
 *
 * Runs in the YouTube page's own JS context so it has direct access
 * to the YouTube IFrame/HTML5 player API. Communicates with content.js
 * via window.postMessage.
 *
 * This script hooks into the YouTube player to:
 * - Detect play/pause/seek events and forward them
 * - Execute synchronized playback commands
 * - Report current position for drift correction
 * - Apply micro-adjustments to playback rate for drift correction
 */

(function () {
  'use strict';

  // Avoid double-injection
  if (window.__ytSyncInjected) return;
  window.__ytSyncInjected = true;

  const SOURCE = 'yt-sync-injected';
  let player = null;
  let lastState = -1;
  let lastTime = -1;
  let suppressEvents = false;

  // ─── Find YouTube Player ────────────────────────────────────────

  function findPlayer() {
    // Try the standard YouTube player API
    if (document.getElementById('movie_player')) {
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.getPlayerState === 'function') {
        return mp;
      }
    }
    // Fallback: try the video element directly
    return null;
  }

  function waitForPlayer() {
    player = findPlayer();
    if (player) {
      initPlayer();
      return;
    }
    // Retry
    setTimeout(waitForPlayer, 500);
  }

  function initPlayer() {
    console.log('[YT-Sync] Player found, initializing hooks');

    postToContent({ type: 'player-ready' });

    // Poll for state changes (more reliable than event listeners
    // since YouTube's API events can be inconsistent)
    setInterval(checkPlayerState, 250);
  }

  // ─── Player State Monitoring ────────────────────────────────────

  function checkPlayerState() {
    if (!player || suppressEvents) return;

    try {
      const state = player.getPlayerState();
      const time = player.getCurrentTime();
      const videoId = getVideoId();
      const rate = player.getPlaybackRate ? player.getPlaybackRate() : 1;

      // Detect play
      if (state === 1 && lastState !== 1) {
        postToContent({
          type: 'player-event',
          action: 'play',
          videoId,
          currentTime: time,
          playbackRate: rate,
        });
      }

      // Detect pause
      if (state === 2 && lastState !== 2 && lastState !== -1) {
        postToContent({
          type: 'player-event',
          action: 'pause',
          videoId,
          currentTime: time,
          playbackRate: rate,
        });
      }

      // Detect seek (time jumped by more than 2 seconds while playing)
      if (state === 1 && lastState === 1 && Math.abs(time - lastTime) > 2) {
        postToContent({
          type: 'player-event',
          action: 'seek',
          videoId,
          currentTime: time,
          playbackRate: rate,
        });
      }

      lastState = state;
      lastTime = time;
    } catch (e) {
      // Player might have been destroyed (SPA navigation)
      player = findPlayer();
    }
  }

  function getVideoId() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('v') || '';
  }

  // ─── Receive Commands from Content Script ───────────────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'yt-sync-content') return;

    const msg = event.data;

    switch (msg.type) {
      case 'execute-action':
        executeAction(msg);
        break;

      case 'apply-state':
        applyFullState(msg);
        break;

      case 'get-position':
        reportPosition();
        break;

      case 'drift-correction':
        handleDriftCorrection(msg);
        break;
    }
  });

  // ─── Action Execution ──────────────────────────────────────────

  function executeAction(msg) {
    if (!player) {
      player = findPlayer();
      if (!player) return;
    }

    suppressEvents = true;

    try {
      switch (msg.action) {
        case 'play':
          // Seek to the correct time, then play
          if (Math.abs(player.getCurrentTime() - msg.currentTime) > 0.3) {
            player.seekTo(msg.currentTime, true);
          }
          player.playVideo();
          break;

        case 'pause':
          player.pauseVideo();
          // Fine-tune position after pause
          if (msg.currentTime !== undefined) {
            player.seekTo(msg.currentTime, true);
          }
          break;

        case 'seek':
          player.seekTo(msg.currentTime, true);
          if (msg.isPlaying) {
            player.playVideo();
          }
          break;

        case 'video-change':
          // Navigate to the new video
          if (msg.videoId && msg.videoId !== getVideoId()) {
            window.location.href = `https://www.youtube.com/watch?v=${msg.videoId}`;
          }
          break;
      }

      if (msg.playbackRate && player.setPlaybackRate) {
        player.setPlaybackRate(msg.playbackRate);
      }
    } catch (e) {
      console.error('[YT-Sync] Error executing action:', e);
    }

    // Re-enable events after enough time for the action to settle
    setTimeout(() => {
      suppressEvents = false;
      lastState = player ? player.getPlayerState() : -1;
      lastTime = player ? player.getCurrentTime() : -1;
    }, 800);
  }

  function applyFullState(msg) {
    if (!player) {
      player = findPlayer();
      if (!player) {
        // Retry after player loads
        setTimeout(() => applyFullState(msg), 1000);
        return;
      }
    }

    suppressEvents = true;

    try {
      // If different video, navigate
      if (msg.videoId && msg.videoId !== getVideoId()) {
        window.location.href = `https://www.youtube.com/watch?v=${msg.videoId}&t=${Math.floor(msg.currentTime)}`;
        return;
      }

      // Seek to position
      player.seekTo(msg.currentTime, true);

      // Apply play/pause state
      if (msg.isPlaying) {
        player.playVideo();
      } else {
        player.pauseVideo();
      }

      if (msg.playbackRate && player.setPlaybackRate) {
        player.setPlaybackRate(msg.playbackRate);
      }
    } catch (e) {
      console.error('[YT-Sync] Error applying state:', e);
    }

    setTimeout(() => {
      suppressEvents = false;
      lastState = player ? player.getPlayerState() : -1;
      lastTime = player ? player.getCurrentTime() : -1;
    }, 500);
  }

  // ─── Position Reporting ────────────────────────────────────────

  function reportPosition() {
    if (!player) return;

    try {
      postToContent({
        type: 'position-response',
        currentTime: player.getCurrentTime(),
        isPlaying: player.getPlayerState() === 1,
      });
    } catch (e) {
      // ignore
    }
  }

  /**
   * Drift correction strategy (tolerant of high-latency networks):
   * 
   * With 200-300ms RTT, measurement noise is significant.
   * We must be conservative to avoid the correction feedback loop
   * (correct → event fires → correct again → repeat).
   * 
   * < 150ms  → Considered synced, no action needed
   * 150ms-2s → Gentle playback rate adjustment (±2-3%)
   * > 2s     → One-time hard seek, then cooldown
   * 
   * Corrections are debounced — minimum 2s between any two corrections.
   */
  let driftCorrectionTimer = null;
  let lastCorrectionTime = 0;
  const CORRECTION_COOLDOWN = 2000; // ms between corrections

  function handleDriftCorrection(msg) {
    if (!player) return;

    try {
      const isPlaying = player.getPlayerState() === 1;
      if (!isPlaying || !msg.isPlaying) return;

      // Debounce: skip if we corrected recently
      const now = Date.now();
      if (now - lastCorrectionTime < CORRECTION_COOLDOWN) return;

      const myTime = player.getCurrentTime();
      const drift = myTime - msg.hostTime; // positive = we're ahead
      const absDrift = Math.abs(drift);

      if (absDrift < 0.15) {
        // Within 150ms — close enough, restore normal rate
        restorePlaybackRate(msg.playbackRate || 1);
        return;
      }

      lastCorrectionTime = now;

      if (absDrift > 2.0) {
        // Very large drift (>2s) — hard seek
        suppressEvents = true;
        player.seekTo(msg.hostTime, true);
        restorePlaybackRate(msg.playbackRate || 1);
        setTimeout(() => { suppressEvents = false; }, 800);
        return;
      }

      // Moderate drift (150ms - 2s) — gentle rate adjustment only
      // Cap adjustment at ±3% to keep audio natural
      const baseRate = msg.playbackRate || 1;
      const adjustment = drift > 0 ? -0.03 : 0.03;

      const correctedRate = baseRate + adjustment;
      if (player.setPlaybackRate) {
        player.setPlaybackRate(correctedRate);
      }

      // Hold the adjusted rate for a while, then restore
      if (driftCorrectionTimer) clearTimeout(driftCorrectionTimer);
      driftCorrectionTimer = setTimeout(() => {
        restorePlaybackRate(baseRate);
      }, 3000);

    } catch (e) {
      console.error('[YT-Sync] Drift correction error:', e);
    }
  }

  function restorePlaybackRate(rate) {
    if (!player || !player.setPlaybackRate) return;
    try {
      player.setPlaybackRate(rate);
    } catch (e) {
      // ignore
    }
  }

  // ─── Helper ────────────────────────────────────────────────────

  function postToContent(msg) {
    window.postMessage({ source: SOURCE, ...msg }, '*');
  }

  // ─── Start ─────────────────────────────────────────────────────

  waitForPlayer();

})();
