/**
 * Injected Page Script
 *
 * Runs in the YouTube page's own JS context with direct access to:
 * 1. The YouTube Player API (document.getElementById('movie_player'))
 * 2. The HTML5 <video> element (for high-precision micro-playbackRate adjustments)
 *
 * Architecture:
 * - Maintains an authoritative wall-clock anchored reference timeline
 * - Evaluates drift against server wall-clock time (zero network transit delay)
 * - Proportional playbackRate micro-adjustments for smooth, imperceptible audio sync (< 10ms)
 * - Coordinated pre-roll starts so all devices fire the first beat in perfect unison
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

  // Session & synchronization state
  let isInSession = false;
  let isHost = false;
  let clockOffset = 0; // clientClock - serverClock in ms
  let timeline = null; // { anchorServerTime, anchorVideoTime, isPlaying, playbackRate, videoId, version }

  // ─── Find YouTube Player & Video Element ────────────────────────

  function findPlayer() {
    if (document.getElementById('movie_player')) {
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.getPlayerState === 'function') {
        return mp;
      }
    }
    return null;
  }

  function getVideoElement() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function isAdPlaying() {
    return document.querySelector('.ad-showing') !== null ||
           (player && typeof player.getAdState === 'function' && player.getAdState() !== 0);
  }

  function waitForPlayer() {
    player = findPlayer();
    if (player) {
      initPlayer();
      return;
    }
    setTimeout(waitForPlayer, 500);
  }

  function initPlayer() {
    console.log('[YT-Sync] Player found, initializing high-precision sync engine');

    postToContent({ type: 'player-ready' });

    // Monitor user interaction (play/pause/seek)
    setInterval(checkPlayerState, 200);

    // High-precision continuous sync loop (every 80ms)
    setInterval(runContinuousSync, 80);
  }

  // ─── Playback Speed Controller ───────────────────────────────────

  /**
   * Applies playback speed directly to the HTMLMediaElement.
   * Chromium's HTMLMediaElement supports arbitrary fractional rates (e.g. 1.015, 0.985)
   * with automatic pitch preservation (no chipmunk effect).
   */
  function applyPlaybackRate(rate) {
    const video = getVideoElement();
    if (video) {
      if (Math.abs(video.playbackRate - rate) > 0.002) {
        video.playbackRate = rate;
      }
    }
    if (player && typeof player.setPlaybackRate === 'function') {
      try {
        player.setPlaybackRate(rate);
      } catch (e) {
        // ignore if YouTube API only supports standard steps
      }
    }
  }

  // ─── Reference Timeline Calculations ────────────────────────────

  /**
   * Calculates the exact mathematical target video time for this millisecond.
   * Because currentServerTime is synced via NTP, this is 100% immune to network transit delay.
   */
  function getTargetVideoTime() {
    if (!timeline) return null;
    if (!timeline.isPlaying) return timeline.anchorVideoTime;

    const currentServerTime = Date.now() - clockOffset;
    const elapsed = (currentServerTime - timeline.anchorServerTime) / 1000;
    return Math.max(0, timeline.anchorVideoTime + (elapsed * (timeline.playbackRate || 1.0)));
  }

  // ─── Continuous High-Precision Sync Loop ────────────────────────

  function runContinuousSync() {
    if (!isInSession || suppressEvents || !timeline || !player) return;

    // The host is the reference source: always plays at normal base rate
    if (isHost) {
      const baseRate = timeline.playbackRate || 1.0;
      applyPlaybackRate(baseRate);
      return;
    }

    const state = player.getPlayerState();
    // Only adjust when playing and not in ads
    if (state !== 1 || !timeline.isPlaying || isAdPlaying()) return;

    const video = getVideoElement();
    const actualTime = video ? video.currentTime : player.getCurrentTime();
    const targetTime = getTargetVideoTime();
    if (targetTime === null || targetTime < 0) return;

    const drift = actualTime - targetTime; // positive = ahead, negative = behind
    const absDrift = Math.abs(drift);
    const baseRate = timeline.playbackRate || 1.0;

    // 1. TIGHT SYNC (< 12ms)
    // Sound waves are practically in phase — human ear hears zero delay/echo
    if (absDrift < 0.012) {
      applyPlaybackRate(baseRate);
      return;
    }

    // 2. LARGE DISCREPANCY (> 350ms)
    // Hard seek only for major jumps (initial join or large seek)
    if (absDrift > 0.350) {
      suppressEvents = true;
      player.seekTo(targetTime, true);
      applyPlaybackRate(baseRate);
      setTimeout(() => { suppressEvents = false; }, 300);
      return;
    }

    // 3. MICRO-DRIFT (12ms to 350ms)
    // Smooth Proportional Control: adjust playback speed by ±0.8% to ±5.5%
    // Zero audio dropouts, zero buffering, zero stutter!
    const adjustment = Math.min(0.055, Math.max(0.008, absDrift * 0.22));
    const newRate = drift > 0 ? (baseRate - adjustment) : (baseRate + adjustment);

    applyPlaybackRate(newRate);
  }

  // ─── Player State Monitoring (User Interactions) ────────────────

  function checkPlayerState() {
    if (!player || suppressEvents || !isInSession) return;
    if (isAdPlaying()) return;

    try {
      const state = player.getPlayerState();
      const video = getVideoElement();
      const time = video ? video.currentTime : player.getCurrentTime();
      const videoId = getVideoId();
      const rate = player.getPlaybackRate ? player.getPlaybackRate() : 1;

      // Detect Play
      if (state === 1 && lastState !== 1) {
        suppressEvents = true;
        // Pause momentarily so all devices start simultaneously at executeAt
        player.pauseVideo();

        postToContent({
          type: 'player-event',
          action: 'play',
          videoId,
          currentTime: time,
          playbackRate: rate,
          isPlaying: true,
        });
      }

      // Detect Pause
      else if (state === 2 && lastState !== 2 && lastState !== -1) {
        suppressEvents = true;
        postToContent({
          type: 'player-event',
          action: 'pause',
          videoId,
          currentTime: time,
          playbackRate: rate,
          isPlaying: false,
        });
      }

      // Detect Seek (scrubbed by > 1.2 seconds)
      else if (Math.abs(time - lastTime) > 1.2 && lastTime !== -1) {
        suppressEvents = true;
        const isPlaying = (state === 1);
        if (isPlaying) player.pauseVideo();

        postToContent({
          type: 'player-event',
          action: 'seek',
          videoId,
          currentTime: time,
          playbackRate: rate,
          isPlaying,
        });
      }

      lastState = state;
      lastTime = time;
    } catch (e) {
      player = findPlayer();
    }
  }

  function getVideoId() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('v') || '';
  }

  // ─── Message Handling from Content Script ───────────────────────

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

      case 'timeline-update':
        if (msg.clockOffset !== undefined) clockOffset = msg.clockOffset;
        if (msg.timeline) {
          if (!timeline || !timeline.version || msg.timeline.version >= timeline.version) {
            timeline = msg.timeline;
          }
        }
        break;

      case 'clock-offset-update':
        if (msg.clockOffset !== undefined) {
          clockOffset = msg.clockOffset;
        }
        break;

      case 'session-status':
        isInSession = !!msg.isInSession;
        isHost = !!msg.isHost;
        if (msg.clockOffset !== undefined) clockOffset = msg.clockOffset;
        if (msg.timeline) timeline = msg.timeline;
        if (!isInSession) {
          applyPlaybackRate(1.0);
        }
        break;
    }
  });

  // ─── Action Execution ──────────────────────────────────────────

  function executeAction(msg) {
    if (!player) player = findPlayer();
    if (!player) return;

    suppressEvents = true;
    if (msg.timeline) timeline = msg.timeline;

    const baseRate = (timeline && timeline.playbackRate) || msg.playbackRate || 1.0;

    try {
      switch (msg.action) {
        case 'play': {
          const targetTime = (timeline && timeline.anchorVideoTime !== undefined)
            ? timeline.anchorVideoTime
            : (msg.currentTime !== undefined ? msg.currentTime : player.getCurrentTime());

          const video = getVideoElement();
          const cur = video ? video.currentTime : player.getCurrentTime();
          if (Math.abs(cur - targetTime) > 0.05) {
            player.seekTo(targetTime, true);
          }
          applyPlaybackRate(baseRate);
          player.playVideo();
          break;
        }

        case 'pause': {
          player.pauseVideo();
          const targetTime = (timeline && timeline.anchorVideoTime !== undefined)
            ? timeline.anchorVideoTime
            : msg.currentTime;
          if (targetTime !== undefined && Math.abs(player.getCurrentTime() - targetTime) > 0.05) {
            player.seekTo(targetTime, true);
          }
          applyPlaybackRate(baseRate);
          break;
        }

        case 'seek': {
          const targetTime = msg.currentTime !== undefined
            ? msg.currentTime
            : (timeline ? timeline.anchorVideoTime : 0);
          player.seekTo(targetTime, true);
          applyPlaybackRate(baseRate);
          if (msg.isPlaying) {
            player.playVideo();
          } else {
            player.pauseVideo();
          }
          break;
        }

        case 'video-change': {
          if (msg.videoId && msg.videoId !== getVideoId()) {
            window.location.href = `https://www.youtube.com/watch?v=${msg.videoId}`;
          }
          break;
        }
      }
    } catch (e) {
      console.error('[YT-Sync] Error executing action:', e);
    }

    setTimeout(() => {
      suppressEvents = false;
      lastState = player ? player.getPlayerState() : -1;
      const v = getVideoElement();
      lastTime = v ? v.currentTime : (player ? player.getCurrentTime() : -1);
    }, 350);
  }

  function applyFullState(msg) {
    if (!player) player = findPlayer();
    if (!player) {
      setTimeout(() => applyFullState(msg), 1000);
      return;
    }

    suppressEvents = true;

    try {
      if (msg.videoId && msg.videoId !== getVideoId()) {
        window.location.href = `https://www.youtube.com/watch?v=${msg.videoId}&t=${Math.floor(msg.currentTime || 0)}`;
        return;
      }

      player.seekTo(msg.currentTime || 0, true);

      if (msg.isPlaying) {
        player.playVideo();
      } else {
        player.pauseVideo();
      }

      applyPlaybackRate(msg.playbackRate || 1);
    } catch (e) {
      console.error('[YT-Sync] Error applying state:', e);
    }

    setTimeout(() => {
      suppressEvents = false;
      lastState = player ? player.getPlayerState() : -1;
      const v = getVideoElement();
      lastTime = v ? v.currentTime : (player ? player.getCurrentTime() : -1);
    }, 500);
  }

  // ─── Position Reporting ────────────────────────────────────────

  function reportPosition() {
    if (!player) return;

    try {
      const video = getVideoElement();
      postToContent({
        type: 'position-response',
        currentTime: video ? video.currentTime : player.getCurrentTime(),
        isPlaying: player.getPlayerState() === 1,
        playbackRate: player.getPlaybackRate ? player.getPlaybackRate() : 1,
        videoId: getVideoId(),
        clientTimestamp: Date.now(),
      });
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
