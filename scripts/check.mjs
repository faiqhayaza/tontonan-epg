// Cross-platform `npm run check`: node --check every source and test
// file. (The POSIX `for` loop it replaces cannot run under cmd.exe,
// so the check was unrunnable on a Windows dev machine. The file set
// is the same one the loop covered: build-epg.mjs plus lib, scripts
// and test — this file included, since the list is read live.)
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const files = [
  "build-epg.mjs",
  ...fs.readdirSync(path.join(root, "lib")).map((f) => `lib/${f}`),
  ...fs.readdirSync(path.join(root, "scripts")).map((f) => `scripts/${f}`),
  ...fs.readdirSync(path.join(root, "test")).map((f) => `test/${f}`),
].filter((f) => f.endsWith(".mjs"));

for (const f of files) {
  try {
    await run(process.execPath, ["--check", f], { cwd: root });
  } catch {
    console.error(`node --check failed: ${f}`);
    process.exit(1);
  }
}
