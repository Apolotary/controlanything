# ControlEverything

Connect an AI agent to the physical world. A Meta Quest 3 in passthrough sees a device, a "malleable server" on the Mac
asks Meta's Muse models what it is and writes software to control it, and generated controls appear in the headset,
on a phone, or on the Mac. Built for the Meta Global AI Developer Hackathon (Nov 2026).

## Layout

| Path | What |
|---|---|
| `packages/protocol` | Wire protocol: zod schemas + TS types for every WebSocket message, pairing helpers, zod → JSON Schema (also used as Muse `response_format`). `npm run build` writes `json-schema/*.json` for non-TS clients. |
| `apps/server` | Node + Express + `ws`. HTTPS/WSS on `0.0.0.0:8443` (self-signed dev cert), HTTP/WS on `0.0.0.0:8787`, WebSocket hub at `/ws`, device pairing, Muse Spark + Voice Transcribe clients (`src/muse/`), static hosting of `/companion/` and `/quest/`. |
| `apps/companion` | Vite + TS web app for the Mac: pairing and approvals, presence, Web MIDI devices, test note, MIDI-in monitor, log. |

## Dev setup

Requires Node 22.12+ (developed on Node 26) and Chrome on the Mac (Web MIDI).

```sh
npm install
cp .env.example .env        # add MODEL_API_KEY for live Meta calls; leave it empty for FIXTURE mode
npm run dev                 # server (restarts on change) + companion build --watch
```

Open **http://localhost:8787/companion/** on the Mac. On localhost the page is the owner: it pairs itself instantly
and can approve other devices. Other scripts: `npm run build`, `npm run typecheck`, `npm test`, `npm run smoke`
(two WebSocket clients pair and exchange a `control.event` against the running server), `npm start` (no watch).

Without `MODEL_API_KEY` the server runs in **FIXTURE** mode: no network calls, canned replies labelled FIXTURE.
With `MUSE_RECORD=1` in live mode, keyed responses are saved to `apps/server/fixtures/recorded/`; fixture mode
replays them (still reported as `source: "fixture"` with `recordedFrom: <model id>`), so the demo runs from the repo
without a key. Every model call is logged with model id, latency and tokens, and listed at `GET /api/muse/calls`.

### Opening it on the Quest (or a phone)

- **LAN (HTTPS):** the server prints `https://<mac-lan-ip>:8443/quest/`. Open it in Quest Browser and accept the
  self-signed certificate warning once; the page and its WebSocket share the origin, so that covers both.
  WebXR, camera, mic and Web MIDI need this secure context.
- **USB:** `adb reverse tcp:8787 tcp:8787`, then open `http://localhost:8787/quest/` (localhost counts as secure).
  Over adb the headset looks like localhost to the server, so it is treated as the owner.

### Pairing (device-code style)

Every client is a paired device with a token. An unpaired device shows a QR code and a code like `K7Q-4M2`; a trusted
device approves it. Approvers: a paired quest, mac or iphone, any request from localhost, or the server terminal
(type `y`, or `y K7Q4M2` when several are waiting). Codes expire after 5 minutes and are single use.
`CE_TRUST_FIRST_DEVICE=1` approves the first device automatically. Paired devices live in
`apps/server/.data/space.json` (only token hashes are stored; revoke with `DELETE /api/devices/:id`).

For CLI/firmware clients (DevTerm, Cardputer):

```sh
curl -s -X POST http://<mac>:8787/api/pair/start -H 'content-type: application/json' \
  -d '{"name":"Cardputer","kind":"cardputer","capabilities":["ir","display"]}'
# -> {pairingId, code, display:"K7Q-4M2", qr:"https://<mac>:8443/p/<pairingId>#<code>", expiresAt, pollSecret, status:"pending"}
curl -s "http://<mac>:8787/api/pair/status?pairingId=<id>&pollSecret=<secret>"
# -> {status:"approved", deviceId, deviceToken}   (the token is returned once; store it)
# then connect ws://<mac>:8787/ws and send: {"v":1,"type":"hello","id":"1","ts":0,"from":"","payload":{"deviceToken":"…"}}
```

Port 8787 is plain HTTP/WS so microcontrollers can connect without TLS. It is token-authenticated but unencrypted:
use it on a trusted LAN only (set `HTTP_HOST=127.0.0.1` to keep it local).

## Protocol

Every message is `{v: 1, type, id, ts, from, to?, payload}` (see `packages/protocol/src`). The hub stamps `from` with
the sender's deviceId, relays to every other connection (or only to `to`; `to: "server"` stays on the server),
answers invalid messages with a `log` error, and drops `control.event`/`snapshot` for receivers that fall behind.
Types: `hello`/`welcome`, `presence`, `pair.start|status|approve|deny|pending|approved|denied`, `snapshot`,
`agent.step`, `device.card`, `ui.spec`, `control.event`, `driver.deploy`/`driver.status`, `log`, plus experimental
`x.*` types (envelope-checked only). Server code subscribes with `hub.onMessage()` and replies with
`hub.broadcast()` / `hub.sendToDevice()`.

## Meta models

Runtime model calls go only to the Meta Model API (`https://api.meta.ai/v1`): `muse-spark-1.3` for chat and vision
(`chat/completions` with image parts, `json_schema` → `json_object` → plain fallback, `reasoning_effort`,
`<think>` stripping) and `muse-voice-transcribe-1.0` (`asr/transcribe`, mono 16-bit WAV at 16/24 kHz).
The Muse client code was ported from FAMILIAR, the author's earlier project from this same hackathon.
