HUD v2 fonts

inter-latin-{400,500,600}-normal.woff are unmodified copies from the installed
@fontsource/inter package (Inter v20). Copyright 2016 The Inter Project Authors.
All four fonts are distributed under the included SIL OFL 1.1 in OFL-Inter.txt.

ce-inter-tabular-600.woff is a derivative of the 600 weight. Its digit cmap
selects Inter's existing tnum glyphs because Troika does not expose that
OpenType feature. No outlines or metrics are changed. Internal family and
PostScript names identify it as CE Inter Tabular; copyright and licence
records are retained. The source licence declares no Reserved Font Names.

Reproduce every font from the repository root:
  node apps/quest/scripts/bundle-inter.mjs

The script uses only Node built-ins. Runtime text uses the local Latin fonts;
characters absent from that subset are displayed as ? instead of fetching a
fallback font from an external server. The verified check is drawn geometry.
