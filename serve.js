// Static server + multiplayer matchmaker for Type Shape.
//   node serve.js [port]
//
// Runs in two places. Locally it serves the game and matches players, which is
// all you need for development. Deployed on a host that allows WebSockets, it
// is the relay for a page served from somewhere that does not - set RELAY in
// index.html to this server's wss:// address. It reads PORT from the
// environment, which is how those hosts assign one.
//
// The WebSocket handling is `ws` rather than hand-rolled. A hand-rolled version
// worked locally and failed behind Render's proxy, which re-originates the
// handshake with a key of its own and then forwards the origin's
// Sec-WebSocket-Accept unchanged - so the client sees an accept computed from a
// key it never sent and refuses the connection. `ws` is what the platform
// expects to be talking to.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 5180;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  // Hosts ping a URL to decide whether the service is up, and a relay-only
  // deployment has no index.html to answer with.
  if (url === "/health") { res.writeHead(200).end("ok"); return; }
  const file = path.join(ROOT, url === "/" ? "index.html" : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (url === "/") { res.writeHead(200).end("Type Shape relay is running."); return; }
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
});

/* ---------------- matchmaking ---------------- */

const wss = new WebSocketServer({ server, path: "/ws" });

/** Everyone waiting for an opponent, oldest first. */
const waiting = [];

/** One connected browser. */
class Peer {
  constructor(socket) {
    this.socket = socket;
    this.name = "PLAYER";
    this.partner = null;
  }
  get alive() { return this.socket.readyState === this.socket.OPEN; }
  send(obj) {
    if (!this.alive) return;
    try { this.socket.send(JSON.stringify(obj)); } catch (e) { /* closing */ }
  }
}

wss.on("connection", (socket) => {
  const peer = new Peer(socket);
  socket.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    handle(peer, msg);
  });
  socket.on("close", () => { unqueue(peer); partWays(peer, "left"); });
  socket.on("error", () => { unqueue(peer); partWays(peer, "left"); });
});

function handle(peer, msg) {
  if (msg.t === "find") {
    peer.name = String(msg.name || "PLAYER").slice(0, 14).toUpperCase() || "PLAYER";
    unqueue(peer);
    partWays(peer, "left");
    // Pair with whoever has been waiting longest, so nobody starves.
    let other = null;
    while (waiting.length) {
      const candidate = waiting.shift();
      if (candidate.alive && candidate !== peer) { other = candidate; break; }
    }
    if (other) pair(other, peer);
    else { waiting.push(peer); peer.send({ t: "searching" }); }
    return;
  }

  if (msg.t === "cancel") { unqueue(peer); peer.send({ t: "cancelled" }); return; }

  if (msg.t === "leave") { partWays(peer, "left"); return; }

  // Everything else is the game's own business: hand it straight over.
  if (peer.partner && peer.partner.alive) peer.partner.send(msg);
}

function pair(a, b) {
  a.partner = b; b.partner = a;
  // One side has to arbitrate. The server picks, so both agree with no round trip.
  const seed = (Math.random() * 0xffffffff) >>> 0;
  a.send({ t: "start", seed: seed, host: true, opponent: b.name });
  b.send({ t: "start", seed: seed, host: false, opponent: a.name });
  console.log("paired " + a.name + " (host) with " + b.name);
}

function partWays(peer, why) {
  const other = peer.partner;
  peer.partner = null;
  if (other) {
    other.partner = null;
    if (other.alive) other.send({ t: why });
  }
}

function unqueue(peer) {
  const i = waiting.indexOf(peer);
  if (i >= 0) waiting.splice(i, 1);
}

server.listen(PORT, () => {
  console.log("Type Shape on http://127.0.0.1:" + PORT);
  console.log("multiplayer relay on ws://<this machine>:" + PORT + "/ws");
});
