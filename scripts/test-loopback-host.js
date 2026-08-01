import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const port = 43998;
const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");

function runVite(args, expectStartup) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteBin, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (expectStartup && output.includes("Local:")) {
        settled = true;
        child.kill("SIGTERM");
        resolve({ code: 0, output });
        return;
      }
      child.kill("SIGTERM");
      reject(new Error("Vite host test timed out. Output: " + output));
    }, 5000);
    const onData = (chunk) => {
      output += String(chunk);
      if (expectStartup && !settled && output.includes("Local:")) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        resolve({ code: 0, output });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}

const rejected = await runVite(["--host", "0.0.0.0", "--port", String(port), "--strictPort"], false);
const allowed = await runVite(["--host", "127.0.0.1", "--port", String(port), "--strictPort"], true);
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const ok =
  rejected.code !== 0 &&
  rejected.output.includes("only allows loopback") &&
  allowed.code === 0 &&
  !readme.includes("--host 0.0.0.0");

console.log(JSON.stringify({
  ok,
  rejectedCode: rejected.code,
  rejectedByGuard: rejected.output.includes("only allows loopback"),
  allowedStarted: allowed.code === 0,
  readmeIsLoopbackOnly: !readme.includes("--host 0.0.0.0"),
}, null, 2));

if (!ok) process.exitCode = 1;
