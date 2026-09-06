// Static server + multiplayer matchmaker for Type Shape (no dependencies).
//   node serve.js [port]
//
// Runs in two places. Locally it serves the game and matches players, which is
// all you need for development. Deployed on a host that allows WebSockets, it
// acts as the relay for a page served from somewhere that does not - set RELAY
// in index.html to this server's wss:// address. It reads PORT from the
// environment, which is how those hosts assign one.
//
// Two jobs. It serves index.html, and it runs a WebSocket endpoint at /ws that
// pairs up whoever is currently searching and then relays messages between the
// two of them. It never looks inside a relayed message - the game decides what
// they mean - so the rules live in one place, in the page.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
      if (url === "/") { res.writeHead(200).end("Type Shape relay is running. build 2"); return; }
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
});

/* ---------------- websocket, hand-rolled ---------------- */

const GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F";

/** One connected browser. */
class Peer {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.name = "PLAYER";
    this.partner = null;
    this.alive = true;
  }
  send(obj) {
    if (!this.alive) return;
    try { this.socket.write(frame(JSON.stringify(obj))); } catch (e) { /* closing */ }
  }
  close() {
    this.alive = false;
    try { this.socket.destroy(); } catch (e) {}
  }
}

/** Everyone waiting for an opponent, oldest first. */
const waiting = [];
const peers = new Set();

server.on("upgrade", (req, socket) => {
  if (req.url.split("?")[0] !== "/ws") { socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n" +
    // TEMPORARY: reports the key this process actually received, to find out
    // whether anything in front of it re-originates the handshake.
    "X-Relay-Key-Seen: " + key + "\r\n\r\n");
  socket.setNoDelay(true);

  const peer = new Peer(socket);
  peers.add(peer);
  socket.on("data", (chunk) => {
    peer.buffer = Buffer.concat([peer.buffer, chunk]);
    let msg;
    while ((msg = readFrame(peer)) !== null) {
      if (msg === CLOSED) { drop(peer); return; }
      if (msg !== "") handle(peer, msg);
    }
  });
  socket.on("error", () => drop(peer));
  socket.on("close", () => drop(peer));
});

function handle(peer, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }

  if (msg.t === "find") {
    peer.name = String(msg.name || "PLAYER").slice(0, 14).toUpperCase() || "PLAYER";
    unqueue(peer);
    partWays(peer, "left");
    // Pair with whoever has been waiting longest, so nobody starves.
    const other = waiting.shift();
    if (other && other.alive && other !== peer) {
      pair(other, peer);
    } else {
      waiting.push(peer);
      peer.send({ t: "searching" });
    }
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

function drop(peer) {
  if (!peers.has(peer)) return;
  peers.delete(peer);
  unqueue(peer);
  partWays(peer, "left");
  peer.close();
}

/* ---------------- framing ---------------- */

const CLOSED = Symbol("closed");

/** Server-to-client frames are never masked, and always a single text frame. */
function frame(text) {
  const payload = Buffer.from(text, "utf8");
  const n = payload.length;
  let head;
  if (n < 126) {
    head = Buffer.from([0x81, n]);
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/**
 * Pulls one complete frame out of the peer's buffer, or null if there is not
 * enough there yet. Returns CLOSED for a close frame, "" for anything we ignore
 * (ping/pong), and the text otherwise.
 */
function readFrame(peer) {
  const buf = peer.buffer;
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); offset = 10;
  }
  const maskKey = masked ? buf.slice(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.slice(offset, offset + len));
  peer.buffer = buf.slice(offset + len);
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];

  if (opcode === 0x8) return CLOSED;
  if (opcode !== 0x1) return "";          // ping, pong, binary: not our business
  return payload.toString("utf8");
}

server.listen(PORT, () => {
  console.log("Type Shape on http://127.0.0.1:" + PORT);
  console.log("multiplayer relay on ws://<this machine>:" + PORT + "/ws");
});
