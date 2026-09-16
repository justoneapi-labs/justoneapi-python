import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadExampleManifest, renderExampleAnnotation, updateExampleLinksOnly } from "./readme-example-links.mjs";

const repository = "justoneapi/test-repo";
const key = "GET /api/demo/detail/v1";
const entry = { operationId: "getDemoDetailV1", file: "docs/api-examples/getDemoDetailV1.json" };
const docsUrl = "https://docs.justoneapi.com/zh/api/demo/detail-v1?utm_source=github.com&utm_medium=referral&utm_campaign=keep_this&utm_content=repo_readme_api_list";
const row = `- [详情 (V1)](${docsUrl}) <!-- api-operation:${key} -->`;
const original = `before\n<!-- API_LIST_START -->\n\n${row}\n\n<!-- API_LIST_END -->\nafter\n`;
const script = fileURLToPath(new URL("./update-readme-api-list.mjs", import.meta.url));
const actualRepository = fs.readFileSync(script, "utf8").match(/const REPOSITORY = "([^"]+)";/)[1];

function fixture(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "readme-example-links-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, "docs/api-examples"), { recursive: true });
  return repoRoot;
}

function writeManifest(repoRoot, examples = { [key]: entry }) {
  fs.writeFileSync(path.join(repoRoot, "docs/api-examples/manifest.json"), JSON.stringify({ schemaVersion: 1, examples }));
}

test("missing manifest leaves stable keys and existing documentation unchanged", (t) => {
  const repoRoot = fixture(t);
  assert.equal(updateExampleLinksOnly(original, { repoRoot, repository }), original);
});

test("adding and removing examples is idempotent and preserves documentation UTM and surrounding content", (t) => {
  const repoRoot = fixture(t);
  writeManifest(repoRoot);
  fs.writeFileSync(path.join(repoRoot, entry.file), "{}\n");
  const updated = updateExampleLinksOnly(original, { repoRoot, repository });
  assert.equal(updated, original.replace(row, `${row} <sub>[JSON](https://github.com/${repository}/blob/main/${entry.file})</sub>`));
  assert.equal(updateExampleLinksOnly(updated, { repoRoot, repository }), updated);
  writeManifest(repoRoot, {});
  assert.equal(updateExampleLinksOnly(updated, { repoRoot, repository }), original);
});

test("a missing response file removes its link without changing the endpoint row", (t) => {
  const repoRoot = fixture(t);
  writeManifest(repoRoot);
  const old = original.replace(row, `${row} <sub>[JSON](https://github.com/${repository}/blob/main/${entry.file})</sub>`);
  assert.equal(updateExampleLinksOnly(old, { repoRoot, repository }), original);
  fs.mkdirSync(path.join(repoRoot, entry.file));
  assert.equal(Object.keys(loadExampleManifest(repoRoot)).length, 0);
});

test("malformed manifest and unsafe paths fail instead of silently clearing links", (t) => {
  const repoRoot = fixture(t);
  const manifestPath = path.join(repoRoot, "docs/api-examples/manifest.json");
  for (const value of ["{broken", "null", "[]", JSON.stringify({ schemaVersion: 2, examples: {} }), JSON.stringify({ schemaVersion: 1, examples: [] })]) {
    fs.writeFileSync(manifestPath, value);
    assert.throws(() => updateExampleLinksOnly(original, { repoRoot, repository }), /Invalid/);
  }
  for (const badEntry of [{ ...entry, operationId: "../escape" }, { ...entry, file: "../secret.json" }, { ...entry, file: "docs/api-examples/other.json" }]) {
    writeManifest(repoRoot, { [key]: badEntry });
    assert.throws(() => loadExampleManifest(repoRoot), /Invalid/);
  }
  writeManifest(repoRoot, { "GET /bad -->": entry });
  assert.throws(() => loadExampleManifest(repoRoot), /Invalid/);
});

test("managed links distinguish the HTTP method and update only the marked API block", (t) => {
  const repoRoot = fixture(t);
  writeManifest(repoRoot, { "POST /api/demo/detail/v1": entry });
  fs.writeFileSync(path.join(repoRoot, entry.file), "{}\n");
  assert.equal(updateExampleLinksOnly(original, { repoRoot, repository }), original);
  const outside = `${row}\n${original}`;
  writeManifest(repoRoot);
  const result = updateExampleLinksOnly(outside, { repoRoot, repository });
  assert.ok(result.startsWith(`${row}\nbefore\n`));
  assert.equal((result.match(/<sub>/g) || []).length, 1);
});

test("reserved manifest IDs and duplicate response files fail consistently with the publisher", (t) => {
  const repoRoot = fixture(t);
  writeManifest(repoRoot, { [key]: { operationId: "manifest", file: "docs/api-examples/manifest.json" } });
  assert.throws(() => loadExampleManifest(repoRoot), /Invalid example operationId/);
  writeManifest(repoRoot, { [key]: entry, "POST /api/demo/detail/v1": entry });
  assert.throws(() => loadExampleManifest(repoRoot), /Invalid example file/);
});

test("uninitialized or partially unmarked endpoint rows require full generation", (t) => {
  const repoRoot = fixture(t);
  const unmarked = `- [详情 (V1)](${docsUrl})`;
  assert.throws(() => updateExampleLinksOnly(original.replace(row, unmarked), { repoRoot, repository }), /run the full README generator/);
  assert.throws(() => updateExampleLinksOnly(original.replace(row, `${row}\n${unmarked}`), { repoRoot, repository }), /run the full README generator/);
});

test("missing blocks and malformed managed rows fail visibly", (t) => {
  const repoRoot = fixture(t);
  assert.throws(() => updateExampleLinksOnly("unmarked README", { repoRoot, repository }), /API list/);
  assert.throws(() => updateExampleLinksOnly(original.replace(row, `${row} unexpected text`), { repoRoot, repository }), /Malformed/);
});

test("full renderer retains stable keys even before an example exists", () => {
  assert.equal(renderExampleAnnotation(key, {}, repository), ` <!-- api-operation:${key} -->`);
});

test("CLI links-only mode succeeds offline without OpenAPI, credentials, or translation cache", (t) => {
  const repoRoot = fixture(t);
  writeManifest(repoRoot);
  fs.writeFileSync(path.join(repoRoot, entry.file), "{}\n");
  fs.writeFileSync(path.join(repoRoot, "README.md"), original);
  const result = spawnSync(process.execPath, [script, "--examples-links-only"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH, OPENAPI_URL: "http://127.0.0.1:1/unreachable", DEEPSEEK_BASE_URL: "http://127.0.0.1:1/unreachable" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.readFileSync(path.join(repoRoot, "README.md"), "utf8").includes(`<sub>[JSON](https://github.com/${actualRepository}/blob/main/${entry.file})</sub>`));
  assert.deepEqual(fs.readdirSync(repoRoot).sort(), ["README.md", "docs"]);
});

test("full generation reads the local manifest and emits the repository's exact GitHub URL", (t) => {
  const repoRoot = fixture(t);
  writeManifest(repoRoot);
  fs.writeFileSync(path.join(repoRoot, entry.file), "{}\n");
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Project\n\n## Service Overview\n\n<!-- API_LIST_START -->\n<!-- API_LIST_END -->\n");
  const specPath = path.join(repoRoot, "openapi.json");
  fs.writeFileSync(specPath, JSON.stringify({ paths: { "/api/demo/detail/v1": { get: { operationId: entry.operationId, summary: "Detail", tags: ["Demo"] } } } }));
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH, OPENAPI_FILE: specPath, README_LANG: "en", TRANSLATION_NETWORK: "off" },
  });
  assert.equal(result.status, 0, result.stderr);
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.ok(readme.includes(`<!-- api-operation:${key} -->`));
  assert.ok(readme.includes(`https://github.com/${actualRepository}/blob/main/${entry.file}`));
});

test("offline full generation fails clearly when Chinese translations are missing", (t) => {
  const repoRoot = fixture(t);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "## 服务概览\n\n<!-- API_LIST_START -->\n<!-- API_LIST_END -->\n");
  const specPath = path.join(repoRoot, "openapi.json");
  fs.writeFileSync(specPath, JSON.stringify({ paths: { "/api/demo/detail/v1": { get: { summary: "Uncached Detail", tags: ["Uncached Category"] } } } }));
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH, OPENAPI_FILE: specPath, README_LANG: "zh", TRANSLATION_NETWORK: "off", DEEPSEEK_API_KEY: "test-only", DEEPSEEK_BASE_URL: "http://127.0.0.1:1/unreachable" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TRANSLATION_NETWORK=off prohibits translation requests/);
  assert.equal(fs.existsSync(path.join(repoRoot, "i18n-cache.json")), false);
});
