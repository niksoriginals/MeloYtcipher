#!/usr/bin/env node
/*
 * MeloYtcipher config updater
 * ----------------------------------------------------------------------------
 * When YouTube rolls out a new player and playback breaks with 403 / "Source
 * error", this tool extracts the current signature and n-transform functions
 * from the live player and updates player_configs.json. No APK rebuild is
 * needed — the app picks the change up remotely.
 *
 * Usage:
 *   node tools/update_configs.mjs                                # live update
 *   node tools/update_configs.mjs --offline <path-to-base.js>    # analyze a saved player JS
 *   node tools/update_configs.mjs --check                        # coverage report only
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const CONFIG_FILE = path.join(import.meta.dirname, "..", "player_configs.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchText(url, retries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

function extractPlayerHash(iframeApi) {
  const unescaped = iframeApi.replace(/\\\//g, "/");
  const m = unescaped.match(/\/s\/player\/([a-f0-9]{8})\//);
  if (!m) throw new Error("could not resolve player hash from iframe_api");
  return m[1];
}

function browserSandbox() {
  const fakeEl = () => ({
    style: {}, setAttribute() {}, appendChild() {}, removeChild() {},
    addEventListener() {}, removeEventListener() {}, getAttribute: () => null,
    classList: { add() {}, remove() {}, contains: () => false }, dataset: {},
    children: [], parentNode: null, insertBefore() {}, replaceChild() {},
    cloneNode: () => fakeEl(), firstChild: null, textContent: "", innerHTML: "",
  });
  const fakeStorage = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k), clear: () => m.clear(),
      key: (i) => [...m.keys()][i], get length() { return m.size; },
    };
  };
  const sandbox = {
    window: {}, document: {
      createElement: () => fakeEl(), getElementById: () => fakeEl(),
      getElementsByTagName: () => [], querySelector: () => null, querySelectorAll: () => [],
      createTextNode: () => ({}),
    },
    navigator: { userAgent: UA, language: "en-US", platform: "Linux armv81", onLine: true },
    location: { href: "https://www.youtube.com/", hostname: "www.youtube.com", protocol: "https:", pathname: "/", search: "" },
    localStorage: fakeStorage(), sessionStorage: fakeStorage(),
    history: { pushState() {}, replaceState() {} },
    customElements: { define() {}, get() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} },
    EventTarget: class {}, XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    console, performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: { getRandomValues: (a) => a, randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    structuredClone: (o) => JSON.parse(JSON.stringify(o)),
    queueMicrotask: (f) => Promise.resolve().then(f),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

function evalPlayer(playerJs) {
  const closing = "})(_yt_player);";
  const idx = playerJs.lastIndexOf(closing);
  if (idx === -1) throw new Error("player closure tail not found — the player JS layout may have changed");
  const injected =
    "g.__export=function(){return {pB:typeof pB!=='undefined'?pB:null,JQ:typeof JQ!=='undefined'?JQ:null,cY:g.cY||null};};";
  const patched = playerJs.slice(0, idx) + injected + playerJs.slice(idx);
  const sandbox = browserSandbox();
  vm.runInNewContext(patched, sandbox, { timeout: 30000 });
  const ex = sandbox._yt_player && sandbox._yt_player.__export && sandbox._yt_player.__export();
  if (!ex) throw new Error("export injection failed");
  return ex;
}

const SIG_CALL_RE =
  /([A-Za-z0-9$]{2,})\((\d+),(\d+),([A-Za-z0-9$]{2,})\((\d+),(\d+),([A-Za-z0-9$]{1,3})\.s\)/g;
const NCLASS_RES = [
  /\(new\s+g\.([A-Za-z0-9$]{2,})\([^)]*\)\)\s*\.get\("n"\)/,
  /\bvar\s+[A-Za-z0-9$]{2,}\s*=\s*function\([A-Za-z0-9]\)\{try\{var\s+u\s*=\s*new\s+g\.([A-Za-z0-9$]{2,})\(/,
];
const STS_RE = /sts\s*[:=]\s*"?(\d+)/;

function analyze(playerJs) {
  const stsMatch = playerJs.match(STS_RE);
  if (!stsMatch) throw new Error("could not find the sts timestamp in the player JS");
  const sts = Number(stsMatch[1]);

  const ex = evalPlayer(playerJs);
  if (typeof ex.JQ !== "function" && typeof ex.pB !== "function") {
    throw new Error("player JS evaluated, but signature functions were not exposed");
  }

  const testStrings = ["hello+world%21", "a%20b+c", "%E2%82%ACx", "ABC_123.-~"];
  const candidates = [];
  for (const m of playerJs.matchAll(SIG_CALL_RE)) {
    const [, name, c1, c2, innerName, i1, i2, argVar] = m;
    candidates.push({ name, c1: Number(c1), c2: Number(c2), innerName, i1: Number(i1), i2: Number(i2) });
  }
  const unique = [];
  for (const c of candidates) {
    if (!unique.some((u) => u.name === c.name && u.c1 === c.c1 && u.c2 === c.c2)) unique.push(c);
  }
  let sigSpec = null;
  let verifiedInner = null;
  for (const c of unique) {
    const inner = ex[c.innerName];
    if (typeof inner !== "function") continue;
    const matchesDecode = testStrings.every(
      (t) => inner(c.i1, c.i2, t) === decodeURIComponent(t)
    );
    if (matchesDecode && typeof ex[c.name] === "function") {
      sigSpec = `${c.name}(${c.c1},${c.c2},INPUT)`;
      verifiedInner = `${c.innerName}(${c.i1},${c.i2},...) == decodeURIComponent`;
      break;
    }
  }
  if (!sigSpec) throw new Error("could not verify the signature function — the player layout may have changed");

  let nClass = null;
  for (const re of NCLASS_RES) {
    const m = playerJs.match(re);
    if (m) {
      nClass = m[1];
      break;
    }
  }
  if (!nClass) throw new Error("could not locate the n-transform class — the player layout may have changed");

  let nVerified = false;
  if (typeof ex.cY === "function") {
    try {
      const out = new ex.cY("https://x.googlevideo.com/videoplayback?n=abc123xyz", true).get("n");
      nVerified = typeof out === "string" && out !== "abc123xyz";
    } catch { /* ignore */ }
  }
  if (!nVerified) throw new Error("n-transform runtime verification failed — the player layout may have changed");

  return { sts, sigSpec, nClass, verifiedInner };
}

function loadConfigs() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function sortedInsert(players, hash, entry) {
  const entries = Object.entries(players).sort((a, b) => a[1].sts - b[1].sts || a[0].localeCompare(b[0]));
  entries.push([hash, entry]);
  entries.sort((a, b) => a[1].sts - b[1].sts || a[0].localeCompare(b[0]));
  return Object.fromEntries(entries);
}

function updateConfig(hash, analysis) {
  const root = loadConfigs();
  const players = root.players;

  for (const [existingHash, existing] of Object.entries(players)) {
    if (existing.sig === analysis.sigSpec && existing.nClass === analysis.nClass && existing.sts === analysis.sts) {
      const aliases = existing.aliases || [];
      if (!aliases.includes(hash) && existingHash !== hash) {
        existing.aliases = [...aliases, hash];
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(root, null, 2) + "\n");
        console.log(`\nAdded "${hash}" as an alias of entry "${existingHash}".`);
      } else {
        console.log(`\nHash "${hash}" is already covered (alias of "${existingHash}"). No changes.`);
      }
      return;
    }
  }

  const entry = { sig: analysis.sigSpec, nClass: analysis.nClass, sts: analysis.sts, aliases: [] };
  root.players = sortedInsert(players, hash, entry);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(root, null, 2) + "\n");
  console.log(`\nAdded new entry "${hash}": ${JSON.stringify(entry)}`);
}

function covered(hash) {
  const players = loadConfigs().players;
  for (const [h, e] of Object.entries(players)) {
    if (h === hash || (e.aliases || []).includes(hash)) return h;
  }
  return null;
}

const args = process.argv.slice(2);

async function main() {
  const offlineIdx = args.indexOf("--offline");
  let hash, playerJs;

  if (offlineIdx !== -1) {
    const file = args[offlineIdx + 1];
    playerJs = fs.readFileSync(file, "utf8");
    const m = playerJs.match(/player\/([a-f0-9]{8})\//);
    hash = m ? m[1] : "offline-" + Math.random().toString(16).slice(2, 10);
    console.log(`Offline mode: ${file} (hash: ${hash})`);
  } else {
    console.log("Resolving current player hash from iframe_api...");
    const iframeApi = await fetchText("https://www.youtube.com/iframe_api");
    hash = extractPlayerHash(iframeApi);
    console.log(`Current player hash: ${hash}`);
    playerJs = await fetchText(`https://www.youtube.com/s/player/${hash}/player_ias.vflset/en_GB/base.js`);
    console.log(`Downloaded base.js (${(playerJs.length / 1024).toFixed(0)} KB)`);
  }

  if (args.includes("--check")) {
    const owner = covered(hash);
    console.log(
      owner
        ? `Status: hash "${hash}" is already covered (entry "${owner}").`
        : `Status: hash "${hash}" is NOT covered — a new entry is required. Run the script without --check.`
    );
    return;
  }

  console.log("Extracting and verifying sig/n functions (Node sandbox)...");
  const analysis = analyze(playerJs);
  console.log(`sts=${analysis.sts}, sig=${analysis.sigSpec}, nClass=${analysis.nClass}`);
  console.log(`verified: ${analysis.verifiedInner}`);

  const existing = covered(hash);
  if (existing && !offlineIdx) {
    console.log(`Hash "${hash}" is already covered (entry "${existing}"). Done.`);
    return;
  }

  updateConfig(hash, analysis);
  console.log("\nPush the change:");
  console.log("  git add player_configs.json");
  console.log("  git commit -m 'Add player config for " + hash + "'");
  console.log("  git push");
  console.log("Alternatively, edit player_configs.json directly on GitHub and commit.");
  console.log("The app picks the change up within 6h, or immediately on the next 403. No APK rebuild required.");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  console.error("The player structure may have changed — collect this log and a base.js sample and open an issue.");
  process.exit(1);
});