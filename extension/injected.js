/**
 * Injected Page Script
 *
 * Runs in the YouTube page's own JS context.
 * Communicates with content.js via window.postMessage.
 *
 * Master-Follower Architecture:
 * - The HOST is the sole leader. Only the host broadcasts user actions (play, pause, seek, video-change).
 * - ALL OTHER DEVICES are followers that strictly follow the host.
 * - Followers automatically navigate to the host's video.
 * - Continuous 1-second transit-compensated drift corrections lock audio within 15ms.
 */

(function () {
  'use strict';

  if (window.__ytSyncInjected) return;
  window.__ytSyncInjected = true;

  const SOURCE = 'yt-sync-injected';

  let player = null;
  let lastState = -1;
  let lastTime = -1;
  let lastVideoId = '';
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
    lastVideoId = getVideoId();
    postToContent({ type: 'player-ready' });

    // Monitor playback state changes (every 200ms)
    setInterval(checkPlayerState, 200);

    // Watch for in-page YouTube SPA navigations
    window.addEventListener('yt-navigate-finish', onPageNavigated);
  }

  function onPageNavigated() {
    if (!isInSession || !isHost) return;
    const newId = getVideoId();
    if (newId && newId !== lastVideoId) {
      lastVideoId = newId;
      console.log(`[YT-Sync] Host navigated to new video: ${newId}`);
      postToContent({
        type: 'player-event',
        action: 'video-change',
        videoId: newId,
        currentTime: 0,
        playbackRate: 1,
        isPlaying: true,
      });
    }
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

  // ─── Player State Monitoring (HOST ONLY) ─────────────────────────

  function checkPlayerState() {
    // Only the host broadcasts events. Followers only follow!
    if (!player || suppressEvents || !isInSession || !isHost) return;
    if (isAdPlaying()) return;

    try {
      const state = player.getPlayerState();
      const video = getVideoElement();
      const time = video ? video.currentTime : player.getCurrentTime();
      const videoId = getVideoId();
      const rate = player.getPlaybackRate ? player.getPlaybackRate() : 1;

      // 1. Detect Video Change on Host
      if (videoId && lastVideoId && videoId !== lastVideoId) {
        lastVideoId = videoId;
        console.log(`[YT-Sync] Host changed video to: ${videoId}`);
        postToContent({
          type: 'player-event',
          action: 'video-change',
          videoId,
          currentTime: time,
          playbackRate: rate,
          isPlaying: (state === 1),
        });
      } else if (videoId && !lastVideoId) {
        lastVideoId = videoId;
      }

      // 2. Detect Play on Host
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

      // 3. Detect Pause on Host
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

      // 4. Detect Seek on Host
      else if (lastTime !== -1 && Math.abs(time - lastTime) > 1.2 && (state === 1 || state === 2)) {
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
    // 1. YouTube player API (most reliable)
    if (player && typeof player.getVideoData === 'function') {
      const data = player.getVideoData();
      if (data && data.video_id) return data.video_id;
    }
    // 2. URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const v = urlParams.get('v');
    if (v) return v;
    if (window.location.pathname.startsWith('/shorts/')) {
      return window.location.pathname.split('/')[2] || '';
    }
    return '';
  }

  // ─── Follower Video Synchronization Helper ───────────────────────

  function syncFollowerVideo(targetVideoId, startTime) {
    if (isHost || !targetVideoId) return false;
    const curId = getVideoId();
    if (curId === targetVideoId) return false;

    console.log(`[YT-Sync] Follower transitioning to host video: ${targetVideoId} (from: "${curId}")`);
    lastVideoId = targetVideoId;

    // If player exists and supports loadVideoById, use it to avoid full page reload
    if (player && typeof player.loadVideoById === 'function') {
      try {
        player.loadVideoById({
          videoId: targetVideoId,
          startSeconds: Math.floor(startTime || 0)
        });
        return true;
      } catch (e) {
        console.warn('[YT-Sync] loadVideoById error, falling back to location.href:', e);
      }
    }

    // Direct URL navigation (works from homepage, search, or if player not loaded)
    window.location.href = `https://www.youtube.com/watch?v=${targetVideoId}&t=${Math.floor(startTime || 0)}`;
    return true;
  }

  // ─── Autoplay-Safe Playback ──────────────────────────────────────

  function startPlaybackSafe() {
    const video = getVideoElement();
    if (video) {
      const p = video.play();
      if (p && p.catch) {
        p.catch((err) => {
          console.warn('[YT-Sync] Autoplay blocked with sound:', err.message);
          // Mute and play so follower synchronizes immediately
          video.muted = true;
          video.play().catch(() => {});
          showAutoplayNotice();
        });
      }
    }
    if (player && typeof player.playVideo === 'function') {
      try {
        player.playVideo();
      } catch (e) {}
    }
  }

  function showAutoplayNotice() {
    if (document.getElementById('yt-sync-unmute-notice')) return;
    const notice = document.createElement('div');
    notice.id = 'yt-sync-unmute-notice';
    notice.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:18px;">🔊</span>
        <span>Click anywhere to unmute synchronized audio</span>
      </div>
    `;
    Object.assign(notice.style, {
      position: 'fixed',
      bottom: '80px',
      right: '24px',
      zIndex: '999999',
      padding: '12px 20px',
      borderRadius: '12px',
      fontFamily: "'Inter', system-ui, sans-serif",
      fontSize: '14px',
      fontWeight: '600',
      color: '#fff',
      background: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      cursor: 'pointer',
      transition: 'all 0.3s ease',
    });
    const unmute = () => {
      const v = getVideoElement();
      if (v) v.muted = false;
      notice.remove();
      window.removeEventListener('click', unmute, true);
    };
    notice.addEventListener('click', unmute);
    window.addEventListener('click', unmute, true);
    document.body.appendChild(notice);
  }

  // ─── Remote Action Execution (FOLLOWERS EXECUTE HOST ACTIONS) ────

  function executeAction(msg) {
    // HOST NEVER EXECUTES FOLLOWER/REMOTE ACTIONS!
    if (isHost) return;

    // 1. First ensure follower is on the host's video!
    if (msg.videoId && syncFollowerVideo(msg.videoId, msg.currentTime || 0)) {
      return;
    }

    if (!player) player = findPlayer();
    if (!player) return;

    suppressEvents = true;

    try {
      const video = getVideoElement();
      const baseRate = msg.playbackRate || 1;

      switch (msg.action) {
        case 'video-change': {
          if (msg.videoId) {
            syncFollowerVideo(msg.videoId, 0);
          }
          break;
        }

        case 'play': {
          if (msg.currentTime !== undefined) {
            const curTime = video ? video.currentTime : player.getCurrentTime();
            if (Math.abs(curTime - msg.currentTime) > 0.08) {
              player.seekTo(msg.currentTime, true);
            }
          }
          setVideoRate(baseRate);
          startPlaybackSafe();
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
            startPlaybackSafe();
          } else {
            player.pauseVideo();
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
    }, 400);
  }

  function applyFullState(msg) {
    if (isHost) return;

    // 1. Ensure follower matches host video
    if (msg.videoId && syncFollowerVideo(msg.videoId, msg.currentTime || 0)) {
      return;
    }

    if (!player) player = findPlayer();
    if (!player) {
      setTimeout(() => applyFullState(msg), 500);
      return;
    }

    suppressEvents = true;

    try {
      if (msg.currentTime !== undefined) {
        player.seekTo(msg.currentTime, true);
      }

      setVideoRate(msg.playbackRate || 1);

      if (msg.isPlaying) {
        startPlaybackSafe();
      } else {
        player.pauseVideo();
      }
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

  // ─── Follower Drift Correction (FOLLOWER FOLLOWS HOST CLOCK) ─────

  function handleDriftCorrection(msg) {
    // Only followers follow the host!
    if (isHost || suppressEvents) return;
    if (isAdPlaying()) return;

    // 1. Follower MUST match host video (run BEFORE checking player)
    if (msg.videoId && syncFollowerVideo(msg.videoId, msg.targetTime || 0)) {
      return;
    }

    if (!player) player = findPlayer();
    if (!player) return;

    try {
      const state = player.getPlayerState();
      const video = getVideoElement();
      const myTime = video ? video.currentTime : player.getCurrentTime();
      const targetTime = msg.targetTime !== undefined ? msg.targetTime : msg.hostTime;
      if (targetTime === undefined || targetTime < 0) return;

      const baseRate = msg.playbackRate || 1.0;

      // 2. Play/Pause state alignment
      if (msg.isPlaying && state !== 1 && state !== 3) {
        // Host is playing but follower is not — start follower!
        if (Math.abs(myTime - targetTime) > 0.08) {
          player.seekTo(targetTime, true);
        }
        setVideoRate(baseRate);
        startPlaybackSafe();
        return;
      } else if (!msg.isPlaying && (state === 1 || state === 3)) {
        // Host is paused but follower is playing — pause follower!
        player.pauseVideo();
        if (Math.abs(myTime - targetTime) > 0.05) {
          player.seekTo(targetTime, true);
        }
        setVideoRate(baseRate);
        return;
      }

      // 3. Both are playing — measure drift
      if (msg.isPlaying && state === 1) {
        const drift = myTime - targetTime; // positive = follower ahead, negative = follower behind
        const absDrift = Math.abs(drift);

        // A) Within 15ms: In phase! Perfect sync.
        if (absDrift < 0.015) {
          setVideoRate(baseRate);
          return;
        }

        // B) Large discrepancy (> 350ms): Snap to host's position immediately
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

        // C) Micro-drift (15ms to 350ms): Smooth proportional rate adjustment (±1% - ±5%)
        // Seamlessly slides follower into lockstep without audio cutouts or buffering
        const adjustment = Math.min(0.05, Math.max(0.01, absDrift * 0.15));
        const correctedRate = drift > 0 ? (baseRate - adjustment) : (baseRate + adjustment);

        setVideoRate(correctedRate);

        if (driftCorrectionTimer) clearTimeout(driftCorrectionTimer);
        driftCorrectionTimer = setTimeout(() => {
          setVideoRate(baseRate);
        }, 1000);
      }
    } catch (e) {
      console.error('[YT-Sync] Drift correction error:', e);
    }
  }

  // ─── Host Heartbeat Reporting ───────────────────────────────────

  function reportPosition() {
    if (!isHost) return;
    if (!player) player = findPlayer();
    if (!player) return;

    // If tab is hidden and paused, don't report (avoids background tab interference)
    if (document.hidden && player.getPlayerState() !== 1) return;

    try {
      const video = getVideoElement();
      const videoId = getVideoId();
      if (!videoId) return;

      postToContent({
        type: 'position-response',
        currentTime: video ? video.currentTime : player.getCurrentTime(),
        isPlaying: player.getPlayerState() === 1,
        playbackRate: player.getPlaybackRate ? player.getPlaybackRate() : 1,
        videoId,
        clientTimestamp: Date.now(),
      });
    } catch (e) {
      // ignore
    }
  }

  // Autonomous 1-second heartbeat when host is active
  setInterval(() => {
    if (isHost && isInSession) {
      reportPosition();
    }
  }, 1000);

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
        lastVideoId = getVideoId();
        if (isHost && isInSession) {
          setTimeout(reportPosition, 100);
        }
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
