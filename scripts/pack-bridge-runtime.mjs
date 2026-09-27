#!/usr/bin/env node
// Pack `src-tauri/bridge/node_modules/` (the Claude Agent SDK + zod +
// transitive deps + the host-platform native `claude` binary the SDK shells
// out to — ~600 MB raw, mostly the ~230 MB native binary) into a single
// compressed `bridge-runtime.tar.zst` Tauri resource plus a `manifest.json`
// describing it. See docs/adr/002-bridge-runtime-tarball.md.
//
// Why: shipping the raw tree as `bundle.resources` (v1.1.3) made every
// install ~210 MB heavier and broke `linuxdeploy`'s AppImage packaging (it
// chokes on the 100k+ file / nested-node_modules layout, not on raw size).
// One compressed file fixes both: `cp` is fast, AppImage packs it fine, and
// zstd -19 gets the native binary down to roughly a third its size.
//
// Run via `npm run prepare:bridge` (after `stage-bridge-deps.mjs` has
// populated node_modules) — never by hand in normal dev, since dev builds
// keep reading node_modules directly (see `resolve_bridge_runtime_dir` in
// `src-tauri/src/agent/mod.rs`) and never touch the tarball at all.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  createReadStream,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const BRIDGE_DIR = join(REPO_ROOT, "src-tauri", "bridge");
const BRIDGE_NM = join(BRIDGE_DIR, "node_modules");
const OUT_DIR = join(BRIDGE_DIR, "runtime");
const TARBALL_PATH = join(OUT_DIR, "bridge-runtime.tar.zst");
const MANIFEST_PATH = join(OUT_DIR, "manifest.json");

// Packages `hermes-claude-bridge.mjs` imports directly from node_modules
// (as opposed to the relative `./*.mjs` helpers, which ship as their own
// small resources and never move). Add here if the bridge starts
// importing another npm dep — `tauri-bundle-resources.test.ts` will catch
// a forgotten one via `entries` coverage.
const RUNTIME_PACKAGES = ["@anthropic-ai/claude-agent-sdk", "zod"];

function fail(msg) {
  console.error(`[pack-bridge-runtime] ${msg}`);
  process.exit(1);
}

if (!existsSync(BRIDGE_NM)) {
  fail(`${BRIDGE_NM} is missing — run 'node scripts/stage-bridge-deps.mjs' first`);
}

// ─── Resolve each runtime package's real ESM entry file ──────────────
//
// We need the *exact* file Node's resolver loads for `import "<pkg>"` when
// run from the bridge's own directory (matching hermes-claude-bridge.mjs,
// which lives right there) — not a guess at "index.js" that can silently
// go stale when a package's `exports` map changes shape across versions
// (it did, going from SDK 0.2.x's flat layout to 0.3.x's export map).
//
// `import.meta.resolve` in a `--eval` module resolves as if the module
// lived inside `cwd`, so running it with `cwd: BRIDGE_DIR` gives us the
// bridge's own resolution — byte-for-byte identical to its static import,
// with zero guessing and zero temp files.
function resolveRuntimeEntries() {
  const probe = [
    `const specifiers = ${JSON.stringify(RUNTIME_PACKAGES)};`,
    "const out = {};",
    "for (const spec of specifiers) out[spec] = import.meta.resolve(spec);",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  const raw = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", probe],
    { cwd: BRIDGE_DIR, encoding: "utf-8" },
  );
  const urls = JSON.parse(raw);
  const entries = {};
  for (const [spec, url] of Object.entries(urls)) {
    const abs = fileURLToPath(url);
    const rel = relative(BRIDGE_NM, abs);
    if (rel.startsWith("..")) {
      fail(`resolved '${spec}' to ${abs}, which is outside ${BRIDGE_NM}`);
    }
    // Tar/zstd/manifest paths must be stable across Windows and POSIX.
    entries[spec] = rel.split("\\").join("/");
  }
  return entries;
}

// ─── Manifest: every file's hash, for corruption/partial-write detection ──

async function walkFiles(dir) {
  const out = [];
  async function recurse(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isSymbolicLink()) continue; // hashed via their target already
      if (entry.isDirectory()) await recurse(p);
      else if (entry.isFile()) out.push(p);
    }
  }
  await recurse(dir);
  return out;
}

function sha256File(path) {
  return new Promise((res, rej) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", rej)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => res(hash.digest("hex")));
  });
}

async function buildManifest(sdkVersion, entries) {
  const files = [];
  for (const abs of await walkFiles(BRIDGE_NM)) {
    const rel = relative(BRIDGE_NM, abs).split("\\").join("/");
    files.push({ path: rel, sha256: await sha256File(abs) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    sdkVersion,
    entries,
    files,
    builtAt: new Date().toISOString(),
  };
}

// ─── Tarball: `tar` piped through `zstd -19`, so the manifest's hashes are
// computed straight off the same node_modules tree tar reads from ──

function packTarball() {
  mkdirSync(OUT_DIR, { recursive: true });
  // -T0 lets zstd use all cores; level 19 matches ADR 002's chosen
  // compression/size tradeoff for a runtime that's built once per CI job
  // and extracted many times on end-user machines.
  const cmd = `tar -cf - -C "${BRIDGE_DIR}" node_modules | zstd -19 -T0 -q -f -o "${TARBALL_PATH}"`;
  execFileSync("/bin/sh", ["-c", cmd], { stdio: "inherit" });
}

async function main() {
  const bridgePkg = JSON.parse(
    readFileSync(join(BRIDGE_DIR, "package.json"), "utf-8"),
  );
  const sdkVersion = bridgePkg.dependencies["@anthropic-ai/claude-agent-sdk"];
  if (!sdkVersion) fail("bridge/package.json has no @anthropic-ai/claude-agent-sdk dependency");

  console.log("[pack-bridge-runtime] resolving runtime entry points...");
  const entries = resolveRuntimeEntries();
  for (const [pkg, entry] of Object.entries(entries)) {
    console.log(`  ${pkg} -> ${entry}`);
  }

  console.log("[pack-bridge-runtime] hashing node_modules...");
  const manifest = await buildManifest(sdkVersion, entries);
  console.log(`  ${manifest.files.length} files`);

  console.log("[pack-bridge-runtime] compressing (zstd -19, this can take a minute)...");
  packTarball();

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  const size = statSync(TARBALL_PATH).size;
  console.log(
    `[pack-bridge-runtime] wrote ${TARBALL_PATH} (${(size / 1024 / 1024).toFixed(1)} MB) and ${MANIFEST_PATH}`,
  );
}

main().catch((err) => fail(err.stack ?? String(err)));
