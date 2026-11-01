// Dev-only cross-check of the vendored Python QR encoder against the independent JS `qrcode`
// package in the repo's node_modules. Reads JSON cases on stdin: [{text, ecl, version, mask}],
// prints one matrix per case as rows of 0/1. Run via scripts/qr_crosscheck.py.
'use strict';
const QRCode = require('qrcode');

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const cases = JSON.parse(input);
  const out = cases.map((c) => {
    const q = QRCode.create([{ data: Buffer.from(c.text, 'utf8'), mode: 'byte' }], {
      errorCorrectionLevel: c.ecl,
      version: c.version,
      maskPattern: c.mask,
    });
    const n = q.modules.size;
    const rows = [];
    for (let y = 0; y < n; y++) {
      let r = '';
      for (let x = 0; x < n; x++) r += q.modules.get(y, x) ? '1' : '0';
      rows.push(r);
    }
    return { version: q.version, mask: q.maskPattern, rows };
  });
  process.stdout.write(JSON.stringify(out));
});
