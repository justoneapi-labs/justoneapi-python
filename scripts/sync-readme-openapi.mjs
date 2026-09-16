/**
 * Synchronize README lists from a single OpenAPI/translation snapshot.
 * Every candidate is generated in a disposable worktree based on the latest
 * origin/main. The caller's checkout and index are never reset or staged.
 *
 * node scripts/sync-readme-openapi.mjs          # preview; no commit or push
 * node scripts/sync-readme-openapi.mjs --publish
 * README_SYNC_TARGETS=README.en.md:en,README.md:zh selects multiple READMEs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const GENERATOR = "scripts/update-readme-api-list.mjs";
const CACHE_FILE = "i18n-cache.json";
const MAX_ATTEMPTS = 3;

function run(command, args, cwd, env = {}, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args[0]} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result;
}

function git(cwd, ...args) {
  return run("git", args, cwd).stdout.trim();
}

function readCache(root) {
  const file = path.join(root, CACHE_FILE);
  if (!fs.existsSync(file)) return {};
  const cache = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    throw new Error(`${CACHE_FILE} must contain an object.`);
  }
  return cache;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function targets() {
  const entries = process.env.README_SYNC_TARGETS || `${process.env.README_FILE || "README.md"}:${process.env.README_LANG || "en"}`;
  const result = entries.split(",").map((entry) => {
    const [file, language, extra] = entry.trim().split(":");
    if (extra || !/^README(?:\.[A-Za-z-]+)?\.md$/.test(file) || !["zh", "en"].includes(language)) {
      throw new Error(`Invalid README_SYNC_TARGETS entry: ${entry}`);
    }
    return { file, language };
  });
  if (new Set(result.map(({ file }) => file)).size !== result.length) {
    throw new Error("README_SYNC_TARGETS contains duplicate files.");
  }
  return result;
}

async function cacheOpenApi(root, destination) {
  let api;
  if (process.env.OPENAPI_FILE) {
    api = JSON.parse(fs.readFileSync(path.resolve(root, process.env.OPENAPI_FILE), "utf8"));
  } else {
    const username = process.env.OPENAPI_BASIC_AUTH_USER?.trim() || process.env.OPENAPI_BASIC_AUTH_USERNAME?.trim();
    const password = process.env.OPENAPI_BASIC_AUTH_PASS?.trim() || process.env.OPENAPI_BASIC_AUTH_PASSWORD?.trim();
    if (!username || !password) throw new Error("OpenAPI basic authentication credentials are required.");
    const url = process.env.OPENAPI_URL?.trim() || "https://api.justoneapi.com/v3/api-docs/public-api";
    const timeout = Number(process.env.OPENAPI_FETCH_TIMEOUT_MS || "30000");
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid OPENAPI_FETCH_TIMEOUT_MS.");
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`OpenAPI fetch failed: HTTP ${response.status}`);
    api = await response.json();
  }
  if (!api || typeof api.paths !== "object" || !api.paths || Array.isArray(api.paths)) {
    throw new Error("OpenAPI must contain a paths object.");
  }
  writeJson(destination, api);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--publish")) throw new Error("Usage: node scripts/sync-readme-openapi.mjs [--publish]");
  const publish = args.includes("--publish");
  const root = git(process.cwd(), "rev-parse", "--show-toplevel");
  const readmes = targets();
  const hasChinese = readmes.some(({ language }) => language === "zh");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "readme-openapi-sync-"));
  const candidate = path.join(scratch, "candidate");
  const spec = path.join(scratch, "openapi.json");
  const cache = path.join(scratch, "i18n-cache.json");
  let worktreeCreated = false;

  function removeCandidate() {
    if (worktreeCreated) {
      git(root, "worktree", "remove", "--force", candidate);
      worktreeCreated = false;
    }
  }

  function latestCandidate() {
    removeCandidate();
    git(root, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
    const base = git(root, "rev-parse", "refs/remotes/origin/main");
    git(root, "worktree", "add", "--detach", candidate, base);
    worktreeCreated = true;
    return base;
  }

  function generate(offline) {
    for (const { file, language } of readmes) {
      const result = run(process.execPath, [GENERATOR], candidate, {
        README_FILE: file,
        README_LANG: language,
        OPENAPI_FILE: spec,
        I18N_CACHE_FILE: cache,
        GLOSSARY_FILE: path.join(candidate, "glossary.json"),
        TRANSLATION_NETWORK: offline ? "off" : (process.env.TRANSLATION_NETWORK || "on"),
      });
      process.stdout.write(result.stdout);
    }
  }

  try {
    await cacheOpenApi(root, spec);
    // Warm translations once; this candidate may age during network calls.
    latestCandidate();
    const initialCache = readCache(candidate);
    writeJson(cache, initialCache);
    generate(false);
    const warmedCache = JSON.parse(fs.readFileSync(cache, "utf8"));
    const newTranslations = Object.fromEntries(Object.entries(warmedCache).filter(([key]) => !Object.hasOwn(initialCache, key)));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const base = latestCandidate();
      const latestCache = readCache(candidate);
      const mergedCache = { ...latestCache };
      for (const [key, value] of Object.entries(newTranslations)) {
        if (!Object.hasOwn(mergedCache, key)) mergedCache[key] = value;
      }
      writeJson(cache, mergedCache);
      // The generator reads this candidate's current manifest on every retry.
      generate(true);
      if (hasChinese && JSON.stringify(mergedCache) !== JSON.stringify(latestCache)) {
        writeJson(path.join(candidate, CACHE_FILE), mergedCache);
      }
      const files = readmes.map(({ file }) => file);
      if (hasChinese && fs.existsSync(path.join(candidate, CACHE_FILE))) files.push(CACHE_FILE);
      git(candidate, "add", "--", ...files);
      const changed = run("git", ["diff", "--cached", "--quiet"], candidate, {}, true);
      if (changed.status === 0) {
        console.log("README API lists are already up to date.");
        return;
      }
      if (changed.status !== 1) throw new Error(`Could not inspect staged README changes: ${changed.stderr}`);
      if (!publish) {
        console.log(git(candidate, "diff", "--cached", "--stat"));
        console.log("Preview complete; no commit or push was performed.");
        return;
      }
      git(candidate, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-m", "chore: sync README API list");
      const pushed = run("git", ["push", "--porcelain", "origin", "HEAD:refs/heads/main"], candidate, {}, true);
      if (pushed.status === 0) {
        console.log(`Published README API lists on attempt ${attempt}.`);
        return;
      }
      const output = `${pushed.stdout}\n${pushed.stderr}`;
      if (!/\[rejected\].*\((?:fetch first|non-fast-forward)\)/.test(output)) {
        throw new Error(`README push failed; not a non-fast-forward rejection:\n${output}`);
      }
      if (attempt === MAX_ATTEMPTS) throw new Error(`README push failed after ${MAX_ATTEMPTS} attempts; origin/main kept advancing.`);
      console.log(`origin/main advanced from ${base}; rebuilding README lists (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`);
    }
  } finally {
    removeCandidate();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
