import fs from "node:fs";
import path from "node:path";

const START = "<!-- API_LIST_START -->";
const END = "<!-- API_LIST_END -->";
const OPERATION_KEY = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE) \/[^\s<>]*$/;
const OPERATION_ID = /^[A-Za-z0-9_-]+$/;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function validateKey(key) {
  if (!OPERATION_KEY.test(key)) throw new Error(`Invalid example operation key: ${key}`);
}

// Return only validated entries whose JSON file exists in this checkout.
// A missing manifest permits bootstrapping; a malformed manifest must never silently remove links.
export function loadExampleManifest(repoRoot) {
  const manifestPath = path.join(repoRoot, "docs/api-examples/manifest.json");
  let source;
  try {
    source = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return Object.create(null);
    throw error;
  }

  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error(`Invalid JSON example manifest: ${manifestPath}`);
  }
  if (!isObject(manifest) || manifest.schemaVersion !== 1 || !isObject(manifest.examples)) {
    throw new Error(`Invalid example manifest schema: ${manifestPath}`);
  }

  const available = Object.create(null);
  const seenFiles = new Set();
  for (const [key, entry] of Object.entries(manifest.examples)) {
    validateKey(key);
    if (!isObject(entry) || typeof entry.operationId !== "string" || !OPERATION_ID.test(entry.operationId) || entry.operationId === "manifest") {
      throw new Error(`Invalid example operationId for ${key}`);
    }
    if (entry.file !== `docs/api-examples/${entry.operationId}.json` || seenFiles.has(entry.file)) {
      throw new Error(`Invalid example file for ${key}`);
    }
    seenFiles.add(entry.file);
    try {
      if (fs.statSync(path.join(repoRoot, entry.file)).isFile()) available[key] = entry;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return available;
}

export function renderExampleAnnotation(key, examples, repository) {
  validateKey(key);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid GitHub repository for example links.");
  }
  const marker = ` <!-- api-operation:${key} -->`;
  const example = examples[key];
  if (!example) return marker;
  return `${marker} <sub>[JSON](https://github.com/${repository}/blob/main/${example.file})</sub>`;
}

// This mode deliberately reads neither OpenAPI nor translation data and performs no HTTP requests.
export function updateExampleLinksOnly(readme, { repoRoot, repository }) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end <= start || readme.indexOf(START, start + START.length) !== -1 || readme.indexOf(END, end + END.length) !== -1) {
    throw new Error("Expected exactly one complete README API list block.");
  }
  const examples = loadExampleManifest(repoRoot);
  const contentStart = start + START.length;
  const block = readme.slice(contentStart, end).split("\n").map((line) => {
    if (!line.includes("<!-- api-operation:")) {
      if (/^\s*[-*+]\s+\[/.test(line)) {
        throw new Error("README API row has no stable operation key; run the full README generator before --examples-links-only.");
      }
      return line;
    }
    const match = line.match(/^(.*?)\s*<!-- api-operation:([^<>\r\n]+) -->(?:\s*<sub>\[JSON\]\([^)]+\)<\/sub>)?\s*$/);
    if (!match || !match[1].startsWith("- [")) {
      throw new Error("Malformed managed README example link.");
    }
    return `${match[1].trimEnd()}${renderExampleAnnotation(match[2], examples, repository)}`;
  }).join("\n");
  return `${readme.slice(0, contentStart)}${block}${readme.slice(end)}`;
}
