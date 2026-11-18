/**
 * Shared harness for the black-box build-epg.mjs tests (no tests of its
 * own). build-epg.mjs is never imported — importing it starts the real
 * build — so each test stages a temp dir holding build-epg.mjs, lib/,
 * the fixture files, and a fetch stub that `node --import` loads before
 * the build, then runs it as a child process. No real network is
 * touched: every fetch goes to the stub.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/* Every upstream answers 404, so every adapter that needs the network
 * fails fast (404 is not retried). */
export const FETCH_404_STUB = `globalThis.fetch = async () => ({ ok: false, status: 404, headers: new Headers() });
`;

/* Routes come from ./stub-routes.json, re-read on every request so a
 * test can rewrite it between runs. A route is
 *   { json }                 -> that value as a JSON body
 *   { raw }                  -> a base64 body, as-is
 *   { channels, programmes } -> an XMLTV body; programme times are
 *                               hours relative to the child's start, so
 *                               they land in the build's window
 * plus `gzip: true` to gzip the body. Unrouted URLs answer 404. */
export const ROUTING_FETCH_STUB = `import fs from "node:fs";
import zlib from "node:zlib";
const H = 3600000;
const NOW = Date.now();
const p = (n) => String(n).padStart(2, "0");
const ts = (ms) => { const d = new Date(ms); return "" + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + " +0000"; };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
function xmltv(r) {
  let x = '<?xml version="1.0"?><tv>';
  for (const c of r.channels ?? []) x += '<channel id="' + c.id + '"><display-name>' + esc(c.name ?? c.id) + '</display-name></channel>';
  for (const g of r.programmes ?? []) x += '<programme start="' + ts(NOW + g.startH * H) + '" stop="' + ts(NOW + g.stopH * H) + '" channel="' + g.channel + '"><title>' + esc(g.title) + '</title></programme>';
  return x + '</tv>';
}
globalThis.fetch = async (url) => {
  const routes = JSON.parse(fs.readFileSync(new URL("./stub-routes.json", import.meta.url), "utf8"));
  const r = routes[String(url)];
  if (!r) return new Response("not found", { status: 404 });
  let body = r.json !== undefined ? Buffer.from(JSON.stringify(r.json)) : r.raw !== undefined ? Buffer.from(r.raw, "base64") : Buffer.from(xmltv(r));
  if (r.gzip) body = zlib.gzipSync(body);
  return new Response(body, { status: 200 });
};
`;

const asText = (v) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * Stage a build dir. `matches` and `previousReport` take a string (written
 * as-is, e.g. corrupt JSON) or a value (JSON-encoded). `routes` (for
 * ROUTING_FETCH_STUB) writes stub-routes.json. `previousReport` and
 * `previousEpg` are written only when given: no build-report.json means
 * no gate baseline, no epg.json means nothing to keep.
 */
export function stageBuild({ matches = {}, stub = FETCH_404_STUB, routes, previousReport, previousEpg } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epg-build-test-"));
  fs.copyFileSync(path.join(repoRoot, "build-epg.mjs"), path.join(dir, "build-epg.mjs"));
  fs.mkdirSync(path.join(dir, "lib"));
  for (const f of fs.readdirSync(path.join(repoRoot, "lib"))) fs.copyFileSync(path.join(repoRoot, "lib", f), path.join(dir, "lib", f));
  fs.writeFileSync(path.join(dir, "matches.json"), asText(matches));
  fs.writeFileSync(path.join(dir, "fetch-stub.mjs"), stub);
  if (routes !== undefined) writeRoutes(dir, routes);
  if (previousReport !== undefined) fs.writeFileSync(path.join(dir, "build-report.json"), asText(previousReport));
  if (previousEpg !== undefined) fs.writeFileSync(path.join(dir, "epg.json"), previousEpg);
  return dir;
}

export function writeRoutes(dir, routes) {
  fs.writeFileSync(path.join(dir, "stub-routes.json"), JSON.stringify(routes));
}

/**
 * Run the staged build to completion. Resolves (never rejects) with
 * { code, killed, stdout, stderr, report }; `report` is the parsed
 * build-report.json, or null when the run left none. EPG_BEST_URL is
 * cleared unless `env` sets it, so a developer's own secret never
 * reaches a test build.
 */
export async function runBuild(dir, { env = {}, timeout = 0 } = {}) {
  const res = await run(process.execPath, ["--import", "./fetch-stub.mjs", "build-epg.mjs"], {
    cwd: dir,
    env: { ...process.env, EPG_BEST_URL: "", ...env },
    timeout,
  }).then(
    (r) => ({ code: 0, killed: false, stdout: r.stdout, stderr: r.stderr }),
    (e) => ({ code: e.code, killed: e.killed ?? false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }),
  );
  const reportPath = path.join(dir, "build-report.json");
  return { ...res, report: fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null };
}

export const readText = (dir, name) => fs.readFileSync(path.join(dir, name), "utf8");

export const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });
