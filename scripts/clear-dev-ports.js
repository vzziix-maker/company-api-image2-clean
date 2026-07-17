import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";

const projectRoot = realpathSync(process.cwd());
const ports = [Number(process.env.PORT || 43287), Number(process.env.CLIENT_PORT || 43288)];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

function listenerPids(port) {
  return run("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function processCommand(pid) {
  return run("ps", ["-p", pid, "-o", "command="]).trim();
}

function processCwd(pid) {
  const output = run("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"]);
  const cwd = output
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  if (!cwd) return "";
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function isProjectProcess(pid) {
  const cwd = processCwd(pid);
  const command = processCommand(pid);
  return cwd === projectRoot || command.includes(projectRoot);
}

function killPid(pid, signal) {
  try {
    process.kill(Number(pid), signal);
    return true;
  } catch {
    return false;
  }
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearPort(port) {
  const pids = listenerPids(port);
  if (!pids.length) return;

  const safePids = pids.filter(isProjectProcess);
  const skippedPids = pids.filter((pid) => !safePids.includes(pid));

  for (const pid of skippedPids) {
    console.warn(`Port ${port} is used by PID ${pid}, but it is not from this project. Skipped.`);
  }

  for (const pid of safePids) {
    const command = processCommand(pid);
    if (killPid(pid, "SIGTERM")) {
      console.log(`Stopped PID ${pid} on port ${port}: ${command}`);
    }
  }

  await wait(600);

  for (const pid of listenerPids(port).filter(isProjectProcess)) {
    const command = processCommand(pid);
    if (killPid(pid, "SIGKILL")) {
      console.log(`Force stopped PID ${pid} on port ${port}: ${command}`);
    }
  }
}

for (const port of ports) {
  await clearPort(port);
}
