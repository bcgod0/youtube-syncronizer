# YouTube Sync — Multi-Device Synchronized Playback

A Chrome extension + WebSocket server system that synchronizes YouTube video playback across multiple devices with near-zero delay. Turn your devices into a synchronized multi-speaker system.

## Architecture

```
┌─────────────┐     WebSocket      ┌─────────────┐     WebSocket      ┌─────────────┐
│  Device A   │◄──────────────────►│  Sync Server │◄──────────────────►│  Device B   │
│  (Chrome)   │   Clock Sync +     │  (Node.js)   │   Clock Sync +     │  (Chrome)   │
│             │   Sync Commands    │              │   Sync Commands    │             │
└─────────────┘                    └─────────────┘                    └─────────────┘
```

### How Synchronization Works

1. **NTP-like Clock Sync**: Each client measures its clock offset from the server using multiple round-trip samples (picks the one with the lowest RTT for accuracy).

2. **Scheduled Execution**: When any device triggers play/pause/seek, the server computes a future wall-clock execution time (`now + max_RTT + buffer`) and broadcasts it. Every client schedules the action at that exact moment, adjusted for their clock offset.

3. **Drift Correction**: A periodic position-reporting loop detects drift between devices:
   - **< 30ms drift** → No action needed (imperceptible)
   - **30ms–100ms** → Gentle playback rate adjustment (±2%) 
   - **100ms–500ms** → Aggressive rate adjustment (±5%)
   - **> 500ms** → Hard seek to the correct position

## Quick Start

### 1. Start the Sync Server

```bash
cd server
npm install
npm start
```

The server will start on `ws://localhost:8765` by default.

### 2. Install the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `extension/` folder

### 3. Create a Session

1. Click the YT Sync extension icon in your toolbar
2. Enter the server URL (default: `ws://localhost:8765`)
3. Enter your name and click **Connect**
4. Click **Create Session** — you'll get a 6-character session code

### 4. Join from Other Devices

1. Install the extension on each device
2. Connect to the same server URL
3. Enter the session code and click **Join Session**

### 5. Play Music!

Open the same YouTube video on all devices. Play/pause/seek on any device and all others will follow in sync.

## Project Structure

```
├── server/
│   ├── package.json
│   └── server.js          # WebSocket sync server
│
└── extension/
    ├── manifest.json       # Chrome extension manifest (MV3)
    ├── background.js       # Service worker — WebSocket + clock sync
    ├── content.js          # Content script — bridges player ↔ background
    ├── injected.js         # Page script — direct YouTube player API access
    ├── popup.html          # Extension popup UI
    ├── popup.css           # Popup styles
    ├── popup.js            # Popup controller
    └── icons/              # Extension icons
```

## Network Deployment

For syncing across devices on different networks, deploy the server publicly:

```bash
# Using a cloud VM / VPS
PORT=8765 node server/server.js

# Or use a reverse proxy (nginx/caddy) with WebSocket support
```

Then update the server URL in the extension popup to `ws://your-server-ip:8765`.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `PORT` | `8765` | Server port (env variable) |
| Clock sync interval | 5s | How often clients re-sync clocks |
| Position report interval | 2s | How often drift is checked |
| Session timeout | 30 min | Inactive empty sessions are cleaned up |

## Limitations

- Works only on `youtube.com` (not embedded players)
- All devices must be on the same YouTube video page
- Audio sync precision depends on network latency (< 50ms RTT recommended)
- YouTube's internal buffering may add ~20-50ms of unavoidable jitter
