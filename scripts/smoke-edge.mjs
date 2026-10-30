import { existsSync } from "node:fs";
import { join } from "node:path";

const candidates = process.env.EDGE_PATH
  ? [process.env.EDGE_PATH]
  : [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter(Boolean).map(root => join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
const executable = candidates.find(path => existsSync(path));
if (!executable) throw new Error("Microsoft Edge was not found. Set EDGE_PATH to msedge.exe.");

// The shared runner creates an isolated temporary profile and a localhost fixture.
process.env.CHROMIUM_PATH = executable;
console.log("Testing the extension in Microsoft Edge: " + executable);
await import("./smoke-background.mjs");
