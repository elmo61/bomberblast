/* ─── BomberBlast signaling server ───────────────────────────────────────────
 * The game itself is peer-to-peer (WebRTC): the room host's browser runs the
 * authoritative simulation and talks directly to each guest. This server does
 * NOT run any game logic. Its only jobs are:
 *   1. Serve the static client.
 *   2. Hand out room codes and validate joins.
 *   3. Relay the one-time WebRTC handshake (offer / answer / ICE) between peers.
 * Once the data channels are open, no gameplay traffic touches this server.
 * ──────────────────────────────────────────────────────────────────────────── */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Room registry ────────────────────────────────────────────────────────────
// code → { hostId, members:Set<socketId>, started:boolean }
const rooms = new Map();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(id) ? generateRoomId() : id;
}

// ─── Signaling ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let roomCode = null;   // room this socket belongs to

  socket.on('createRoom', ({ name }) => {
    if (!name || typeof name !== 'string') return;
    const id = generateRoomId();
    rooms.set(id, { hostId: socket.id, members: new Set([socket.id]), started: false });
    roomCode = id;
    socket.emit('roomCreated', { roomId: id, hostId: socket.id });
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    if (!name || typeof name !== 'string' || !roomId) return;
    const rid = String(roomId).toUpperCase().trim();
    const room = rooms.get(rid);

    if (!room)                  return socket.emit('joinError', 'Room not found');
    if (room.started)           return socket.emit('joinError', 'Game already in progress');
    if (room.members.size >= 4) return socket.emit('joinError', 'Room is full (max 4 players)');

    room.members.add(socket.id);
    roomCode = rid;
    socket.emit('roomJoined', { roomId: rid, playerId: socket.id, hostId: room.hostId });
    // Tell the host to open a WebRTC connection to this new guest.
    io.to(room.hostId).emit('peerJoined', { peerId: socket.id });
  });

  // Host signals the match has begun → lock out late joiners.
  socket.on('startGame', () => {
    const room = rooms.get(roomCode);
    if (room && room.hostId === socket.id) room.started = true;
  });

  // Host returned everyone to the lobby → allow joins again.
  socket.on('reopenRoom', () => {
    const room = rooms.get(roomCode);
    if (room && room.hostId === socket.id) room.started = false;
  });

  // Relay a WebRTC handshake message to a specific peer, tagged with the sender.
  socket.on('signal', ({ to, kind, data }) => {
    if (!to) return;
    io.to(to).emit('signal', { from: socket.id, kind, data });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.members.delete(socket.id);

    if (socket.id === room.hostId) {
      // Host left: end the room for everyone (v1 — no host migration).
      for (const id of room.members) io.to(id).emit('hostLeft');
      rooms.delete(roomCode);
    } else {
      // Guest left: tell the host to tear down that peer connection.
      io.to(room.hostId).emit('peerLeft', { peerId: socket.id });
      if (room.members.size === 0) rooms.delete(roomCode);
    }
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`BomberBlast signaling server running at http://localhost:${PORT}`);
});
