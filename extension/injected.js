/**
 * Injected Page Script
 *
 * Runs in the YouTube page's own JS context (world: MAIN).
 * Communicates with content.js via window.postMessage.
 *
 * Master-Follower Architecture:
 * - The HOST is the sole leader. Only the host broadcasts user actions (play, pause, seek, video-change).
 * - ALL OTHER DEVICES are followers that strictly follow the host.
 * - Followers automatically navigate to the host's video.
 * - Continuous 1-second transit-compensated drift corrections keep all devices locked in sync.
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
  let lastCheckTimestamp = Date.now();
  let suppressEvents = false;
  let isHost = false;
  let isInSession = false;
  let driftCorrectionTimer = null;
  let seekDebounceTimer = null;
  let attachedVideo = null;

  // Track video loading to prevent infinite reload loops
  let pendingLoadVideoId = null;
  let pendingLoadTimestamp = 0;

  // ─── Find YouTube Player & Video ───────────────────────────────

  function findPlayer() {
    const mp = document.getElementById('movie_player');
    if (mp && typeof mp.getPlayerState === 'function') {
      return mp;
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

  function getVideoId() {
    if (player && typeof player.getVideoData === 'function') {
      const data = player.getVideoData();
      if (data && data.video_id) return data.video_id;
    }
    const urlParams = new URLSearchParams(window.location.search);
    const v = urlParams.get('v');
    if (v) return v;
    if (window.location.pathname.startsWith('/shorts/')) {
      return window.location.pathname.split('/')[2] || '';
    }
    return '';
  }

  function waitForPlayer() {
    player = findPlayer();
    if (player) {
      initPlayer();
      return;
    }
    setTimeout(waitForPlayer, 300);
  }

  // ─── Native Video Event Listeners (Host Action Broadcasters) ───

  function onVideoPause() {
    if (!isHost || !isInSession || suppressEvents) return;
    if (isAdPlaying()) return;

    const video = getVideoElement();
    // Do not broadcast false pauses while the user or player is scrubbing/seeking
    if (video && video.seeking) return;

    const time = video ? video.currentTime : (player ? player.getCurrentTime() : 0);
    const videoId = getVideoId();
    const rate = video ? video.playbackRate : 1;

    console.log(`[YT-Sync] Host paused at ${time.toFixed(2)}s`);
    lastState = 2;
    lastTime = time;

    postToContent({
      type: 'player-event',
      action: 'pause',
      videoId,
      currentTime: time,
      playbackRate: rate,
      isPlaying: false,
    });
  }

  function onVideoPlay() {
    if (!isHost || !isInSession || suppressEvents) return;
    if (isAdPlaying()) return;

    const video = getVideoElement();
    if (video && video.seeking) return;

    const time = video ? video.currentTime : (player ? player.getCurrentTime() : 0);
    const videoId = getVideoId();
    const rate = video ? video.playbackRate : 1;

    console.log(`[YT-Sync] Host played at ${time.toFixed(2)}s`);
    lastState = 1;
    lastTime = time;

    postToContent({
      type: 'player-event',
      action: 'play',
      videoId,
      currentTime: time,
      playbackRate: rate,
      isPlaying: true,
    });
  }

  function onVideoSeeked() {
    if (!isHost || !isInSession || suppressEvents) return;

    if (seekDebounceTimer) clearTimeout(seekDebounceTimer);
    seekDebounceTimer = setTimeout(() => {
      const video = getVideoElement();
      if (!video) return;
      const time = video.currentTime;
      const videoId = getVideoId();
      const isPlaying = (player && typeof player.getPlayerState === 'function')
        ? (player.getPlayerState() === 1 || player.getPlayerState() === 3)
        : !video.paused;
      const rate = video.playbackRate || 1;

      console.log(`[YT-Sync] Host seeked to ${time.toFixed(2)}s (isPlaying: ${isPlaying})`);
      lastTime = time;
      lastCheckTimestamp = Date.now();

      postToContent({
        type: 'player-event',
        action: 'seek',
        videoId,
        currentTime: time,
        playbackRate: rate,
        isPlaying,
      });

      reportPosition();
    }, 40);
  }

  function attachVideoListeners() {
    const video = getVideoElement();
    if (!video || video === attachedVideo) return;

    if (attachedVideo) {
      attachedVideo.removeEventListener('pause', onVideoPause);
      attachedVideo.removeEventListener('play', onVideoPlay);
      attachedVideo.removeEventListener('seeked', onVideoSeeked);
    }

    attachedVideo = video;
    video.addEventListener('pause', onVideoPause);
    video.addEventListener('play', onVideoPlay);
    video.addEventListener('seeked', onVideoSeeked);
    console.log('[YT-Sync] Attached video event listeners');
  }

  function initPlayer() {
    console.log('[YT-Sync] YouTube player ready');
    lastVideoId = getVideoId();
    attachVideoListeners();

    postToContent({ type: 'player-ready' });

    // Monitor playback state changes (every 100ms for ultra-responsive host control)
    setInterval(checkPlayerState, 100);

    // Watch for in-page YouTube SPA navigations
    window.addEventListener('yt-navigate-finish', onPageNavigated);
  }

  function onPageNavigated() {
    attachVideoListeners();
    if (!isInSession || !isHost) return;
    const newId = getVideoId();
    if (newId && newId !== lastVideoId) {
      lastVideoId = newId;
      console.log(`[YT-Sync] Host navigated to: ${newId}`);
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

  function setVideoRate(rate) {
    const video = getVideoElement();
    if (video) {
      if (Math.abs(video.playbackRate - rate) > 0.002) {
        video.playbackRate = rate;
      }
    }
  }

  // ─── Player State Monitoring (Authoritative Host Poller) ─────────

  function checkPlayerState() {
    if (!player || suppressEvents || !isInSession || !isHost) return;
    if (isAdPlaying()) return;

    attachVideoListeners();

    try {
      const state = player.getPlayerState();
      const video = getVideoElement();
      const time = video ? video.currentTime : player.getCurrentTime();
      const videoId = getVideoId();
      const rate = player.getPlaybackRate ? player.getPlaybackRate() : 1;
      const now = Date.now();
      const elapsedSec = (now - lastCheckTimestamp) / 1000;
      lastCheckTimestamp = now;

      // 1. Detect Video Change on Host
      if (videoId && lastVideoId && videoId !== lastVideoId) {
        lastVideoId = videoId;
        console.log(`[YT-Sync] Poller detected video change to: ${videoId}`);
        postToContent({
          type: 'player-event',
          action: 'video-change',
          videoId,
          currentTime: time,
          playbackRate: rate,
          isPlaying: (state === 1),
        });
        lastTime = time;
        lastState = state;
        return;
      } else if (videoId && !lastVideoId) {
        lastVideoId = videoId;
      }

      // 2. Detect Play on Host (transition into state 1 from any other state)
      if (state === 1 && lastState !== 1) {
        console.log(`[YT-Sync] Poller detected PLAY: ${time.toFixed(2)}s`);
        lastState = 1;
        lastTime = time;
        postToContent({
          type: 'player-event',
          action: 'play',
          videoId,
          currentTime: time,
          playbackRate: rate,
          isPlaying: true,
        });
        return;
      }

      // 3. Detect Pause on Host (transition into state 2 from non-2)
      if (state === 2 && lastState !== 2) {
        // If currently seeking, let seeked event handle it
        if (!video || !video.seeking) {
          console.log(`[YT-Sync] Poller detected PAUSE: ${time.toFixed(2)}s`);
          lastState = 2;
          lastTime = time;
          postToContent({
            type: 'player-event',
            action: 'pause',
            videoId,
            currentTime: time,
            playbackRate: rate,
            isPlaying: false,
          });
          return;
        }
      }

      // 4. Detect Seek on Host (unexpected jump in currentTime)
      if (lastTime !== -1 && elapsedSec > 0 && elapsedSec < 1.0) {
        const expectedProgression = (state === 1) ? (elapsedSec * rate) : 0;
        const jump = Math.abs((time - lastTime) - expectedProgression);

        // A jump of > 0.8s backwards or forwards is definitely a user seek
        if (jump > 0.8) {
          console.log(`[YT-Sync] Poller detected SEEK: ${lastTime.toFixed(2)}s -> ${time.toFixed(2)}s`);
          const isPlaying = (state === 1 || state === 3);
          postToContent({
            type: 'player-event',
            action: 'seek',
            videoId,
            currentTime: time,
            playbackRate: rate,
            isPlaying,
          });
        }
      }

      lastState = state;
      lastTime = time;
    } catch (e) {
      player = findPlayer();
    }
  }

  // ─── Follower Video Synchronization Helper ───────────────────────

  function syncFollowerVideo(targetVideoId, startTime = 0, isPlaying = true) {
    if (isHost || !targetVideoId) return false;
    const curId = getVideoId();

    if (curId === targetVideoId) {
      pendingLoadVideoId = null;
      return false;
    }

    // Guard: do not re-trigger load if already commanded within 4 seconds
    const now = Date.now();
    if (pendingLoadVideoId === targetVideoId && (now - pendingLoadTimestamp) < 4000) {
      return true;
    }

    pendingLoadVideoId = targetVideoId;
    pendingLoadTimestamp = now;

    console.log(`[YT-Sync] Follower loading host video: ${targetVideoId} (start: ${startTime.toFixed(2)}s, isPlaying: ${isPlaying})`);
    lastVideoId = targetVideoId;
    const startSec = Math.floor(startTime || 0);

    if (player) {
      try {
        if (isPlaying && typeof player.loadVideoById === 'function') {
          player.loadVideoById(targetVideoId, startSec);
          return true;
        } else if (!isPlaying && typeof player.cueVideoById === 'function') {
          player.cueVideoById(targetVideoId, startSec);
          return true;
        }
      } catch (e) {
        console.warn('[YT-Sync] player load error, falling back to href:', e);
      }
    }

    // Direct URL navigation (works from homepage, search, etc.)
    window.location.href = `https://www.youtube.com/watch?v=${targetVideoId}&t=${startSec}`;
    return true;
  }

  // ─── Autoplay-Safe Playback ──────────────────────────────────────

  function startPlaybackSafe() {
    const video = getVideoElement();
    if (video) {
      const p = video.play();
      if (p && p.catch) {
        p.catch((err) => {
          console.warn('[YT-Sync] Autoplay muted fallback:', err.message);
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
    if (isHost) return;

    // 1. Ensure follower is on the host's video
    if (msg.videoId && syncFollowerVideo(msg.videoId, msg.currentTime || 0, msg.isPlaying)) {
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
            syncFollowerVideo(msg.videoId, 0, msg.isPlaying);
          }
          break;
        }

        case 'play': {
          if (msg.currentTime !== undefined) {
            const curTime = video ? video.currentTime : player.getCurrentTime();
            if (Math.abs(curTime - msg.currentTime) > 0.08) {
              if (player.seekTo) player.seekTo(msg.currentTime, true);
              if (video) video.currentTime = msg.currentTime;
            }
          }
          setVideoRate(baseRate);
          startPlaybackSafe();
          break;
        }

        case 'pause': {
          if (player.pauseVideo) player.pauseVideo();
          if (video) video.pause();
          if (msg.currentTime !== undefined) {
            if (player.seekTo) player.seekTo(msg.currentTime, true);
            if (video) video.currentTime = msg.currentTime;
          }
          setVideoRate(baseRate);
          break;
        }

        case 'seek': {
          if (msg.currentTime !== undefined) {
            if (player.seekTo) player.seekTo(msg.currentTime, true);
            if (video) video.currentTime = msg.currentTime;
          }
          setVideoRate(baseRate);
          if (msg.isPlaying) {
            startPlaybackSafe();
          } else {
            if (player.pauseVideo) player.pauseVideo();
            if (video) video.pause();
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
      lastCheckTimestamp = Date.now();
    }, 350);
  }

  function applyFullState(msg) {
    if (isHost) return;

    if (msg.videoId && syncFollowerVideo(msg.videoId, msg.currentTime || 0, msg.isPlaying)) {
      return;
    }

    if (!player) player = findPlayer();
    if (!player) {
      setTimeout(() => applyFullState(msg), 400);
      return;
    }

    suppressEvents = true;

    try {
      const video = getVideoElement();
      if (msg.currentTime !== undefined) {
        if (player.seekTo) player.seekTo(msg.currentTime, true);
        if (video) video.currentTime = msg.currentTime;
      }

      setVideoRate(msg.playbackRate || 1);

      if (msg.isPlaying) {
        startPlaybackSafe();
      } else {
        if (player.pauseVideo) player.pauseVideo();
        if (video) video.pause();
      }
    } catch (e) {
      console.error('[YT-Sync] Error applying state:', e);
    }

    setTimeout(() => {
      suppressEvents = false;
      lastState = player ? player.getPlayerState() : -1;
      const v = getVideoElement();
      lastTime = v ? v.currentTime : (player ? player.getCurrentTime() : -1);
      lastCheckTimestamp = Date.now();
    }, 500);
  }

  // ─── Follower Drift Correction (FOLLOWER FOLLOWS HOST CLOCK) ─────

  function handleDriftCorrection(msg) {
    if (isHost || suppressEvents) return;
    if (isAdPlaying()) return;

    const targetVideoId = msg.videoId;
    const targetTime = msg.targetTime !== undefined ? msg.targetTime : msg.hostTime;
    if (targetTime === undefined || targetTime < 0) return;

    // 1. Ensure follower matches host video
    if (targetVideoId && syncFollowerVideo(targetVideoId, targetTime, msg.isPlaying)) {
      return;
    }

    if (!player) player = findPlayer();
    if (!player) return;

    try {
      const state = player.getPlayerState();
      const video = getVideoElement();
      const myTime = video ? video.currentTime : player.getCurrentTime();
      const baseRate = msg.playbackRate || 1.0;

      // 2. Play / Pause state synchronization
      if (!msg.isPlaying) {
        // Host is PAUSED -> Follower MUST be paused
        if (state === 1 || state === 3) {
          if (player.pauseVideo) player.pauseVideo();
          if (video) video.pause();
        }
        if (Math.abs(myTime - targetTime) > 0.05) {
          if (player.seekTo) player.seekTo(targetTime, true);
          if (video) video.currentTime = targetTime;
        }
        setVideoRate(baseRate);
        return;
      } else {
        // Host is PLAYING -> Follower MUST be playing
        if (state !== 1 && state !== 3) {
          if (Math.abs(myTime - targetTime) > 0.08) {
            if (player.seekTo) player.seekTo(targetTime, true);
            if (video) video.currentTime = targetTime;
          }
          setVideoRate(baseRate);
          startPlaybackSafe();
          return;
        }
      }

      // 3. Both are playing -> continuous phase alignment
      if (msg.isPlaying && state === 1) {
        const drift = myTime - targetTime; // positive = follower ahead, negative = follower behind
        const absDrift = Math.abs(drift);

        // A) Within 25ms: In phase!
        if (absDrift < 0.025) {
          setVideoRate(baseRate);
          return;
        }

        // B) Large drift (> 1.2s): Hard seek to snap in place
        if (absDrift > 1.200) {
          suppressEvents = true;
          if (player.seekTo) player.seekTo(targetTime, true);
          if (video) video.currentTime = targetTime;
          setVideoRate(baseRate);
          setTimeout(() => {
            suppressEvents = false;
            lastState = player ? player.getPlayerState() : -1;
            const v = getVideoElement();
            lastTime = v ? v.currentTime : (player ? player.getCurrentTime() : -1);
            lastCheckTimestamp = Date.now();
          }, 250);
          return;
        }

        // C) Micro-drift (25ms to 1.2s): Proportional smooth rate adjustment (±1.5% to ±7%)
        const adjustment = Math.min(0.07, Math.max(0.015, absDrift * 0.12));
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

    const video = getVideoElement();
    const isPlaying = video ? (!video.paused && player.getPlayerState() === 1) : (player.getPlayerState() === 1);

    if (document.hidden && !isPlaying) return;

    try {
      const videoId = getVideoId();
      if (!videoId) return;

      const currentTime = video ? video.currentTime : player.getCurrentTime();

      postToContent({
        type: 'position-response',
        currentTime,
        isPlaying,
        playbackRate: player.getPlaybackRate ? player.getPlaybackRate() : 1,
        videoId,
        clientTimestamp: Date.now(),
      });
    } catch (e) {}
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
      case 'ping':
        postToContent({
          type: 'player-ready',
          hasPlayer: !!player,
          videoId: getVideoId(),
        });
        break;

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
          setTimeout(reportPosition, 50);
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
