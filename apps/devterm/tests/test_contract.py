"""Contract tests: what this client sends (and the fixtures it parses) must validate against the JSON
Schemas that packages/protocol emits (`npm run build` -> packages/protocol/json-schema/*.json).

Skipped when the schemas are not next to the code (e.g. tests run from a copy on the DevTerm).
"""
import json
import os
import re
import unittest

import fixtures as fx

from ce_devterm import proto

SCHEMA_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "packages", "protocol", "json-schema"))


def load(type_):
    path = os.path.join(SCHEMA_DIR, "%s.json" % type_)
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return json.load(f)


def validate(schema, value, path="$"):
    """A JSON Schema subset validator (the keywords zod's toJSONSchema emits). Returns a list of errors."""
    errs = []
    if schema is True or schema == {}:
        return errs
    if "anyOf" in schema:
        if not any(not validate(s, value, path) for s in schema["anyOf"]):
            errs.append("%s: matches none of anyOf" % path)
        return errs
    if "oneOf" in schema:
        n = sum(1 for s in schema["oneOf"] if not validate(s, value, path))
        if n != 1:
            errs.append("%s: matches %d of oneOf" % (path, n))
        return errs
    for s in schema.get("allOf", []):
        errs += validate(s, value, path)
    if "const" in schema and value != schema["const"]:
        errs.append("%s: %r != const %r" % (path, value, schema["const"]))
    if "enum" in schema and value not in schema["enum"]:
        errs.append("%s: %r not in %r" % (path, value, schema["enum"]))
    t = schema.get("type")
    types = t if isinstance(t, list) else ([t] if t else [])
    if types:
        ok = False
        for ty in types:
            if ty == "object" and isinstance(value, dict):
                ok = True
            elif ty == "array" and isinstance(value, list):
                ok = True
            elif ty == "string" and isinstance(value, str):
                ok = True
            elif ty == "boolean" and isinstance(value, bool):
                ok = True
            elif ty == "integer" and isinstance(value, int) and not isinstance(value, bool):
                ok = True
            elif ty == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
                ok = True
            elif ty == "null" and value is None:
                ok = True
        if not ok:
            return errs + ["%s: %r is not %s" % (path, value, t)]
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errs.append("%s: shorter than %d" % (path, schema["minLength"]))
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errs.append("%s: longer than %d" % (path, schema["maxLength"]))
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errs.append("%s: does not match %s" % (path, schema["pattern"]))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errs.append("%s: %r < %r" % (path, value, schema["minimum"]))
        if "maximum" in schema and value > schema["maximum"]:
            errs.append("%s: %r > %r" % (path, value, schema["maximum"]))
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            errs.append("%s: %r <= %r" % (path, value, schema["exclusiveMinimum"]))
        if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
            errs.append("%s: %r >= %r" % (path, value, schema["exclusiveMaximum"]))
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errs.append("%s: fewer than %d items" % (path, schema["minItems"]))
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errs.append("%s: more than %d items" % (path, schema["maxItems"]))
        if isinstance(schema.get("items"), dict):
            for i, v in enumerate(value):
                errs += validate(schema["items"], v, "%s[%d]" % (path, i))
        for i, s in enumerate(schema.get("prefixItems") or []):
            if i < len(value):
                errs += validate(s, value[i], "%s[%d]" % (path, i))
    if isinstance(value, dict):
        props = schema.get("properties") or {}
        for k in schema.get("required") or []:
            if k not in value:
                errs.append("%s: missing %s" % (path, k))
        for k, v in value.items():
            if k in props:
                errs += validate(props[k], v, "%s.%s" % (path, k))
            elif schema.get("additionalProperties") is False:
                errs.append("%s: unexpected property %s" % (path, k))
            elif isinstance(schema.get("additionalProperties"), dict):
                errs += validate(schema["additionalProperties"], v, "%s.%s" % (path, k))
        if isinstance(schema.get("propertyNames"), dict):
            for k in value:
                errs += validate(schema["propertyNames"], k, "%s{%s}" % (path, k))
    return errs


@unittest.skipUnless(os.path.isdir(SCHEMA_DIR), "packages/protocol/json-schema not found")
class ContractTest(unittest.TestCase):
    def check(self, msg):
        schema = load(msg["type"])
        if schema is None:
            self.skipTest("no schema for %s" % msg["type"])
        errs = validate(schema, msg)
        self.assertEqual(errs, [], "%s: %s" % (msg["type"], errs[:5]))

    def test_hello(self):
        self.check(proto.envelope("hello", proto.hello("tok", proto.CAPABILITIES, app="ce-devterm@0.1.0")))
        self.check(proto.envelope("hello", proto.hello("tok", proto.BASE_CAPS)))

    def test_control_events(self):
        self.check(proto.envelope("control.event", proto.control_event("h_off", True, spec_id="spec_light", phase="end")))
        self.check(proto.envelope("control.event", proto.control_event("h_bright", 80, spec_id="spec_light", phase="move")))
        self.check(proto.envelope("control.event", proto.control_event("morph", {"x": 0.2, "y": 0.4})))
        self.check(proto.envelope("control.event", proto.control_event("kit", 0.8, index=3)))

    def test_exec_ack(self):
        self.check(proto.envelope("exec.ack", proto.exec_ack("ex1", True, 1730500000123, detail="printed 412 dot rows", latency_ms=12.5), to="server"))
        for code in proto.EXEC_ERRORS:
            self.check(proto.envelope("exec.ack", proto.exec_ack("ex1", False, 1, detail="x", error=code), to="server"))

    def test_typed_command_and_panic(self):
        self.check(proto.envelope("voice.text", {"text": "undo", "final": True, "utteranceId": proto.new_id("u"), "cardId": "card_light", "specId": "s"}, to="server"))
        self.check(proto.envelope("panic", {"reason": "panic key on DevTerm"}, to="server"))

    def test_fixtures_are_realistic(self):
        self.check(fx.env("ui.spec", fx.light_ui_spec()))
        self.check(fx.env("verify.result", fx.evidence()))
        self.check(fx.exec_command({"kind": "local", "op": "print", "arg": {"title": "RECEIPT", "lines": ["a"], "models": ["muse-spark-1.3"]}}))
        self.check(fx.exec_command({"kind": "local", "op": "beep", "arg": {"freq": 2000, "count": 3, "ms": 120}}))

    def test_pairing_request_capabilities(self):
        schema = load("pair.start")
        if schema is None:
            self.skipTest("no pair.start schema")
        body = {"name": "DevTerm", "kind": "devterm", "capabilities": proto.CAPABILITIES}
        self.assertEqual(validate(schema, proto.envelope("pair.start", body)), [])


if __name__ == "__main__":
    unittest.main()
