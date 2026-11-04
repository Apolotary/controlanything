# Third-party notices

ControlAnything's own code is licensed under [MIT](LICENSE). Third-party components and assets retain their own licence terms; the repository licence does not replace them.

Full, unmodified notice texts are included in each app's public assets:

- [Quest notice index](apps/quest/public/notices/index.html)
- [Mac companion notice index](apps/companion/public/notices/index.html)
- [Simulator notice index](apps/sim/public/notices/index.html)

In a built or hosted app these are available at `/quest/notices/`, `/companion/notices/` and `/sim/notices/`. Each index records installed package versions, original source filenames, inclusion reasons and SHA-256 hashes.

The [scope manifest](scripts/third-party-notices.manifest.json) covers the installed runtime dependency closure of the browser apps, server and shared packages, the optional browser-imported IWER emulator graph, supplemental Lucide icon attribution and the existing vendored mesh/font notices. This intentionally includes server-only notices such as Meta's SAM agreement; it is not a claim that every listed package is bundled into each browser app. Other development tools are outside this inventory. Vendored versions remain unspecified when their snapshot did not record one.

The existing [mesh licence](apps/quest/public/xr-profiles/LICENSE.md), [font provenance](apps/quest/public/fonts/README.txt), [Inter OFL](apps/quest/public/fonts/OFL-Inter.txt) and [JetBrains Mono OFL](apps/quest/public/fonts/OFL-JetBrainsMono.txt) remain alongside those assets. The notice bundle also preserves the full installed font licences, pmndrs/Horizon copyright grants and SAM agreement.

After the project's normal dependency installation, regenerate and verify using Node built-ins:

```sh
node scripts/bundle-third-party-notices.mjs
node scripts/bundle-third-party-notices.mjs --check
```

Vite copies these public assets into any app build without app code changes. To check a scratch build:

```sh
node scripts/bundle-third-party-notices.mjs --check --dist=companion=/absolute/path/to/scratch-build
```

The generator does not fetch, install, delete, build or deploy anything. Notice files are copied byte-for-byte; no licence text is synthesized. Re-run the generator when dependency or vendored asset notices change.
