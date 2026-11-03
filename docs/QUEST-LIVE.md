# Live Quest debugging

`npm run quest:live` mirrors the connected Quest to a local browser without reloading the XR app, forwarding input, capturing audio, or playing sound. It uses Android's compositor video output, not the app's camera preview, so it can show the room and AR interface together.

## Start

Requirements: Node, `adb`, and `ffmpeg` on the Mac; USB debugging already authorized on the Quest.

```sh
npm run quest:live
```

Open [the live viewer](http://localhost:8790/) in Chrome and wear the headset. The viewer reconnects when the headset wakes or USB returns. It shows one eye, with the display's optical cant corrected on the Mac. It limits browser updates to 6 fps by default to keep debugging overhead down.

The app server and Quest app do not need to restart. The viewer is separate from the app's companion and does not run device commands or model calls.

## Debug together

Keep the viewer running while explaining an issue in voice or chat. The assistant can retrieve the newest frame and compare it with app state. A running video feed does **not** give the assistant continuous autonomous perception: the assistant still inspects fresh frames at tool-call boundaries.

- `GET /status`: current state, frame sequence, arrival time, age, and measured delivery rate.
- `GET /frame.jpg`: latest fresh frame; returns 503 when the feed is unavailable or stale.
- `GET /stream.mjpg`: continuous multipart JPEG stream for the browser.
- The startup log prints a local `latest.jpg` and `status.json` path for tools that read local images. Always check the status or frame arrival time before describing a frame as current.

A stale stream is clearly labeled; it is not shown as live. Old frames are dropped for slow viewers rather than queued. Closing the tab alone does not stop capture: use **Stop sharing** in the viewer or Ctrl-C in its terminal.

## Privacy and lifecycle

The server binds only to loopback and rejects cross-site image/status requests. No remote service receives the video. No audio is captured or played, and no headset input is forwarded. Only the latest processed frame is kept in a temporary folder; it is replaced continuously and removed on a clean stop. No video history is saved.

The capture automatically retries on headset sleep, USB disconnect, decoder failure, or prolonged absence of frames. A clean stop terminates the capture and decoder children. This is a development tool, not an authenticated remote streaming service.

Optional environment settings:

- `ANDROID_SERIAL`: choose a device when more than one is connected.
- `QUEST_LIVE_PORT`: local port, default 8790.
- `QUEST_LIVE_FPS`: 1–12, default 6 to reduce conversion work and fan noise.
- `QUEST_LIVE_WIDTH`: even output width from 480–1600, default 960. Use 720 for a lighter preview.
- `QUEST_LIVE_DIR`: temporary current-frame directory; default is `ce-quest-live` under the operating system's temporary directory.

The default profile replaces the earlier 12 fps / 1100-pixel preview. Stop sharing when testing is finished; the server still captures while its browser tab is closed.

## Verification and platform limits

Passthrough plus WebXR overlays were directly observed on the development Quest 3 during this project's live debugging. That is device/firmware-specific evidence, not a guarantee for every Quest version. The headset must be awake; a sleeping headset may reject capture.

[AOSP's screenrecord implementation](https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/cmds/screenrecord/screenrecord.cpp) supports raw H264 to stdout and an unlimited time setting. The stream is decoded and converted to JPEG locally with ffmpeg. The JPEG parser is deliberately scoped to ffmpeg's output, not arbitrary uploaded JPEG metadata.

```sh
npm run test:quest-live
```
