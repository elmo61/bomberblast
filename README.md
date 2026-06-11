# 💣 BomberBlast

A mobile-first, multiplayer **Bomberman-style** web game. The host creates a room,
shares a 6-character code, friends join from their phones, and the host starts the
match — classic top-down, tile-step bombing on a 15×13 grid.

## How it works

BomberBlast is **peer-to-peer**. The Node server is only a lightweight **signaling
broker** — it hands out room codes, validates joins, and relays the one-time WebRTC
handshake. After that, **gameplay traffic flows directly device-to-device** over
WebRTC data channels, so latency is low and the server does almost no work.

```
            ┌──────── Signaling server (Node + Socket.io) ────────┐
            │  room codes · join validation · WebRTC handshake     │
            └──────────────────────────────────────────────────────┘
                  ▲ used once, at join (a few KB)
                  │
   Host browser (AUTHORITY)              Guest browsers
   ┌──────────────────────┐  data ch    ┌──────────────┐
   │ 30 Hz game simulation │◀──────────▶│ input → host  │
   │ snapshots → everyone  │   (P2P)     │ host → render │
   └──────────────────────┘             └──────────────┘
```

- The **room host's browser** runs the authoritative 30 Hz simulation
  (`public/game-core.js`).
- Guests are thin clients: they send input and render the snapshots the host sends.
- Connectivity uses Google's public **STUN** server for NAT traversal. No TURN relay
  is configured, so play works on the same LAN and the large majority of home
  networks; very restrictive/symmetric NATs may not connect.

## Project layout

| File | Role |
|------|------|
| `server.js` | Signaling server (Express + Socket.io). No game logic. |
| `public/index.html` | Lobby / game / end screens. |
| `public/game.js` | Renderer, input, client-side prediction & reconciliation. |
| `public/game-core.js` | Authoritative game simulation (`GameCore` class). |
| `public/net.js` | Transport layer — signaling + WebRTC, hides host/guest split. |
| `public/style.css` | Pixel-art / warm UI styling. |

## Controls

- **Desktop:** WASD or arrow keys to move, Space / X / Z to drop a bomb.
- **Mobile:** on-screen D-pad + bomb button.

## Running locally

```bash
npm install
npm start          # or: npm run dev  (auto-restart on changes)
```

Then open **http://localhost:3000**.

- **Two players on one machine:** open the URL in two browser tabs — create in one,
  join with the code in the other.
- **Friends on the same WiFi:** they open `http://<your-LAN-IP>:3000` (find it with
  `ipconfig` on Windows / `ifconfig` on macOS/Linux).

## Deploying

Any Node host with **WebSocket support** works. The app is deploy-ready: `npm start`
runs the server and it binds to `process.env.PORT`.

A free **[Render](https://render.com)** Web Service is the simplest option:

1. Push this repo to GitHub.
2. Render → **New → Web Service** → connect the repo.
3. Accept the auto-detected Node defaults (build: `npm install`, start: `npm start`).

Render injects `PORT` and provides HTTPS + WebSockets automatically. (Free instances
sleep after ~15 min idle and cold-start in ~30 s.)

> **Note:** GitHub Pages alone won't work — it serves static files only and can't run
> the Node signaling server / WebSocket connection.

## Tech

Node.js · Express · Socket.io (signaling) · WebRTC data channels (gameplay) ·
HTML5 Canvas (pixel-art rendering).
