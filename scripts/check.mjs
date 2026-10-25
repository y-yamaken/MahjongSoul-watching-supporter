import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const extension = join(root, "extension");
const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest V3 required");
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["https://game.mahjongsoul.com/*"])) throw new Error("Unexpected host permissions");
if (!manifest.permissions.includes("debugger") || manifest.permissions.includes("offscreen") || manifest.permissions.includes("activeTab")) throw new Error("Unexpected runtime permission");
if (!manifest.content_scripts.some(script => script.js.includes("page.js") &&
    (script.world ?? "ISOLATED") === "ISOLATED" && script.run_at === "document_start")) {
  throw new Error("Input observation must be registered before game event handlers");
}
for (const script of manifest.content_scripts) {
  if (script.run_at !== "document_start") throw new Error("Network observer must start before the game");
  for (const file of script.js) await readFile(join(extension, file));
}
for (const path of ["popup.html", "offscreen.html", "background.js", "page.js", ...Object.values(manifest.icons)]) {
  await readFile(join(extension, path));
}
const inventory = JSON.parse(await readFile(join(extension, "vendor", "inventory.json"), "utf8"));
for (const item of inventory.files) {
  const contents = await readFile(join(extension, "vendor", item.path));
  if (createHash("sha256").update(contents).digest("hex") !== item.sha256) throw new Error("Vendor checksum mismatch: " + item.path);
}
async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "vendor") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await checkDirectory(path); continue; }
    if (!/\.(js|mjs|json|html|css|md)$/u.test(entry.name)) continue;
    const contents = await readFile(path, "utf8");
    if (contents.includes("\r")) throw new Error("Expected LF line endings: " + path);
    if (/\.(js|mjs)$/u.test(entry.name)) {
      const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    }
  }
}
await checkDirectory(extension);
await checkDirectory(join(root, "scripts"));
await checkDirectory(join(root, "src"));
await checkDirectory(join(root, "tests"));
console.log("Manifest, syntax, LF line endings, icons and " + inventory.files.length + " vendor checksums verified.");

