# ControlAnything: architecture

The default flow is **Annotate → tag → Control → ask → Muse writes, deploys and tests → interact → Stop**. Selecting or tagging an object never installs an interaction. The [acceptance record](DEMO-ACCEPTANCE.md) distinguishes software checks from observed hardware behavior.

## Object selection and deliberate control

Meta SAM 3.1 supplies outlines from camera frames. A pinch identifies/tags an object and stays in Annotate. The wearer deliberately enters Control and selects the tagged device. **Ask Muse** is available immediately; a missing executor shows connection instructions and **Connect Mac**. The wearer does not need to press Set up or Enable first on the default agent path.

Visual synth and Music are explicit optional instruments under More. A detected laptop remains that physical object until the wearer deliberately selects a software demo. Pairing and connection alone do not start generation. `CE_PREFETCH` is off by default; `CE_PREFETCH=1` is a disclosed rehearsal option.

## The Muse coding agent

`apps/server/src/agent/muse-agent.ts` runs a bounded tool loop using **muse-spark-1.3** through Meta's streaming API. Each selected-card `wire.request` supplies the request, available observation and its age, companion MIDI outputs, instrument capability manifests, gimbal connection status and local agent notes.

Muse can speak a short progress line, use bash and workspace files, open visuals, deploy a connector, test an action and finish with controls and/or a hand program. It writes ordinary Node connector code into the Mac agent workspace. The host launches `node <entry>` as a background process and reads JSON lines. Tools and generated connectors have real local coding/process access: this prototype is a trusted local demonstration, not a hostile-code hosting service. A command denylist is not a security sandbox. See [security review](SECURITY-REVIEW.md).

Limits are 24 turns, 40 tools and five minutes by default (`CE_AGENT_BUDGET_MS` changes the duration). Muse must deploy and test before finishing. Unknown actions and invalid hand programs are rejected. Without a Meta key, fixture mode executes an explicitly labelled scripted tool conversation; this is software integration evidence, not live autonomous generation. No implicit template replaces failed live generation.

```text
Quest camera / WebXR poses → SAM outlines → Annotate pinch/tag
Explicit Control + ask → wire.request → Muse Spark tool loop on Mac
Muse → workspace files → deploy_connector → Node connector process
Muse → test_action → actual executor acknowledgements → finish
wire.ready → generated AR instrument / fallback controls + optional hand program
AR widgets or Quest Worker → control.event wire:<action> → current connector
Connector JSON lines → MIDI / gimbal bridge → exec.ack → logs
Stop → revoke wiring + queued outputs + retire connector
```

## Runtime components

| Component | Responsibility |
|---|---|
| `packages/protocol` | Zod message schemas, including correlated wiring epochs, connector actions and generated controls. |
| `apps/server` | HTTP :8787 / HTTPS :8443, pairing, Meta adapters, agent tools, connector lifecycle, action dispatch and static apps. Model API keys remain on the Mac. |
| `apps/quest` | Camera, WebXR hands/head pose, Horizon UI, generated spatial controls, the automatic screen plane (fixed by the first touch) and optional generated-program Worker. |
| `agent/connector-host.ts` | Starts the generated Node service; sends `set`, `trigger`, `stop`; accepts `midi`, `gimbal`, `log`, `ready` JSON lines. MIDI and gimbal operations pass through the bridge/executor route. |
| `apps/companion` | Chrome pairing, single-executor Web Locks, Web MIDI/Serial and the visual/musical instruments. Details shows running Muse connectors, entry files, actions, recent logs and Stop. |
| `packages/gen3d` | Bounded declarative spatial controls and compiler; no arbitrary generated scene JavaScript is evaluated in the XR renderer. |
| `packages/vsynth` | Authored WebGL water/visual renderer and Web Audio instrument capability manifests. Muse writes the glue, not these engines. |
| `apps/sim` | Explicit simulated camera/executors for emulator checks; never physical-device proof. |

The agent's `finish.ui` composer supports keys, pads, XY surfaces, encoders, faders, wheels, rings, levers and buttons. The server validates bindings against deployed actions and compiles a bounded `ce.gen3d/1` spec. The headset uses the existing spatial renderer; older control rows remain the fallback. Visualization follows outgoing values and is not an audio analyser or independent physical measurement.

## Two places generated code runs

The **connector** is a Node service on the Mac, with local runtime permissions. It uses `ce.mjs` for paired MIDI and gimbal output. Other Node integrations can use the local process's permissions; do not describe it as sandboxed arbitrary code.

The optional **hand program** is the body of `wire(s, out, mem)` and runs in a restricted Quest Web Worker. It reads `s.left`, `s.right`, `s.screen`, `s.t`, `s.dt`, keeps bounded state in `mem` and calls `out.set` / `out.trigger`. Server validation and synthetic dry-run check source, signals and declared actions before `wire.ready`. On-headset output gates and the server route check current wiring IDs, allowlists, ranges and rates. There is no model call per hand frame. The Mac companion receives device commands; it does not run the hand program.

A screen-touch program runs at once, with no setup step: the screen plane is guessed from the detected laptop or monitor (SAM gives the direction; its depth is a size-prior guess), and the wearer's first fingertip rest on the glass fixes the depth. Until then the program sees no screen. Two-corner calibration remains a manual fallback (card Details → Recalibrate screen). A hand-only instrument needs no screen. Dials are optional: useful actions must also support natural pressing, poking or hand gestures.

## Stop, sound and evidence

**Stop Muse** cancels generation from the selected card. Both palms stop the current wiring and connector; the selected object remains available for another ask. Wrist **Stop all** performs the full emergency stop. Disconnect, superseded session and hidden XR must not resume an old program. Keep one Quest tab and reload only outside AR with the wearer's approval.

Sound is on in demo startup: `CE_DEMO=1 CE_OSMO=web npm start`, without `CE_MAC_SILENT`. Browser audio unlocks after a user gesture. The shared master volume/mute covers browser/UI/water sounds and OS/browser speech. Muted automated runs are allowed. macOS `say`, Web Speech, WebXR tracking, Web MIDI and Web Bluetooth are OS/browser features, not model calls. Every runtime AI model remains Meta: SAM 3.1, Muse Spark, Muse Image, Muse Voice Transcribe and guarded Muse Wonder in applicable older paths.

An executor acknowledgement proves what that executor acknowledged. Renderer receipts describe software-applied state. The OM 4's live angle layout remains unconfirmed: a correlated successful rotate answer proves command acceptance, not measured position. The mock reports explicitly simulated angles. Audible results and physical effects require an attended observation.

## Legacy and experimental paths

`CE_AGENT=0` retains the older `LINK → RESEARCH → DRIVE → VERIFY / FORGE → ARM → WIRE` path and its explicit Set up / Enable gates. Its `MuseBridgeHarness`, bounded connector VM and patch-review Muse Code workshop are separate from the default Node coding agent. `/api/agent/connectors/legacy` describes the older generated encoder; `/api/agent/connectors` describes the current processes. Do not apply the old sandbox or setup claims to the default agent.

Canvas, saved gesture-map experiments, Motion lab and optional demos retain their own provenance. Recordings and fixture replays remain distinct from live model calls and real Quest takes. Review [reviewer modes](REVIEWER-DEMO.md) for mobile/browser capability limits.

## Development and current evidence

Use a separate fixture server/data directory on 8796+ and staged Vite outputs in `/tmp`; never empty live `dist`, stop the live server or reload an active headset. Serialize browser checks. `scripts/e2e-muse-agent.mjs` covers request, code, connector, controls and Stop. Focused unit checks cover parsing and validation; they do not establish headset comfort or timing.

Reported tonight: visual-synth and Air Theremin interactions worked on the real Quest; OP-1 notes/CCs arrived after MIDI receive was enabled on the instrument; small direct OM 4 Bluetooth moves worked. Muse-driven OM 4 interaction and the newly expanded UI still need attended hardware checks. Preserve those boundaries in submission copy.
