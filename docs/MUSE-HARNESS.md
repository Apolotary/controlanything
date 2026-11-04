# Muse on the Mac bridge

ControlAnything has two agent lanes on the Mac: a small harness for the selected device's **gesture-programming request**, and **native Muse Code for connector development**. Both use Muse Spark through Meta's API. Native coding starts only for an explicit development task; it is not an always-running background agent.

## Native coding access

The installed, pinned Muse Code 1.4.14 host has real read/search/write/edit and terminal tools. It can develop and debug project code, create bridge modules, inspect logs and run tests. It works in a retained project worktree with correctly linked local workspace packages and its own writable build caches. Native filesystem writes are scoped to that worktree; its OS-sandboxed shell can also read other permitted Mac files. This is real coding access, not the four gesture-program tools below, and it is not administrator access or unrestricted writes across the Mac.

Install the verified native host with `bash scripts/install-muse-code.sh`, then start the bridge normally. Open **Mac Details → Connector Workshop** at `/companion/coding/`. Enter a task and choose Start. Owner-authenticated APIs are `GET /api/agent/coding`, `POST /api/agent/coding/tasks`, and task metadata, patch and cancel routes beneath `/api/agent/coding/tasks/<id>`. Opening the page never starts a model job.

An explicit Ask Muse request such as **“Debug the USB-MIDI bridge for OP-1 Field”** also starts this coding lane. Normal requests such as “Touch the water” or “Write gesture controls” stay in the fast wiring lane. Connector development returns patch-review guidance on the selected card; it never publishes a patch as runnable `wire.ready` code. Review changes on the Mac before applying/deploying them. Stop/replacement cancels an XR-originated coding task; the workshop also has Cancel.

Each native job has its own branch, model usage, tool-event log, changed-file list and patch. `completed_unverified` means the agent finished its turn, not that tests or hardware passed. Actual test commands/results and an independent check are needed. Patches are retained and never automatically merged into the running demo. Native call usage is recorded as an explicitly labelled aggregate, with the actual reported call count rather than invented per-call timings.

Task files, logs and worktrees persist on disk. The workshop's latest-job index is process-local and resets when the bridge restarts; automatic history restoration and session resumption are not implemented. Jobs currently use restricted shell networking and the project's installed dependencies. Missing packages or access are reported rather than silently bypassing the sandbox.

The Meta key enters the host through stdin, not command arguments or the child tool environment. Muse settings/data are isolated without changing the user's Hermes or personal Muse profile. The host is pinned to Meta/Muse Spark, sandboxing stays on, and reminder agents, foreign personal context, web tools, session messaging and subagents are excluded from this coding toolset. Jobs are bounded and serialized. No-sound/no-hardware-actuation is an explicit job policy; this is not a claim that arbitrary terminal code is intrinsically incapable of calling Mac APIs. Physical MIDI effects still require the attended device check.

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

[Muse Code](https://dev.meta.ai/docs/muse-code) is Meta's first-party coding harness with an [official TypeScript SDK](https://github.com/meta-models/muse-code-sdk). The native coding lane uses its pinned headless CLI and actual JSONL events; the gesture lane uses our smaller native API loop. [Hermes supports custom model endpoints](https://hermes-agent.nousresearch.com/docs/integrations/providers); the user's Hermes profile is unchanged.

The embedded harness reuses the existing connector, cancellation and verification infrastructure. [Meta documents both custom agents and third-party harnesses using its API](https://dev.meta.ai/docs/coding-agents). That technical support is not a Hermes-specific hackathon ruling. This prototype preserves the project's stricter Meta-only runtime requirement.

Connector apps must still expose a supported manifest and executor. The visual and musical instruments provide these; physical MIDI also needs reviewed permissions and attended effect verification. This harness does not automatically control arbitrary applications or invent missing APIs.
