"""Beeps (a synthesized WAV played with aplay/afplay) and speech (espeak on the DevTerm, say on a Mac)."""
import io
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import wave

MAX_RATE_HZ = 3.0  # photosensitivity/annoyance cap shared with every other surface


def wav_bytes(freq=2000.0, ms=120, count=1, interval_ms=1000, rate=22050, volume=0.6):
    """`count` pips of `freq` Hz, each `ms` long, starting every `interval_ms` (>= 1000/3 ms)."""
    freq = max(100.0, min(8000.0, float(freq)))
    ms = max(20, min(1000, int(ms)))
    count = max(1, min(8, int(count)))
    interval_ms = max(int(1000 / MAX_RATE_HZ) + 1, int(interval_ms), ms + 20)
    n_on = int(rate * ms / 1000.0)
    n_period = int(rate * interval_ms / 1000.0)
    ramp = max(1, int(rate * 0.004))  # 4 ms fades: no clicks
    amp = int(32767 * max(0.0, min(1.0, volume)))
    frames = bytearray()
    for i in range(count):
        for k in range(n_on):
            env = min(1.0, k / float(ramp), (n_on - 1 - k) / float(ramp))
            frames += struct.pack("<h", int(amp * env * math.sin(2 * math.pi * freq * k / rate)))
        if i < count - 1:
            frames += b"\x00\x00" * max(0, n_period - n_on)
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(bytes(frames))
    w.close()
    return buf.getvalue()


def player_command():
    if sys.platform == "darwin" and shutil.which("afplay"):
        return ["afplay"]
    for cmd in (["aplay", "-q"], ["paplay"], ["play", "-q"]):
        if shutil.which(cmd[0]):
            return cmd
    return None


def speech_command():
    if sys.platform == "darwin" and shutil.which("say"):
        return ["say"]
    for cmd in (["espeak-ng"], ["espeak"], ["spd-say", "-w"]):
        if shutil.which(cmd[0]):
            return cmd
    return None


class Sound(object):
    """Starts sounds without blocking; remembers the running process so panic can stop it."""

    def __init__(self, mute=False):
        # --mute: never start a player or a speech engine (for a machine that must stay silent); acks say so
        self.mute = mute
        self._proc = None
        self._lock = threading.Lock()
        self._tmp = None

    def _start(self, argv):
        with self._lock:
            self.stop_locked()
            self._proc = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
            return self._proc

    def beep(self, freq=2000.0, ms=120, count=1, interval_ms=1000):
        """Returns (started, detail). Falls back to the terminal bell when no audio player exists."""
        if self.mute:
            return False, "muted (--mute): %d x %d Hz not played" % (max(1, int(count)), int(freq))
        cmd = player_command()
        if not cmd:
            return False, "no audio player (aplay/afplay)"
        data = wav_bytes(freq, ms, count, interval_ms)
        fd, path = tempfile.mkstemp(prefix="ce-beep-", suffix=".wav")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        self._cleanup_tmp()
        self._tmp = path
        self._start(cmd + [path])
        return True, "%d x %d Hz %d ms via %s" % (count, int(freq), int(ms), cmd[0])

    def say(self, text):
        if self.mute:
            return False, "muted (--mute): not spoken"
        cmd = speech_command()
        if not cmd:
            return False, "no speech engine (install espeak: sudo apt install espeak)"
        self._start(cmd + [text])
        return True, "speaking via %s" % cmd[0]

    def wait(self, timeout=None):
        p = self._proc
        if p is None:
            return
        try:
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.stop()

    def stop(self):
        with self._lock:
            self.stop_locked()

    def stop_locked(self):
        p = self._proc
        self._proc = None
        if p is not None and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    p.kill()
                except OSError:
                    pass

    def _cleanup_tmp(self):
        if self._tmp:
            try:
                os.unlink(self._tmp)
            except OSError:
                pass
            self._tmp = None
