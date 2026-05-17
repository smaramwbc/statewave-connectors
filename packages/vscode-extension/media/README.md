# Marketplace assets

`icon.svg` is the source mark. The VS Code Marketplace requires a **PNG**
(128×128, ≤ ~1 MB) referenced by `package.json#icon`. Generate it before
publishing (kept out of git/build because it's a binary):

```sh
# any one of these:
npx svgexport media/icon.svg media/icon.png 128:128
# or
npx @resvg/resvg-js-cli media/icon.svg media/icon.png
```

Then add to `package.json`:

```json
"icon": "media/icon.png"
```

Still needed for a polished listing (binary, produced manually — see
`MARKETPLACE_READINESS.md`): banner, onboarding screenshots, and a short
GIF of the build → status-bar → ask flow.
