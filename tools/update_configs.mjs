#!/usr/bin/env node
/*
 * MeloYtcipher config updater
 * ---------------------------------
 * Jab YouTube naya player JS roll out karta hai aur playback 403/"Source error"
 * deta hai, ye script current player se sig/n function extract karke
 * player_configs.json update karta hai. APK rebuild ki zaroorat nahi.
 *
 * Usage:
 *   node tools/update_configs.mjs              # live: YouTube se fetch karke update
 *   node tools/update_configs.mjs --offline <path-to-base.js>   # locally saved player JS
 *   node tools/update_configs.mjs --check      # sirf report: current config OK hai ya nahi
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
  if (!m) throw new Error("player hash iframe_api mein nahi mila");
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
  if (idx === -1) throw new Error("player closure tail nahi mila (player JS format badla hua hai)");
  const injected =
    "g.__export=function(){return {pB:typeof pB!=='undefined'?pB:null,JQ:typeof JQ!=='undefined'?JQ:null,cY:g.cY||null};};";
  const patched = playerJs.slice(0, idx) + injected + playerJs.slice(idx);
  const sandbox = browserSandbox();
  vm.runInNewContext(patched, sandbox, { timeout: 30000 });
  const ex = sandbox._yt_player && sandbox._yt_player.__export && sandbox._yt_player.__export();
  if (!ex) throw new Error("export injection fail hui");
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
  if (!stsMatch) throw new Error("sts timestamp player JS mein nahi mila");
  const sts = Number(stsMatch[1]);

  const ex = evalPlayer(playerJs);
  if (typeof ex.JQ !== "function" && typeof ex.pB !== "function") {
    throw new Error("player JS evaluate hua par sig functions expose nahi hue (structure badla)");
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
  if (!sigSpec) throw new Error("sig function verify nahi hui (structure badla)");

  let nClass = null;
  for (const re of NCLASS_RES) {
    const m = playerJs.match(re);
    if (m) {
      nClass = m[1];
      break;
    }
  }
  if (!nClass) throw new Error("n-class name nahi mila (structure badla)");

  let nVerified = false;
  if (typeof ex.cY === "function") {
    try {
      const out = new ex.cY("https://x.googlevideo.com/videoplayback?n=abc123xyz", true).get("n");
      nVerified = typeof out === "string" && out !== "abc123xyz";
    } catch { /* ignore */ }
  }
  if (!nVerified) throw new Error("n-transform runtime verify nahi hui (structure badla)");

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
        console.log(`\nEntry "${existingHash}" mein hash "${hash}" alias ke taur pe ADD ho gaya.`);
      } else {
        console.log(`\nHash "${hash}" already covered hai (entry "${existingHash}", alias ke taur pe). Kuch change nahi.`);
      }
      return;
    }
  }

  const entry = { sig: analysis.sigSpec, nClass: analysis.nClass, sts: analysis.sts, aliases: [] };
  root.players = sortedInsert(players, hash, entry);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(root, null, 2) + "\n");
  console.log(`\nNaya entry add hua: "${hash}" -> ${JSON.stringify(entry)}`);
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
    console.log(`Offline mode: ${file} (hash guess: ${hash})`);
  } else {
    console.log("iframe_api se current player hash le raha hoon...");
    const iframeApi = await fetchText("https://www.youtube.com/iframe_api");
    hash = extractPlayerHash(iframeApi);
    console.log(`Current player hash: ${hash}`);
    playerJs = await fetchText(`https://www.youtube.com/s/player/${hash}/player_ias.vflset/en_GB/base.js`);
    console.log(`base.js download hua (${(playerJs.length / 1024).toFixed(0)} KB)`);
  }

  if (args.includes("--check")) {
    const owner = covered(hash);
    console.log(
      owner
        ? `Status: hash "${hash}" config mein covered hai (entry "${owner}"). Playback issues iski wajah se nahi hain.`
        : `Status: hash "${hash}" config mein NAHI hai! Apne signatures ke liye naya entry chahiye. Script bina --check ke chalao.`
    );
    return;
  }

  console.log("Sig/n functions extract + verify ho rahe hain (Node sandbox)...");
  const analysis = analyze(playerJs);
  console.log(`sts=${analysis.sts}, sig=${analysis.sigSpec}, nClass=${analysis.nClass}`);
  console.log(`inner verify: ${analysis.verifiedInner}`);

  const existing = covered(hash);
  if (existing && !offlineIdx) {
    console.log(`Hash "${hash}" pehle se covered hai (entry "${existing}"). Done.`);
    return;
  }

  updateConfig(hash, analysis);
  console.log("\nAbh bas ye push kar do:");
  console.log("  git add player_configs.json");
  console.log("  git commit -m 'Add player config for " + hash + "'");
  console.log("  git push");
  console.log("Ya GitHub UI se player_configs.json edit karke Commit kar do.");
  console.log("App 6h ke andar ya agle 403 pe turant config refresh karega — APK rebuild NAHI karni.");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  console.error("Structure change ho sakta hai — log + base.js sample ke saath help lo.");
  process.exit(1);
});