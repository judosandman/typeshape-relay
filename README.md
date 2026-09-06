# Type Shape relay

The multiplayer matchmaker for [Type Shape](https://studiojudo.com/bluenotes).
One file, one dependency (`ws`).

The WebSocket handling used to be hand-rolled, which worked locally and failed
behind Render's proxy: the proxy re-originates the handshake with a key of its
own and then forwards the origin's `Sec-WebSocket-Accept` unchanged, so the
browser sees an accept computed from a key it never sent and refuses the
connection. `ws` is what the platform expects to be talking to.

The game itself is hosted on GoDaddy, which serves static files but cannot run
a WebSocket server. This is the piece that has to live somewhere that can. It
pairs whoever is currently searching, hands both sides the same seed, names one
of them the host, and after that only forwards messages. It never looks inside
a forwarded message: the rules live in the page.

## Deploying

Any host that supports WebSockets and Node will do. It reads `PORT` from the
environment and answers `/health`.

On Render: New → Web Service → this repo → Node, `npm install`, `npm start`,
health check path `/health`.

Then point the game at it. In `index.html`:

```js
var RELAY = "wss://<your-service>.onrender.com/ws";
```

It must be `wss://`, not `ws://` — the page is served over https, and a `ws://`
socket is blocked as mixed content, which fails silently and looks exactly like
an unreachable server.

## Running it locally

Locally this same file serves the game *and* the relay, so `RELAY` stays empty:

```
node serve.js
```

There is a Python twin of it in the game folder (`serve.py`) for machines
without Node. Same protocol; either can be deployed.
