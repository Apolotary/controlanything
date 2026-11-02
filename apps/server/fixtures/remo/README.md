# Nature Remo fixtures

`messages.sample.json` is a **synthetic** `GET /messages` body in the Remo local API's format
(`{"format":"us","freq":38,"data":[µs …]}`): the curated AEHA "off" code of the Panasonic-style ceiling
light (`data/devices`, `lib:panasonic/ch1/off`) rendered twice with a 30 ms gap, marks stretched ~8 % the way
receivers report them, followed by the long silence a Remo stores after a press. It feeds the mock Remo in
`src/devices/remo.test.ts`; nothing here was read from a real Remo. Real captures of the room's light will be
added as `*.learned.json` when the user runs the learn pass with the Remo.
