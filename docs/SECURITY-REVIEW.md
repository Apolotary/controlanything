# Local security and publication review

Reviewed on 4 November 2026. This is a local hackathon prototype with a coding agent running under the Mac user's account. Publishing the source does not require publishing the running bridge, credentials, recordings or runtime data.

## Publication evidence

- The baseline audit covered all 344 reachable commits, 3,093 unique file blobs (72.1 MB), and the current tracked files. No private-key, known vendor-token, JWT, long credential-assignment or credential-bearing URL patterns were found. An exact comparison against the current local API key also found no matches. The reproducible command below additionally scans commit/tag text and nonignored new files.
- A read-only query of the configured origin found one remote head and no tags; that head was already reachable from the 44 local refs. The follow-up scan covered 351 commits plus current changes and compared five known local/environment secret values, with zero findings. No remote history outside that advertised scope was assumed to have been reviewed.
- `.env`, local certificates, paired-device credentials, generated connector workspaces, private research and logs are excluded from the current publication tree. No historical `.env` or private-key file was found. Two historical research notes contain technical helper/mobile plans; both were inspected and contain no credentials.
- The two checked-in `apps/quest/public/takes/` sessions declare synthetic emulator cameras. Their sampled images show the simulated room. They remain demo fixtures. OCR of the other 40 tracked raster assets found no credential patterns; OCR cannot prove the absence of secrets hidden in images.
- `npm audit --omit=dev --json` reported zero known production dependency vulnerabilities at review time. This is a registry advisory check, not a proof that dependencies have no defects.

## Fixed boundaries

- Browser API requests and WebSocket upgrades reject foreign Origins and unrecognized Host names, including DNS rebinding to loopback. Only the bridge's configured/bound HTTP and HTTPS ports share browser authority. Native clients without Origin still use normal pairing/authentication.
- Room diagnostics require a paired token or trusted loopback request. Code, connector logs and coding-agent receipts retain the stronger owner requirement. The public health/helper views intentionally retain connection/pairing guidance, without bearer tokens or camera frames.
- The separate Chrome Bluetooth pipe requires its own loopback page Origin and trusted Host before accepting a connection. A foreign page cannot replace the gimbal tab's socket.
- New uploaded takes go into `CE_DATA_DIR/takes/`, outside source assets and builds. Local replay works by default; LAN sharing requires the deliberate `CE_SHARE_TAKES=1` option. Uploads accept only a session log and JPEG frames, cap unpacked data at 64 MB, and reject duplicate files, traversal, executable web content and overwriting an existing take.
- Muse's file tools resolve symlinks before checking workspace/repository boundaries, including missing write paths and dangling symlinks. Repository `.env`, certificates, Git internals and private runtime data cannot be read through these tools. Shell startup skips user login configuration to avoid reloading credentials into the cleaned environment.
- Connector JSON output is schema checked before dispatch. Each deployment has its own generation, so queued output from an old process cannot inherit a replacement's authority. Stop admits only bounded neutral cleanup on previously used endpoints, reports actual cleanup acknowledgements, and terminates the owned Unix process group so forked helpers do not survive the connector.

## Repeat before publication

```sh
node scripts/audit-public.mjs --history
npm audit --omit=dev --json
npx vitest run apps/server/src/hub.test.ts apps/server/src/hub-policy.test.ts apps/server/src/takes.test.ts apps/server/src/agent/workspace-path.test.ts apps/server/src/devices/osmo/links.test.ts apps/server/src/agent/connector-host.test.ts
```

`audit-public.mjs` runs locally without uploads or credential validation. It reports rule names, file paths, line numbers and Git object IDs; it never prints matched secret values. A nonzero exit means a finding needs review (1), or the scan did not complete (2). A scratch Git-history check confirmed that a secret deleted from the latest checkout is still detected without printing its value.

The scan is deliberately conservative and pattern based. It cannot identify every possible credential format, recover hidden image content, validate third-party accounts, or cover future commits. A newly found historical credential requires revocation/rotation and a reviewed publication plan; deleting it from the latest file would leave its earlier Git object reachable.

## Runtime scope

Muse's Bash commands and generated Node connectors have the Mac user's OS permissions and network access. File-tool checks and command denylists are safeguards, not an OS security sandbox. The app therefore belongs on the user's trusted local setup; it is not a multi-user hosted coding service. Paired devices share a room, and owner devices can deliberately run generated code and device commands.

No history was rewritten, data deleted, credentials rotated, code pushed, repository made public, or live headset/server session restarted by this review. Public visibility remains a user decision.
