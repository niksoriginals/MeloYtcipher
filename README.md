# MeloYtcipher — Remote Config Registry

Melo music app ke playback ke liye **remote config registry**. Ye files YouTube ke
player rotations ke baad bina APK rebuild ke app update karne ke liye hain.

- `player_configs.json` — player hash → sig/n function specs (sabse important)
- `po_token.html` — BotGuard bridge (bahut rarely change hota hai, `tools/` wala
  updater isse touch NAHI karta)

## App isse kaise use karta hai

| File | URL (raw.githubusercontent) | Refresh |
|------|----------------------------|---------|
| player_configs.json | `.../MeloYtcipher/main/player_configs.json` | 6h TTL; 403/rejection pe force |
| po_token.html | `.../MeloYtcipher/main/po_token.html` | 24h TTL |

App pehle **bundled asset** (APK ke andar wali copy) use karta hai — remote fetch
hamesha override karta hai. Network na ho tab bhi app chalta hai. Remote fail ho
jayega to bhi silent fallback hai.

## Kab update karna hai

Playback mein `Source error` / `403` aaye aur logcat mein ye dikhe:

```
echomusic_CipherFnExtract: No config for hash: <hash>
echomusic_CipherConfig: Remote config fetch HTTP 404
```

Ya `--check` mode report kare ki hash covered nahi hai.

## Update kaise karna hai (2 min)

**Zaroorat:** Node.js 18+ (PC pe)

```bash
# 1. Repo clone (ek baar)
git clone https://github.com/niksoriginals/MeloYtcipher.git
cd MeloYtcipher

# 2. Check: kya current player config mein hai?
node tools/update_configs.mjs --check

# 3. Update karo (agar --check ne "NAHI hai" bola)
node tools/update_configs.mjs

# 4. Push
git add player_configs.json
git commit -m "Add player config for <hash>"
git push
```

Done — app agle refresh (6h) ya agle 403 pe turant naya config utha lega.

**Koi PC nahi?** GitHub website pe `player_configs.json` kholo → pencil icon →
Edit → Commit. (Magar entry likhne ke liye sig/n values kisi PC se extract karni
padegi — helper hi kar sakta hai.)

## Helper kya karta hai (`tools/update_configs.mjs`)

1. YouTube se current player hash laata hai (`/iframe_api`)
2. Us player ka `base.js` download karta hai
3. Node sandbox mein player JS ko chala kar **sig function verify** karta hai
   (inner function `decodeURIComponent` jaisa hi behave karta hai — test strings pe)
4. `n` class extract karta hai aur runtime mein verify karta hai
5. `sts` timestamp nikalta hai
6. Same sig/nClass/sts wali entry pehle se ho → sirf **alias** add karta hai;
   warna **naya entry** banata hai (file sts ke order mein sorted rehti hai)

`--offline <path>` flag se locally saved `base.js` pe bhi chala sakte ho.

## Schema (`player_configs.json`)

```json
{
  "schemaVersion": 1,
  "players": {
    "66dd9fcc": {
      "sig": "pB(20,268,INPUT)",     // func(const,const,INPUT); INPUT = decodeURIComponent(sig)
      "nClass": "cY",                 // g.<name>(url,true).get("n")
      "sts": 20681,                   // signature timestamp
      "aliases": ["3891b194"]         // isi spec wale dusre player hashes
    }
  }
}
```

## FAQ

- **po_token.html kab update karna hai?** Jab BotGuard change ho aur `poToken`
  minting fail ho (logcat: `PoTokenWebView` / `PoTokenAssetStore` errors). Ye
  bridge file YouTube ka BotGuard runtime pe hi load karta hai, isliye most of
  the time touch nahi karna padta.
- **APK rebuild kab karni hai?** Sirf jab app ka **code** badle (rare). Har
  config-level fix is repo se hota hai.
- **Signature scheme ekdum badal jaye (saal mein 1-2 baar)?** Helper "FAILED:
  structure badla" dega. Tab player JS ka structure analyze karke helper ko
  update karna hoga (ye kaam developer/assistant se karwana).
