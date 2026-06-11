/* ─── Net ────────────────────────────────────────────────────────────────────
 * Transport façade that hides the host-vs-guest split from the UI (game.js).
 *
 *   • Signaling server (Socket.io) is used ONLY for room codes, join validation
 *     and relaying the one-time WebRTC handshake (offer / answer / ICE).
 *   • Gameplay is peer-to-peer over WebRTC data channels in a STAR topology:
 *     every guest opens one channel to the HOST; guests never talk to each other.
 *   • The host's browser owns the authoritative GameCore and ticks it at 30 Hz,
 *     pushing snapshots to all guests AND to its own renderer (zero latency).
 *
 * Public surface mirrors the old 6-out / 6-in socket API so game.js barely
 * changes: createRoom/joinRoom/startGame/sendInput/playAgain/exitToLobby and the
 * onRoomCreated/onRoomJoined/onLobbyState/onJoinError/onGameStart/onGameState
 * callbacks (plus onHostLeft).
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const TICK_MS = 1000 / 30;
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  const sig = io();              // signaling connection (handshake + lobby setup only)

  let core      = null;          // GameCore — host only
  let isHost    = false;
  let myId      = null;          // == signaling socket id
  let roomId    = null;
  let myName    = '';
  let loopHandle = null;

  // Host: peerId → { pc, ch, hasRemote }
  // Guest: keyed by the host's id (one entry)
  const peers   = new Map();
  // ICE candidates can arrive before the offer/answer that creates the peer or
  // sets its remote description — browsers trickle on their own schedule and the
  // relay doesn't guarantee offer-before-candidate ordering. Buffer per remote
  // id (independent of peer lifecycle) and flush once the remote desc is set.
  const pendingIce = new Map();  // remoteId → RTCIceCandidateInit[]
  let hostId    = null;          // guest only
  let hostCh    = null;          // guest only
  let lastLobby = null;          // last lobby payload seen (for exitToLobby on guest)

  const Net = {
    isHost: false,
    onRoomCreated: null, onRoomJoined: null, onLobbyState: null,
    onJoinError: null, onGameStart: null, onGameState: null, onHostLeft: null,
  };
  window.Net = Net;

  // ─── Wire helpers ───────────────────────────────────────────────────────────
  function send(ch, obj) {
    if (ch && ch.readyState === 'open') ch.send(JSON.stringify(obj));
  }
  function broadcast(obj) {
    for (const peer of peers.values()) send(peer.ch, obj);
  }

  function broadcastLobby() {
    const payload = { roomId, hostId: myId, players: core.lobbyMeta() };
    broadcast({ t: 'lobby', payload });
    lastLobby = payload;
    Net.onLobbyState && Net.onLobbyState(payload);
  }

  // ─── Host game loop ───────────────────────────────────────────────────────
  function startLoop() {
    stopLoop();
    loopHandle = setInterval(() => {
      const { gridChanged } = core.tick();
      const snap = core.snapshot(gridChanged);
      if (snap) {
        broadcast({ t: 'state', snap });
        Net.onGameState && Net.onGameState(snap);
      }
      if (core.state === 'ended') stopLoop();   // final snapshot already went out
    }, TICK_MS);
  }
  function stopLoop() {
    if (loopHandle) { clearInterval(loopHandle); loopHandle = null; }
  }

  // ─── WebRTC: host side (one peer per guest) ───────────────────────────────
  function createHostPeer(peerId) {
    if (peers.has(peerId)) return;
    const pc = new RTCPeerConnection(ICE);
    const ch = pc.createDataChannel('game', { ordered: true });
    const peer = { pc, ch, hasRemote: false };
    peers.set(peerId, peer);

    pc.onicecandidate = e => {
      if (e.candidate) sig.emit('signal', { to: peerId, kind: 'ice', data: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(peerId);
    };

    ch.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'hello') {
        core.addPlayer(peerId, msg.name);
        broadcastLobby();
      } else if (msg.t === 'rename') {
        core.renamePlayer(peerId, msg.name);
        broadcastLobby();
      } else if (msg.t === 'input') {
        core.setInput(peerId, msg.input);
      }
    };
    ch.onclose = () => dropPeer(peerId);

    pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .then(() => sig.emit('signal', { to: peerId, kind: 'offer', data: pc.localDescription }))
      .catch(err => console.warn('offer failed', err));
  }

  function dropPeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    try { peer.pc.close(); } catch (_) {}
    peers.delete(peerId);
    pendingIce.delete(peerId);
    if (core) { core.removePlayer(peerId); broadcastLobby(); }
  }

  // ─── WebRTC: guest side (single peer = host) ──────────────────────────────
  function createGuestPeer(theHostId) {
    hostId = theHostId;
    const pc = new RTCPeerConnection(ICE);
    const peer = { pc, ch: null, hasRemote: false };
    peers.set(theHostId, peer);

    pc.onicecandidate = e => {
      if (e.candidate) sig.emit('signal', { to: theHostId, kind: 'ice', data: e.candidate });
    };
    pc.ondatachannel = e => {
      hostCh = e.channel;
      peer.ch = hostCh;
      hostCh.onopen = () => send(hostCh, { t: 'hello', name: myName });
      hostCh.onmessage = ev => routeFromHost(JSON.parse(ev.data));
      hostCh.onclose = () => { Net.onHostLeft && Net.onHostLeft(); };
    };
    return peer;
  }

  function routeFromHost(msg) {
    if (msg.t === 'lobby') {
      lastLobby = msg.payload;
      Net.onLobbyState && Net.onLobbyState(msg.payload);
    } else if (msg.t === 'start') {
      Net.onGameStart && Net.onGameStart(msg.payload);
    } else if (msg.t === 'state') {
      Net.onGameState && Net.onGameState(msg.snap);
    }
  }

  // Add a candidate now if the remote description is set, else buffer it by id.
  function addOrQueueIce(remoteId, cand) {
    const peer = peers.get(remoteId);
    if (peer && peer.hasRemote) {
      peer.pc.addIceCandidate(cand).catch(() => {});
    } else {
      if (!pendingIce.has(remoteId)) pendingIce.set(remoteId, []);
      pendingIce.get(remoteId).push(cand);
    }
  }

  // Mark a peer's remote description as set and drain any buffered candidates.
  function flushIce(remoteId, peer) {
    peer.hasRemote = true;
    const q = pendingIce.get(remoteId);
    if (q) {
      for (const c of q) peer.pc.addIceCandidate(c).catch(() => {});
      pendingIce.delete(remoteId);
    }
  }

  // ─── Signaling events ─────────────────────────────────────────────────────
  sig.on('roomCreated', ({ roomId: rid, hostId: hid }) => {
    isHost = true; Net.isHost = true;
    myId = hid; roomId = rid;
    core = new GameCore();
    core.addPlayer(myId, myName);
    Net.onRoomCreated && Net.onRoomCreated({ roomId: rid, playerId: myId });
    broadcastLobby();
  });

  sig.on('roomJoined', ({ roomId: rid, playerId }) => {
    isHost = false; Net.isHost = false;
    myId = playerId; roomId = rid;
    Net.onRoomJoined && Net.onRoomJoined({ roomId: rid, playerId: myId });
    // Host will send an offer + lobby broadcast shortly.
  });

  sig.on('joinError', msg => { Net.onJoinError && Net.onJoinError(msg); });

  // Host learns a guest joined → kick off the WebRTC handshake.
  sig.on('peerJoined', ({ peerId }) => { if (isHost) createHostPeer(peerId); });
  sig.on('peerLeft',   ({ peerId }) => { if (isHost) dropPeer(peerId); });
  sig.on('hostLeft',   () => { if (!isHost) Net.onHostLeft && Net.onHostLeft(); });

  // Relayed WebRTC handshake. ICE candidates are buffered by sender id until the
  // matching offer/answer sets the remote description, so candidate-before-offer
  // ordering (which varies by browser) can't drop them.
  sig.on('signal', async ({ from, kind, data }) => {
    if (kind === 'ice') {
      addOrQueueIce(from, data);
      return;
    }
    if (isHost) {
      if (kind === 'answer') {
        const peer = peers.get(from);
        if (!peer) return;
        await peer.pc.setRemoteDescription(data);
        flushIce(from, peer);
      }
    } else {
      if (kind === 'offer') {
        const peer = peers.get(from) || createGuestPeer(from);
        await peer.pc.setRemoteDescription(data);
        flushIce(from, peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        sig.emit('signal', { to: from, kind: 'answer', data: peer.pc.localDescription });
      }
    }
  });

  sig.on('connect_error', () => { Net.onJoinError && Net.onJoinError('Connection error — refresh the page.'); });

  // ─── Public actions ───────────────────────────────────────────────────────
  Net.createRoom = function (name, code) {
    myName = name;
    sig.emit('createRoom', code ? { name, roomId: code } : { name });
  };

  // Change your display name while in the lobby. Host updates its own GameCore
  // and rebroadcasts; a guest tells the host, who does the same.
  Net.setName = function (name) {
    if (!name) return;
    myName = name;
    if (isHost) {
      if (core) { core.renamePlayer(myId, name); broadcastLobby(); }
    } else {
      send(hostCh, { t: 'rename', name });
    }
  };
  Net.joinRoom   = function (code, name) { myName = name; sig.emit('joinRoom', { roomId: code, name }); };

  Net.startGame = function () {
    if (!isHost) return;
    sig.emit('startGame');                // lock the room against late joiners
    core.start();
    const payload = { mapW: GameCore.MAP_W, mapH: GameCore.MAP_H, grid: core.grid, players: core.lobbyMeta() };
    broadcast({ t: 'start', payload });
    Net.onGameStart && Net.onGameStart(payload);
    startLoop();
  };

  Net.sendInput = function (input) {
    if (isHost) core.setInput(myId, input);
    else send(hostCh, { t: 'input', input });
  };

  Net.playAgain = function () {
    if (!isHost) return;
    stopLoop();
    sig.emit('reopenRoom');
    core.returnToLobby();
    broadcastLobby();
  };

  Net.exitToLobby = function () {
    if (isHost) { stopLoop(); sig.emit('reopenRoom'); core.returnToLobby(); broadcastLobby(); }
    else if (lastLobby) Net.onLobbyState && Net.onLobbyState(lastLobby);
  };
})();
