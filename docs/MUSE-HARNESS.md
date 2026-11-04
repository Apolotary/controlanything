# Muse on the Mac bridge

ControlAnything's Mac server hosts a small agent harness for the selected device's **gesture-programming request**. It uses Muse Spark through Meta's API with native function calls and streamed tool arguments. It is our own harness, not an integration of Hermes or Muse Code. No additional agent daemon, model weights or browser automation service is required.

```text
Quest: select object + explicit voice/chip request
    → Mac bridge: driver setup + Muse tool loop ↔ Meta API
    → static checks + synthetic dry-run + device-action verification
    → checked JavaScript in the Quest Worker
    → fast allowed control events → Mac companion connector → instrument
```

The model does not process every hand frame. WebXR provides the Quest signals; generated code maps them in its sandboxed Worker. The Mac server authorizes, clamps and rate-limits outputs to the selected connector. Driver generation remains the existing Muse step, using the manifest or reviewed MIDI chart; the new tool loop replaces wiring generation. General questions, object research and experimental Canvas remain separate Muse paths.

## What the agent can do

| Tool | Actual operation |
|---|---|
| `inspect_selected_device` | Reads this request's selected driver, connector, actions, ranges and capability hints. Cannot select another target or send a command. |
| `inspect_gesture_signals` | Reads the supported hand/screen Signals API and program restrictions. |
| `check_program` | Accepts generated JavaScript, validates it and dry-runs synthetic hand/screen traces. Returns real errors for repair or an artifact hash after success. Sends no device command. |
| `finish_program` | Returns only the exact successful checked artifact by hash, after both inspections. It does not authorize a device or prove a physical effect. |

The existing bridge then verifies the actions and publishes `wire.ready`. A model saying “done” cannot replace those checks. Program generation uses only `muse-spark-1.3`; an unexpected response model is rejected before its tools execute. No generic shell, arbitrary network, sound-unlock or unreviewed hardware tool is exposed. No implicit template is installed after failure.

The loop is bounded to eight model turns, sixteen tool calls, ninety seconds and a reported token budget. Stop, replacement and disconnect cancel the job; retired results cannot publish readiness. There is no new runtime model in the hand-frame path.

If a selected-object observation is available, its timestamp and image are supplied in an actual multimodal API message. Its age is stated. A missing or cached frame is never called a live view. Receipt metadata records availability and age; image bytes and prompts are omitted from the receipt API.

## Start and inspect

Use the normal server command with a Meta key in the untracked environment:

```sh
CE_DEMO=1 CE_MAC_SILENT=1 npm start
```

Ask on the selected Quest card as usual. Actual code/progress continues through the existing AR and companion code views. Previews reflect received API chunks; a whole program can arrive in one chunk, with no artificial typing. The owner can inspect:

- `GET /api/agent/harness`: backend, model/source, tool list and the latest fifty process-local run receipts.
- `GET /api/agent/harness/runs/<wiring-id>`: a specific run, including actual tool outcomes and the checked artifact hash.
- `GET /api/muse/calls`: actual model calls and usage.
- `GET /api/agent/targets` and `/api/agent/exec`: separate device verification and executor receipts.

Harness receipts require an owner bearer token or trusted localhost. They omit API keys, image data, prompts, code and raw tool arguments. `outcome: checked` means static validation and synthetic dry-run passed. `currentlyAuthorized` is derived from the bridge's current wiring; it becomes false after Stop or replacement. Neither field proves that a real device effect occurred. Receipts are held in memory and reset on server restart.

Fixture mode runs a **scripted tool conversation** through the same dispatch, validator and finish checks. It is labelled FIXTURE and makes no live model call. It proves software integration, not autonomous Muse decisions or headset tracking quality. Keep fixture, live-API probes and real-Quest results separate in the acceptance record.

## Why this harness

[Muse Code](https://dev.meta.ai/docs/muse-code) is Meta's first-party coding harness with an [official TypeScript SDK](https://github.com/meta-models/muse-code-sdk). It is a viable later backend, but its CLI is not installed here. [Hermes supports custom model endpoints](https://hermes-agent.nousresearch.com/docs/integrations/providers); the older installed version has not been integrated or verified with Muse. The user's Hermes profile is unchanged.

The embedded harness reuses the existing connector, cancellation and verification infrastructure. [Meta documents both custom agents and third-party harnesses using its API](https://dev.meta.ai/docs/coding-agents). That technical support is not a Hermes-specific hackathon ruling. This prototype preserves the project's stricter Meta-only runtime requirement.

Connector apps must still expose a supported manifest and executor. The visual and musical instruments provide these; physical MIDI also needs reviewed permissions and attended effect verification. This harness does not automatically control arbitrary applications or invent missing APIs.
