# Muse on the Mac

The default selected-device route is the **Muse coding agent**, implemented in `apps/server/src/agent/muse-agent.ts`. It uses Meta **muse-spark-1.3** streaming tool calls. Tag an object in Annotate, deliberately choose Control and **Ask Muse**. There is no default Set up / Enable ceremony and no interaction before the request.

## What Muse actually does

Muse receives the selected observation (with timestamp), companion MIDI outputs, visual/musical capability manifests, gimbal connection state and its retained `NOTES.md`. It writes a connector, deploys it as a Node process on the Mac, tests an action and reads the real acknowledgements. It can repair the files and redeploy before publishing controls or a hand program.

| Tool | Effect |
|---|---|
| `say` | Short progress line in AR and optional macOS system speech. |
| `bash` | Shell command in the workspace; output/time bounded and dangerous commands denied. This is real local coding access, not an OS sandbox. |
| `read_file`, `write_file`, `edit_file` | Inspect allowed project/workspace files and edit connector files in the workspace. |
| `open_visuals` | Ask the paired Mac to open the explicit visual instrument. |
| `deploy_connector` | Start/restart `node <entry>` with declared actions; return startup/crash output. |
| `test_action` | Send an action to that process and inspect its logs and executor acknowledgements. |
| `finish` | Validate action bindings and optional hand-program validation/dry-run, then return the generated instrument. |

Default limits: 24 turns, 40 tools, five minutes (`CE_AGENT_BUDGET_MS`). Every runtime model call is Meta. Credentials stay server-side; child process environment is reduced. Generated Node code still has local process permissions. Run only as a trusted local prototype; [security review](SECURITY-REVIEW.md) describes publication and deployment boundaries.

## Connector and hand-program hosts

The retained agent workspace is under `CE_DATA_DIR/muse-agent` (normally `apps/server/.data/muse-agent`). `ce.mjs` provides `onSet`, `onTrigger`, `onStop`, MIDI helpers, gimbal helpers, `log` and `ready`. The connector speaks JSON lines over stdin/stdout:

```text
in:  set / trigger / stop
out: midi / gimbal / log / ready
```

MIDI uses the paired Chrome companion's actual output names, including the explicit virtual instruments. Gimbal output uses the Osmo bridge. Stop/replacement retires the service. Local files and learned notes persist; do not delete them as routine recovery.

Optional hand code runs on the **Quest Worker**, not in the companion or the connector host. It can call only the declared action interface after validation/dry-run. Touch code waits for screen calibration. Generated controls use validated declarative gen3d widgets, with the ordinary control row as fallback. Value visualization describes outgoing activity, not independent acoustic/angle measurement.

## Inspect and Stop

Mac **Details → Muse connectors** shows the entry file, running/exited state, actions, command/failure counts and recent logs. **Stop** uses the existing selected-card panic route. Opening Details or Refresh starts no model call or connector. Owner-only `GET /api/agent/connectors` supplies the same process status.

The Quest card's **Stop Muse** cancels a run before completion. Both palms stop current interaction; wrist **Stop all** stops everything. A cancelled or superseded result must not restore old controls. Match code, source, wiring/card IDs and executor logs before claiming a successful run.

For the live OM 4, a correlated rotate answer with code zero means command acceptance. Its angle push layout is unconfirmed, so a successful ack says **“sent; gimbal confirmed the command (no reliable angle measurement)”**. Do not repair a working connector merely because measured angles are unavailable. The mock explicitly reports simulated angles.

## Older tools, selected explicitly

With `CE_AGENT=0`, the previous setup/Enable route and smaller `MuseBridgeHarness` remain available. That harness uses `inspect_selected_device`, `inspect_gesture_signals`, `check_program`, `finish_program` and a restricted program check. Its `/api/agent/harness` receipts describe that older lane, not current Node connector runs.

The separate **Connector Workshop** at `/companion/coding/` retains native Muse Code project debugging in a task workspace with patch review. A completed native job does not automatically merge into the live app or establish hardware success. The older generated MIDI encoder uses `/api/agent/connectors/legacy`; its bounded VM differs from the default ordinary Node service.

## Verification

Fixture mode is a labelled scripted tool conversation and costs no Meta credits. `scripts/e2e-muse-agent.mjs` exercises the current agent path in the emulator, including cancellation and Stop. Build into staging, use a separate port/data directory and serialize browser checks. A fixture proves integration; a live API probe proves that particular model call; only an attended device run proves the observed physical effect. See [DEMO-ACCEPTANCE.md](DEMO-ACCEPTANCE.md).
