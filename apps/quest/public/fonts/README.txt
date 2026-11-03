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

JetBrainsMono-Regular.ttf is the unmodified regular font from
https://github.com/JetBrains/JetBrainsMono/blob/master/fonts/ttf/JetBrainsMono-Regular.ttf
under the SIL OFL 1.1 in OFL-JetBrainsMono.txt. Helper pairing URLs use this
local file; opening the pairing card does not fetch a remote font.

muse-reader-inter.{json,png} and muse-reader-coverage.json are generated MSDF
assets from inter-latin-500-normal.woff, retaining the included Inter OFL.
Reproduce with node scripts/build-reader-font.mjs from the repository root.
The build script uses the pinned @zappar/msdf-generator dependency plus Node
built-ins; it never runs on the headset. The atlas contains the font's actual
229 printable cmap entries, including normal Muse punctuation and prices.
The UIKit full-text reader uses a system-font canvas for characters outside
this local atlas, preserving Unicode text without fetching a remote font.
System-font appearance and script coverage depend on the headset/browser OS.
