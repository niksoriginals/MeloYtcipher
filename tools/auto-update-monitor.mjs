#!/usr/bin/env node
/*
 * MeloYtcipher Automated Player Monitor & Updater
 * ----------------------------------------------------------------------------
 * 1. Multi-samples live YouTube player surfaces (iframe_api, music, watch, embed)
 * 2. Identifies unknown player hashes not in player_configs.json
 * 3. Downloads base.js and extracts sigSpec, nClass, sts, and md5 alias
 * 4. Automatically updates player_configs.json
 * 5. Returns count of new entries added (for GitHub Actions commit/push)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";

const CONFIG_FILE = path.join(import.meta.dirname, "..", "player_configs.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const IFRAME_RE = /\\?\/s\\?\/player\\?\/([a-f0-9]{8})\\?\//;
const PLAIN_RE = /\/s\/player\/([a-f0-9]{8})\//;

async function fetchText(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

const hashFrom = (body, re) => (body.match(re) || [])[1] || null;

async function sampleSurfaces(samplesCount = 20) {
  const probeVid = "dQw4w9WgXcQ";
  const hashes = [];

  // 1. iframe_api (primary)
  for (let i = 0; i < samplesCount; i++) {
    try {
      const txt = await fetchText("https://www.youtube.com/iframe_api");
      hashes.push(hashFrom(txt, IFRAME_RE));
    } catch {}
  }

  // 2. music.youtube.com
  try {
    const txt = await fetchText("https://music.youtube.com/");
    hashes.push(hashFrom(txt, PLAIN_RE));
  } catch {}

  // 3. youtube.com/watch
  try {
    const txt = await fetchText(`https://www.youtube.com/watch?v=${probeVid}`);
    hashes.push(hashFrom(txt, PLAIN_RE));
  } catch {}

  // 4. youtube.com/embed
  try {
    const txt = await fetchText(`https://www.youtube.com/embed/${probeVid}`);
    hashes.push(hashFrom(txt, PLAIN_RE));
  } catch {}

  return [...new Set(hashes.filter(Boolean))];
}

function loadConfigs() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function saveConfigs(data) {
  const lines = ['{\n  "schemaVersion": 1,\n  "players": {'];
  const items = Object.entries(data.players);
  items.sort((a, b) => (a[1].sts || 0) - (b[1].sts || 0) || a[0].localeCompare(b[0]));

  for (let i = 0; i < items.length; i++) {
    const [k, v] = items[i];
    const aliasesStr = JSON.stringify(v.aliases || []);
    let entry = `    "${k}": { "sig": "${v.sig}", "nClass": "${v.nClass}", "sts": ${v.sts}, "aliases": ${aliasesStr} }`;
    if (i < items.length - 1) entry += ",";
    lines.append ? lines.append(entry) : lines.push(entry);
  }
  lines.push("  }\n}");
  fs.writeFileSync(CONFIG_FILE, lines.join("\n") + "\n", "utf8");
}

function coveredKeys(configs) {
  const keys = new Set();
  for (const [primary, entry] of Object.entries(configs.players || {})) {
    keys.add(primary);
    for (const alias of entry.aliases || []) keys.add(alias);
  }
  return keys;
}

function extractDetailsFromJs(js) {
  const stsMatch = js.match(/signatureTimestamp[':\s"]+(\d{4,6})/);
  const sts = stsMatch ? Number(stsMatch[1]) : null;
  const md5 = crypto.createHash("md5").update(Buffer.from(js.slice(0, 10000), "utf8")).digest("hex").slice(0, 8);

  // Extract candidate sig functions
  // Pattern: SIGFUNC(c1, c2, INNERFUNC(i1, i2, var.s)) or similar
  const sigMatches = [];
  const alrIdx = js.indexOf('.set("alr","yes")');
  if (alrIdx >= 0) {
    const window = js.slice(alrIdx, alrIdx + 250);
    const sm = window.match(/=\s*([A-Za-z0-9$_]{2,5})\((\d+),(\d+),\s*([A-Za-z0-9$_]{2,5})\((\d+),(\d+),/);
    if (sm) {
      sigMatches.push(`${sm[1]}(${sm[2]},${sm[3]},INPUT)`);
    }
  }

  // Fallback sig patterns
  if (sigMatches.length === 0) {
    for (const m of js.matchAll(/([A-Za-z0-9$]{2,})\((\d+),(\d+),([A-Za-z0-9$]{2,})\((\d+),(\d+),([A-Za-z0-9$]{1,3})\.s\)/g)) {
      sigMatches.push(`${m[1]}(${m[2]},${m[3]},INPUT)`);
    }
  }

  // Extract candidate nClass
  const nClasses = [];
  for (const m of js.matchAll(/new\s+g\.([A-Za-z0-9$_]{2,5})\([^)]*\)\)?\s*\.\s*get\("n"\)/g)) {
    nClasses.push(m[1]);
  }
  for (const m of js.matchAll(/\bvar\s+[A-Za-z0-9$]{2,}\s*=\s*function\([A-Za-z0-9]\)\{try\{var\s+u\s*=\s*new\s+g\.([A-Za-z0-9$]{2,})\(/g)) {
    nClasses.push(m[1]);
  }

  const sigSpec = sigMatches[0] || null;
  const nClass = nClasses[0] || null;

  return { sts, md5, sigSpec, nClass };
}

async function main() {
  console.log("=== MeloYtcipher Live Player Monitor ===");
  const configData = loadConfigs();
  const covered = coveredKeys(configData);
  console.log(`Current covered hashes: ${covered.size}`);

  console.log("Sampling live YouTube surfaces (30 samples)...");
  const liveHashes = await sampleSurfaces(30);
  console.log(`Discovered live hashes: ${liveHashes.join(", ")}`);

  const unknown = liveHashes.filter((h) => !covered.has(h));
  if (unknown.length === 0) {
    console.log("All discovered live players are already covered! No changes needed.");
    return;
  }

  console.log(`Found ${unknown.length} unknown player(s): ${unknown.join(", ")}`);
  let changesMade = 0;

  for (const hash of unknown) {
    console.log(`\nAnalyzing player: ${hash}...`);
    try {
      const jsUrl = `https://www.youtube.com/s/player/${hash}/player_ias.vflset/en_GB/base.js`;
      const js = await fetchText(jsUrl);
      const { sts, md5, sigSpec, nClass } = extractDetailsFromJs(js);

      console.log(`Extracted: sts=${sts}, md5=${md5}, sig=${sigSpec}, nClass=${nClass}`);

      if (!sts || !sigSpec || !nClass) {
        console.warn(`Could not extract full signature/n details for ${hash}. Skipping.`);
        continue;
      }

      // Check if MD5 alias exists
      if (covered.has(md5)) {
        // Find owner and add alias
        for (const [primary, entry] of Object.entries(configData.players)) {
          if (primary === md5 || (entry.aliases || []).includes(md5)) {
            if (!entry.aliases) entry.aliases = [];
            if (!entry.aliases.includes(hash)) {
              entry.aliases.push(hash);
              console.log(`Added "${hash}" as alias to existing entry "${primary}".`);
              changesMade++;
            }
            break;
          }
        }
      } else {
        // Check if matching sigSpec/nClass/sts exists
        let matched = false;
        for (const [primary, entry] of Object.entries(configData.players)) {
          if (entry.sig === sigSpec && entry.nClass === nClass && entry.sts === sts) {
            if (!entry.aliases) entry.aliases = [];
            if (!entry.aliases.includes(hash)) entry.aliases.push(hash);
            if (md5 && !entry.aliases.includes(md5)) entry.aliases.push(md5);
            console.log(`Merged "${hash}" (md5: ${md5}) as alias into "${primary}".`);
            matched = true;
            changesMade++;
            break;
          }
        }

        if (!matched) {
          const newEntry = {
            sig: sigSpec,
            nClass: nClass,
            sts: sts,
            aliases: md5 && md5 !== hash ? [md5] : []
          };
          configData.players[hash] = newEntry;
          console.log(`Added brand new entry "${hash}":`, JSON.stringify(newEntry));
          changesMade++;
        }
      }
    } catch (e) {
      console.error(`Failed to analyze player ${hash}:`, e.message);
    }
  }

  if (changesMade > 0) {
    saveConfigs(configData);
    console.log(`\nSuccessfully updated player_configs.json with ${changesMade} changes.`);
    // Set output for GitHub actions
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `updated=true\ncount=${changesMade}\n`);
    }
  } else {
    console.log("\nNo changes written.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
