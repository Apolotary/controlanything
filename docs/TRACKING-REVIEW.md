# Recorded hand and head tracking

Open **Motion lab** from the Mac companion, or go to `/companion/tracking/`. This local viewer pairs a Quest recording with the wearer's tracked hand joints and head pose. It is a demonstration-data inspection and export tool; it does not estimate poses from arbitrary MP4s.

## Make a Quest take

1. Prepare the camera on the Quest launcher. Under **Record a demonstration**, choose **Record take** before entering AR.
2. Enter AR and perform a short interaction with both hands visible. The recorder samples head and hand poses at up to 30 Hz and records the existing passthrough camera stream, without audio. The camera video does not include the app's rendered AR panels.
3. Exit AR to finish the recording, then choose **Save take**. Wait for video finalization before saving. If the camera or browser encoder is unavailable, the take still contains telemetry and reports that video is missing.
4. Transfer the downloaded `take-….zip` to the Mac and import it in Motion lab. With an authorized USB connection, `adb pull /sdcard/Download/<take-name>.zip ~/Downloads/` copies a known take; it does not start a recording. The original ZIP stays on the headset.

Recording is bounded to 90 seconds, with separate memory limits for video, telemetry and image snapshots. A limit stops the take and preserves the data captured so far. No recording starts merely by opening the viewer.

## Review a take

Import the complete ZIP to load its video and tracking together. A `session.jsonl` can also be opened on its own. Older takes contain head poses only; absent hand data remains absent.

The timeline controls both video and pose playback. Inspect the wearer-relative and world views, hand-joint availability, head orientation and trajectory. Gaps and reference-space changes break tracks rather than inventing motion between them. Controller input is distinguished from articulated hand tracking.

You can attach a separate Quest video and adjust its time offset. Alignment remains approximate: media encoding and camera exposure are not hardware-synchronized with WebXR, and the passthrough camera's transform relative to the viewer is not calibrated. The spatial view is therefore displayed alongside the video, without claiming pixel-accurate RGB annotations. A separate compositor recording may have different crop, latency and field of view.

**Explore sample** shows explicitly synthetic data for trying the controls. Its provenance stays synthetic in exported data. It is not evidence of a successful Quest capture or a training result.

## Dataset interpretation

The export retains timestamps, pose validity, the 25-joint WebXR hand convention, positions in meters, quaternion orientation, source labels, reference-space boundaries and recorded interaction events. Coordinates use a right-handed frame with +Y up and the viewer looking along local −Z. An XR reference space is a session-local origin, not an externally surveyed room coordinate system.

This provides a useful starting point for reviewing paired observation, human motion and interaction data for physical AI experiments. Runtime tracking is an estimate, not independently measured ground truth. Robot retargeting, camera calibration, capture-time validation, task labels, coverage criteria and downstream training evaluation are separate work.

## Implementation and checks

- Quest capture: `apps/quest/src/replay/` and the app's recording controls.
- Local inspection, import and dataset export: `apps/companion/src/tracking/`.
- `npm run e2e:tracking` exercises an actual browser video encoder with a synthetic canvas stream, imports the resulting take, checks synchronization and export, and captures the viewer at desktop and narrow sizes. It does not access a physical camera, microphone or device executor.

The viewer uses local files, stays silent, and pauses playback when hidden. It does not connect to the device-control WebSocket or execute recorded commands.

Design reference: [Encord's egocentric hand-pose tracking example](https://encord.com/data-labs/hands-at-work-egocentric-hand-pose-tracking/). Tracking semantics follow the [WebXR hand-input specification](https://www.w3.org/TR/webxr-hand-input-1/); video chunks use [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/start). These references do not imply equivalent tracking accuracy.
