/**
 * Injected Page Script
 *
 * Runs in the YouTube page's own JS context.
 * Communicates with content.js via window.postMessage.
 *
 * Features:
 * - Detects play / pause / seek naturally
 * - Executes sync actions (play, pause, seek, video-change)
 * - Performs smooth micro-rate adjustments on HTML5 <video> for sub-15ms sync
 * - No infinite event feedback loops
 */

(function () {
  'use strict';

  if (window.__ytSyncInjected) return;
  window.__ytSyncInjected = true;

  const SOURCE = 'yt-sync-injected';

  let player = null;
  let lastState = -1;
  let lastTime = -1;
  let suppressEvents = false;
  let isHost = false;
  let isInSession = false;
  let driftCorrectionTimer = null;

  // ─── Find YouTube Player & Video ───────────────────────────────

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
    console.log('[YT-Sync] YouTube player ready');
    postToContent({ type: 'player-ready' });

    // Monitor playback state changes (every 200ms)
    setInterval(checkPlayerState, 200);
  }

  // ─── Direct Playback Rate Control ───────────────────────────────

  function setVideoRate(rate) {
    const video = getVideoElement();
    if (video) {
      if (Math.abs(video.playbackRate - rate) > 0.002) {
        video.playbackRate = rate;
      }
    }
  }

  // ─── Player State Monitoring ────────────────────────────────────

  function checkPlayerState() {
    if (!player || suppressEvents || !isInSession) return;
    if (isAdPlaying()) return;

    try {
      const state = player.getPlayerState();
      const video = getVideoElement();
      const time = video ? video.currentTime : player.getCurrentTime();
      const videoId = getVideoId();
      const rate = player.getPlaybackRate ? player.getPlaybackRate() : 1;

      // 1. Detect Play (transition to state 1 from any other state)
      if (state === 1 && lastState !== 1) {
        postToContent({
          type: 'player-event',
          action: 'play',
          videoId,
          currentTime: time,
          playbackRate: rate,
          isPlaying: true,
        });
      }

      // 2. Detect Pause (transition to state 2 from state 1)
      else if (state === 2 && lastState === 1) {
        postToContent({
          type: 'player-event',
          action: 'pause',
          videoId,
          currentTime: time,
          playbackRate: rate,
          isPlaying: false,
        });
      }

      // 3. Detect Seek (jump in time while playing or paused)
      else if (lastTime !== -1 && Math.abs(time - lastTime) > 1.5 && (state === 1 || state === 2)) {
        postToContent({
          type: 'player-event',
          action: 'seek',
          videoId,
          currentTime: time,
          playbackRate: rate,
          isPlaying: (state === 1),
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

  // ─── Action Execution (Remote Commands) ─────────────────────────

  function executeAction(msg) {
    if (!player) player = findPlayer();
    if (!player) return;

    // Suppress local event detection while applying remote command
    suppressEvents = true;

    try {
      const video = getVideoElement();
      const baseRate = msg.playbackRate || 1;

      switch (msg.action) {
        case 'play': {
          if (msg.videoId && msg.videoId !== getVideoId()) {
            window.location.href = `https://www.youtube.com/watch?v=${msg.videoId}&t=${Math.floor(msg.currentTime || 0)}`;
            return;
          }
          if (msg.currentTime !== undefined) {
            const curTime = video ? video.currentTime : player.getCurrentTime();
            if (Math.abs(curTime - msg.currentTime) > 0.05) {
              player.seekTo(msg.currentTime, true);
            }
          }
          setVideoRate(baseRate);
          player.playVideo();
          break;
        }

        case 'pause': {
          player.pauseVideo();
          if (msg.currentTime !== undefined) {
            player.seekTo(msg.currentTime, true);
          }
          setVideoRate(baseRate);
          break;
        }

        case 'seek': {
          if (msg.currentTime !== undefined) {
            player.seekTo(msg.currentTime, true);
          }
          setVideoRate(baseRate);
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

    // Re-enable local event detection after YouTube state settles
    setTimeout(() => {
      suppressEvents = false;
      lastState = player ? player.getPlayerState() : -1;
      const v = getVideoElement();
      lastTime = v ? v.currentTime : (player ? player.getCurrentTime() : -1);
    }, 400);
  }

  function applyFullState(msg) {
    if (!player) player = findPlayer();
    if (!player) {
      setTimeout(() => applyFullState(msg), 800);
      return;
    }

    suppressEvents = true;

    try {
      if (msg.videoId && msg.videoId !== getVideoId()) {
        window.location.href = `https://www.youtube.com/watch?v=${msg.videoId}&t=${Math.floor(msg.currentTime || 0)}`;
        return;
      }

      if (msg.currentTime !== undefined) {
        player.seekTo(msg.currentTime, true);
      }

      if (msg.isPlaying) {
        player.playVideo();
      } else {
        player.pauseVideo();
      }

      setVideoRate(msg.playbackRate || 1);
    } catch (e) {
      console.error('[YT-Sync] Error applying state:', e);
    }

    setTimeout(() => {
      suppressEvents = false;
      lastState = player ? player.getPlayerState() : -1;
      const v = getVideoElement();
      lastTime = v ? v.currentTime : (player ? player.getCurrentTime() : -1);
    }, 600);
  }

  // ─── Continuous Drift Correction ────────────────────────────────

  function handleDriftCorrection(msg) {
    if (!player || isHost || suppressEvents) return;
    if (isAdPlaying()) return;

    try {
      const isPlaying = player.getPlayerState() === 1;
      if (!isPlaying || !msg.isPlaying) return;

      const video = getVideoElement();
      const myTime = video ? video.currentTime : player.getCurrentTime();
      const targetTime = msg.targetTime || msg.hostTime;
      if (targetTime === undefined || targetTime < 0) return;

      const drift = myTime - targetTime; // positive = ahead, negative = behind
      const absDrift = Math.abs(drift);
      const baseRate = msg.playbackRate || 1.0;

      // 1. Within 15ms — virtually in phase, perfect sync!
      if (absDrift < 0.015) {
        setVideoRate(baseRate);
        return;
      }

      // 2. Large desync (> 350ms) — quick seek to snap into place
      if (absDrift > 0.350) {
        suppressEvents = true;
        player.seekTo(targetTime, true);
        setVideoRate(baseRate);
        setTimeout(() => {
          suppressEvents = false;
          lastState = player ? player.getPlayerState() : -1;
          const v = getVideoElement();
          lastTime = v ? v.currentTime : (player ? player.getCurrentTime() : -1);
        }, 300);
        return;
      }

      // 3. Micro-drift (15ms - 350ms) — smooth proportional rate adjustment!
      // Scale rate smoothly by ±0.8% to ±4.0%
      const adjustment = Math.min(0.04, Math.max(0.008, absDrift * 0.20));
      const correctedRate = drift > 0 ? (baseRate - adjustment) : (baseRate + adjustment);

      setVideoRate(correctedRate);

      // Restore base rate after 1.2s to smoothly level off
      if (driftCorrectionTimer) clearTimeout(driftCorrectionTimer);
      driftCorrectionTimer = setTimeout(() => {
        setVideoRate(baseRate);
      }, 1200);

    } catch (e) {
      console.error('[YT-Sync] Drift correction error:', e);
    }
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

  // ─── Messages from Content Script ───────────────────────────────

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

      case 'session-status':
        isInSession = !!msg.isInSession;
        isHost = !!msg.isHost;
        if (!isInSession) {
          setVideoRate(1.0);
        }
        break;
    }
  });

  // ─── Helper ────────────────────────────────────────────────────

  function postToContent(msg) {
    window.postMessage({ source: SOURCE, ...msg }, '*');
  }

  // ─── Start ─────────────────────────────────────────────────────

  waitForPlayer();

})();
