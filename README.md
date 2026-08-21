# MeloYtcipher

Remote configuration registry for the **Melo** music player. This repository
holds the runtime-adjustable playback configuration so that YouTube player
rotations are fixed **automatically without shipping a new APK**.

```
MeloYtcipher/
├── .github/workflows/
│   └── player-monitor.yml     # Automated 30-minute live YouTube player scanner & auto-committer
├── player_configs.json        # player hash -> sig/n function specifications
├── po_token.html              # BotGuard bridge payload (rarely changes)
├── tools/
│   ├── auto-update-monitor.mjs # 30-sample multi-surface scanner & updater
│   └── update_configs.mjs     # manual config extractor + verifier
└── README.md
```

## ⚡ Automated 24/7 Monitoring & Self-Healing

This repository has a built-in **GitHub Action (`player-monitor.yml`)** that runs **every 30 minutes**:
1. Multi-samples live YouTube player surfaces (`iframe_api`, `music.youtube.com`, `watch`, `embed`) across multiple requests.
2. Catches **A/B canary players** in their first hour before they become dominant.
3. Automatically extracts `sigSpec`, `nClass`, `sts`, and MD5 aliases from YouTube's `base.js`.
4. Updates `player_configs.json` and pushes the commit directly to `main`.
5. **Melo apps self-heal automatically** without needing any manual intervention or APK rebuilds!

## How the app consumes this repo

The app bundles a copy of every file as an offline fallback and overlays it
with the remote copy at runtime. A failed remote fetch is silently ignored —
playback never depends on network availability for config.

| File | Remote URL | Refresh policy |
|------|------------|----------------|
| `player_configs.json` | `raw.githubusercontent.com/niksoriginals/MeloYtcipher/main/player_configs.json` | every 6h; forced immediately on a signature rejection |
| `po_token.html` | `raw.githubusercontent.com/niksoriginals/MeloYtcipher/main/po_token.html` | every 24h |

## Manual Update (CLI)

If you ever want to run the scanner manually:

**Requirements:** Node.js 18+

```bash
# 1. Clone
git clone https://github.com/niksoriginals/MeloYtcipher.git
cd MeloYtcipher

# 2. Run multi-surface scanner & updater
node tools/auto-update-monitor.mjs

# 3. Or check specific player hash
node tools/update_configs.mjs --check
```

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

## Maintained by
[niksoriginals](https://github.com/niksoriginals)