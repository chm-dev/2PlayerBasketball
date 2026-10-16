'use strict';
// POC online multiplayer server:
//  - serves the static game files (index.html, game.js, assets)
//  - simple lobby: pairs waiting clients into 2-player rooms
//  - relays messages between the two clients of a room
//    host (player 1, Red) sends simulation snapshots/events,
//    guest (player 2, Blue) sends touch input.
// The game simulation itself runs in the host's browser; the server never
// touches game state, it just forwards messages.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); return res.end(); }
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// ------------------------------------------------------------- lobby
const waiting = [];       // sockets queued for a match
const rooms = new Map();  // room key -> { host, guest }
let roomSeq = 0;

wss.on('connection', ws => {
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }

    // join the lobby queue; the server pairs clients as they arrive
    if (m.t === 'join') {
      if (ws.room || waiting.includes(ws)) return;
      waiting.push(ws);
      tryPair();
      return;
    }

    // anything else is relayed to this socket's room partner
    const room = ws.room;
    if (!room) return;
    const partner = ws === room.host ? room.guest : room.host;
    if (!partner || partner.readyState !== 1) return;
    // whitelist by role so a client can only send its own message kinds
    const base = ws === room.guest ? ['g', 'm', 'r'] : ['s', 'e'];
    const allowed = base.concat('ping', 'pong');   // latency probes go both ways
    if (allowed.includes(m.t)) partner.send(JSON.stringify(m));
  });

  ws.on('close', () => {
    const i = waiting.indexOf(ws);
    if (i >= 0) waiting.splice(i, 1);
    const room = ws.room;
    if (!room) return;
    rooms.delete(room.key);
    ws.room = null;
    const partner = ws === room.host ? room.guest : room.host;
    if (partner) {
      partner.room = null;
      if (partner.readyState === 1) safeSend(partner, { t: 'opp_left' });
    }
  });
});

function tryPair() {
  while (waiting.length >= 2) {
    const a = waiting.shift(), b = waiting.shift();
    if (a.readyState !== 1) { if (b.readyState === 1) waiting.unshift(b); continue; }
    if (b.readyState !== 1) { waiting.unshift(a); continue; }
    const room = { key: 'r' + (++roomSeq), host: a, guest: b };
    rooms.set(room.key, room);
    a.room = room; b.room = room;
    safeSend(a, { t: 'room', role: 'host' });   // player 1, Red, south half
    safeSend(b, { t: 'room', role: 'guest' });  // player 2, Blue, north half
  }
}

function safeSend(ws, m) { try { ws.send(JSON.stringify(m)); } catch (e) { /* ignore */ } }

server.listen(PORT, () => console.log(`Basketball server on http://localhost:${PORT}`));
