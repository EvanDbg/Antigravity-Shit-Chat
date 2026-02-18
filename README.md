# Antigravity Remote Dev Mobile Monitor v2.1

Need to go to the bathroom? But Opus 4.5 might be done with that big task soon? Want to eat lunch? But there's more tokens left before they reset right after lunch?

<img width="1957" height="1060" alt="screenshot" src="https://github.com/user-attachments/assets/95318065-d943-43f1-b05c-26fd7c0733dd" />

A real-time mobile interface for monitoring and interacting with Antigravity chat sessions.

## Features

- 🔐 **Password Login** — Cookie-based authentication to prevent unauthorized access
- 📱 **Real-time Monitoring** — Live chat snapshots via WebSocket, polls every 3 seconds
- 💬 **Message Injection** — Send messages directly from your phone
- 🖱️ **Click Passthrough** — Click IDE buttons from the web interface (forwarded via CDP)
- 🔌 **Offline Mode** — Friendly UI when Antigravity is not running
- 🚀 **Launch Button** — Start Antigravity with CDP enabled directly from the web
- ＋ **New Conversation** — Create new chat sessions from the web interface

## How It Works

The mobile monitor operates through three main components:

### 1. Reading (Snapshot Capture)
The server connects to Antigravity via Chrome DevTools Protocol (CDP) and periodically captures snapshots of the chat interface with full CSS styling.

### 2. Injecting (Message Sending)
Messages typed in the mobile interface are injected directly into Antigravity's chat input via CDP.

### 3. Click Passthrough
Clickable elements (buttons, links) in the snapshot are annotated with selectors. Clicking them in the web UI forwards the click to the actual IDE element.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure

Copy `config.example.json` to `config.json` and edit:

```bash
cp config.example.json config.json
```

```json
{
    "password": "your-password",
    "port": 3563,
    "antigravityPath": "",
    "cdpPorts": [9000, 9001, 9002, 9003]
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `password` | Login password | `shitchat` |
| `port` | Web server port | `3563` |
| `antigravityPath` | Path to Antigravity executable (empty = auto-detect) | Auto |
| `cdpPorts` | CDP ports to scan for Antigravity instances | `[9000-9003]` |

> **Auto-detect paths:**
> - **macOS**: `/Applications/Antigravity.app/Contents/MacOS/Antigravity` or `~/Applications/...`
> - **Windows**: `%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe`

### 3. Start Antigravity with CDP

**macOS:**
```bash
open -a Antigravity --args --remote-debugging-port=9000
```

> **Note:** If Antigravity is already running, `open` will just activate the window and ignore the arguments. You must **Quit Antigravity (Cmd+Q)** fully before running this command.

**Windows:**
```bash
antigravity . --remote-debugging-port=9000
```

> You will see: "Warning: 'remote-debugging-port' is not in the list of known options..." — that's fine.

### 4. Start the Monitor

```bash
npm start
```

### 5. Access from Mobile

Open your browser and navigate to:
```
http://<your-local-ip>:3563
```

Enter your password to log in.

## Problems?

Problems setting up? Can't find an explanation? **Open the Remote Dev folder in Antigravity and tell the agent what issues you are having**. It can read the code in one go.

---

This is over local network, so it will not work if you are on a different network, unless you use a VPN or Tailscale or something.

### Thanks to https://github.com/lukasz-wronski for finding bugs and https://github.com/Mario4272 for the original idea.
