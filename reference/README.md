# Reference sources

Shallow clones used while designing and verifying `pi-run-fold`. They are
git-ignored: they are large, third-party, and only needed when you want to read
the code that the design depends on.

| Directory | Upstream | Pinned commit | Date |
| --- | --- | --- | --- |
| `pi/` | https://github.com/earendil-works/pi | `e4ce7b4` (v0.85.1) | 2026-09-18 |
| `pi-tool-display/` | https://github.com/MasuRii/pi-tool-display | `91cef75` (v0.5.0) | 2026-07-03 |

Refresh them with:

```bash
rm -rf reference/pi reference/pi-tool-display
git clone --depth 1 https://github.com/earendil-works/pi.git reference/pi
git clone --depth 1 https://github.com/MasuRii/pi-tool-display.git reference/pi-tool-display
```

Two more references live in the `99percentpeople/pi-extensions` checkout that
this prototype grew out of (see the main README):

```text
~/programming/pi-extensions/extensions/thinking-fold
~/programming/pi-extensions/extensions/cursor-effect
```
