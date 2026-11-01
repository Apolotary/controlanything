"""Sample messages shaped like the server's (protocol v1; ui.spec as compiled by the forge)."""
import os
import sys
import time

_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)


def env(type_, payload, to=None, from_="server"):
    m = {"v": 1, "type": type_, "id": "m%s" % int(time.time() * 1e6), "ts": int(time.time() * 1000), "from": from_, "payload": payload}
    if to:
        m["to"] = to
    return m


def light_hackset():
    return {
        "spec": "ce.hackset/1",
        "device": {"id": "card_light", "name": "Ceiling light", "kind": "light", "channel": {"type": "ir", "via": "dev-card"}},
        "hacks": [
            {"id": "h_bright", "name": "Set brightness", "kind": "control", "blurb": "step room brightness up down",
             "params": [{"id": "p_bright", "name": "Brightness", "min": 0, "max": 100, "default": 70, "unit": "%", "step": 10}],
             "control": {"archetype": "slider", "param": "p_bright", "size": "m"},
             "commands": [{"action": "ir.brighter"}, {"action": "ir.darker", "delayMs": 400}],
             "oracle": {"type": "camera", "expect": "luminance_tracks_param"}, "reversible": True,
             "inverse": {"restore": "p_bright"}, "max_rate_hz": 2, "status": "verified"},
            {"id": "h_off", "name": "Turn light off", "kind": "action", "blurb": "turn ceiling light off",
             "commands": [{"action": "ir.off"}], "oracle": {"type": "camera", "expect": "off"}, "reversible": True,
             "inverse": {"commands": [{"action": "ir.full"}]}, "max_rate_hz": 1, "status": "ready"},
            {"id": "h_night", "name": "Set night glow", "kind": "action", "commands": [{"action": "ir.night"}],
             "oracle": {"type": "camera", "expect": "dimmer"}, "max_rate_hz": 1, "status": "failed"},
            {"id": "h_power", "name": "Toggle power", "kind": "control",
             "params": [{"id": "p_on", "name": "On", "min": 0, "max": 1, "default": 1}],
             "control": {"archetype": "toggle", "param": "p_on"}, "commands": [{"action": "ir.power", "param": "p_on"}],
             "oracle": {"type": "camera", "expect": "on"}, "max_rate_hz": 1},
        ],
        "daemons": [
            {"id": "d_breathe", "name": "Breathe to tempo", "blurb": "light follows the synth clock",
             "trigger": {"source": "device.card_op1f.clock_bpm"}, "map": {"curve": "sine", "range": [40, 100], "period_bars": 2},
             "targets": [{"hack": "h_bright", "param": "p_bright"}], "max_rate_hz": 2, "status": "running"},
        ],
        "modelId": "muse-spark-1.3",
        "source": "live",
    }


def light_gen3d(armed_bright=True):
    return {
        "spec": "ce.gen3d/1", "specId": "spec_light", "rev": 2, "title": "Ceiling light",
        "anchor": {"mode": "floating"},
        "state": {"armed": True, "reason": "1/4 actions verified on the device"},
        "controls": [
            {"id": "h_bright", "kind": "stepped", "label": "SET BRIGHTNESS", "range": {"min": 0, "max": 100, "step": 10},
             "unit": "%", "default": 70, "binding": {"action": "ir.brighter"}, "armed": armed_bright},
            {"id": "h_off", "kind": "trigger", "label": "TURN LIGHT OFF", "binding": {"action": "ir.off"}, "armed": False},
            {"id": "h_night", "kind": "trigger", "label": "SET NIGHT GLOW", "binding": {"action": "ir.night"}, "armed": False},
            {"id": "h_power", "kind": "toggle", "label": "TOGGLE POWER", "binding": {"action": "ir.power"}, "default": True, "armed": True},
        ],
        "parts": [{"id": "tag", "kind": "archetype", "archetype": "tag"}],
    }


def light_ui_spec(**kw):
    return {"specId": "spec_light", "cardId": "card_light", "driverId": "drv_light", "rev": 2, "title": "Ceiling light",
            "gen3d": light_gen3d(**kw), "hackset": light_hackset(), "source": "live", "modelId": "muse-spark-1.3"}


def v0_ui_spec():
    return {"specId": "spec_op1", "title": "OP-1 Field", "cardId": "card_op1f", "widgets": [
        {"id": "cutoff", "kind": "knob", "label": "Cutoff", "range": {"min": 0, "max": 127, "step": 1}, "default": 64,
         "binding": {"action": "midi.cc", "channel": 1, "cc": 1}},
        {"id": "chord", "kind": "button", "label": "Strike chord", "binding": {"action": "midi.note", "note": 60}},
        {"id": "hold", "kind": "toggle", "label": "Hold drone", "binding": {"action": "midi.cc", "cc": 64}},
        {"id": "morph", "kind": "xy", "label": "Morph", "binding": {"action": "midi.cc", "cc": 2}, "yBinding": {"action": "midi.cc", "cc": 3}},
        {"id": "kit", "kind": "pads", "label": "Pads", "binding": {"action": "midi.note"}, "pads": [{"label": "A"}, {"label": "B"}]},
    ]}


def evidence(pass_=True, delta=-0.38):
    return {"evidenceId": "ev1", "cardId": "card_light", "actionId": "ir.darker", "execId": "ex1", "attempt": 1,
            "sent": {"op": {"kind": "ir", "protocol": "NEC", "ref": "learned:3"}, "at": 1},
            "expected": {"sense": "camera", "effect": "dimmer"},
            "observed": {"sense": "camera", "metric": "luma-mask-vs-ring", "before": 1.2, "after": 0.82, "delta": delta, "threshold": 0.15},
            "pass": pass_}


def exec_command(op, executor="dev-1", dry=False, exec_id="ex42", type_="exec.command"):
    p = {"execId": exec_id, "executorDeviceId": executor, "op": op}
    if dry:
        p["dryRun"] = True
    return env(type_, p, to=executor)
