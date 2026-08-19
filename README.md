# MeloYtcipher

Remote configuration registry for the **Melo** music player. This repository
holds the runtime-adjustable playback configuration so that YouTube player
rotations can be fixed **without shipping a new APK**.

```
MeloYtcipher/
├── player_configs.json        # player hash -> sig/n function specifications
├── po_token.html              # BotGuard bridge payload (rarely changes)
├── tools/
│   └── update_configs.mjs     # automated config extractor + verifier
└── README.md
```

## How the app consumes this repo

The app bundles a copy of every file as an offline fallback and overlays it
with the remote copy at runtime. A failed remote fetch is silently ignored —
playback never depends on network availability for config.

| File | Remote URL | Refresh policy |
|------|------------|----------------|
| `player_configs.json` | `raw.githubusercontent.com/niksoriginals/MeloYtcipher/main/player_configs.json` | every 6h; forced immediately on a signature rejection |
| `po_token.html` | `raw.githubusercontent.com/niksoriginals/MeloYtcipher/main/po_token.html` | every 24h |

## When to update

Update this repository when playback breaks with `403` / `Source error` and the
app log shows:

```
echomusic_CipherFnExtract: No config for hash: <hash>
echomusic_CipherConfig: Remote config fetch HTTP 404
```

or when the check mode reports an uncovered hash (see below).

## Updating the config

**Requirements:** Node.js 18+

```bash
# 1. Clone (once)
git clone https://github.com/niksoriginals/MeloYtcipher.git
cd MeloYtcipher

# 2. Check whether the live player is already covered
node tools/update_configs.mjs --check

# 3. Update (only if the check reported an uncovered hash)
node tools/update_configs.mjs

# 4. Push
git add player_configs.json
git commit -m "Add player config for <hash>"
git push
```

The app picks up the change within 6 hours, or immediately on the next
signature rejection. No APK rebuild is required.

**No PC available?** Edit `player_configs.json` directly on GitHub and commit.
Note that extracting the `sig`/`nClass` values still requires the tool —
a player JS sample is needed to derive them.

## How the updater works

`tools/update_configs.mjs` is a self-verifying extractor:

1. Resolves the current player hash from YouTube's `/iframe_api`.
2. Downloads the matching `base.js`.
3. Evaluates the player in a sandboxed Node VM (browser API stubs provided).
4. Extracts the signature call site and verifies its inner function behaves
   identically to `decodeURIComponent` against test vectors.
5. Locates the `n` transform class and verifies it at runtime by transforming
   a probe value.
6. Extracts the `sts` timestamp.
7. If an existing entry already matches (`sig` + `nClass` + `sts`), the new
   hash is appended as an **alias**; otherwise a **new entry** is created.
   Entries stay sorted by `sts`.

An `--offline <path>` flag runs the same pipeline against a locally saved
`base.js` when the download route is unavailable.

## Config schema

```json
{
  "schemaVersion": 1,
  "players": {
    "66dd9fcc": {
      "sig": "pB(20,268,INPUT)",     // func(const,const,INPUT); INPUT = decodeURIComponent(sig)
      "nClass": "cY",                 // g.<name>(url, true).get("n")
      "sts": 20681,                   // signature timestamp
      "aliases": ["3891b194"]         // additional hashes sharing this spec
    }
  }
}
```

## FAQ

- **When should `po_token.html` change?** Only when BotGuard rotates and
  token minting fails (`PoTokenWebView` / `PoTokenAssetStore` errors in the
  log). The bridge loads YouTube's BotGuard script at runtime, so it normally
  never needs touching.
- **When is an APK rebuild actually required?** Only when the app's own code
  changes — a rare case. Every config-level fix lives in this repository.
- **What if the updater reports a structure change?** The player's JS layout
  has changed (signature scheme rotation, roughly once or twice a year). The
  extractor must be adapted to the new layout — this is a developer task.

---

Maintained by [niksoriginals](https://github.com/niksoriginals).