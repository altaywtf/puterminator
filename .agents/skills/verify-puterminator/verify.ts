#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PLAYWRIGHT_CLI = "@playwright/cli@0.1.22";
const READY_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 10_000;
const ROOT = execFileSync("git", ["-C", import.meta.dirname, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const RUNS = join(ROOT, ".verify");
const CURRENT = join(RUNS, "current");
const STORAGE = join(ROOT, ".alchemy/local/puterminator-Puterminator");
const CLI_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "verify-puterminator", PLAYWRIGHT_CLI.replace(/[@/]/g, "_"));
const CLI = join(CLI_DIR, "node_modules", ".bin", "playwright-cli");
const DEV_PROCESSES = "[d]ev-fake\\.ts|[a]lchemy.* dev|[w]orkerd";

type Run = {
  readonly id: string;
  readonly pid: number;
  readonly stashed: boolean;
  readonly url: string | null;
  readonly fakePort: number | null;
};

class Refusal extends Error {}

const refuse = (message: string): never => {
  throw new Refusal(message);
};

const lines = (out: string) => out.split("\n").filter((l) => l.length > 0);

const tryRun = (cmd: string, args: ReadonlyArray<string>) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });

  return r.status === 0 ? r.stdout : "";
};

const alive = (pid: number) => {
  if (pid <= 0) return false;

  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const cwdOf = (pid: number) => lines(tryRun("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])).find((l) => l.startsWith("n"))?.slice(1) ?? "";

const listeners = (port: number) => lines(tryRun("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"])).map(Number);

const tree = (root: number) => {
  const children = new Map<number, Array<number>>();

  for (const [pid, ppid] of lines(tryRun("ps", ["-A", "-o", "pid=,ppid="])).map((l) => l.trim().split(/\s+/).map(Number))) {
    if (pid !== undefined && ppid !== undefined) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }

  const found = new Set<number>();
  const walk = (pid: number) => {
    found.add(pid);

    for (const c of children.get(pid) ?? []) if (!found.has(c)) walk(c);
  };

  walk(root);

  return found;
};

const runDir = (id: string) => join(RUNS, id);

const linked = () => {
  try {
    return lstatSync(CURRENT).isSymbolicLink();
  } catch {
    return false;
  }
};

const currentRun = (): Run | null => {
  if (!linked()) return null;
  const record = join(readlinkSync(CURRENT), "run.json");

  if (!existsSync(record)) refuse(`${CURRENT} points at a missing run; check ${readlinkSync(CURRENT)} for a stash, then remove the link`);
  const run: Run = JSON.parse(readFileSync(record, "utf8"));

  return run;
};

const saveRun = (run: Run) => writeFileSync(join(runDir(run.id), "run.json"), JSON.stringify(run, null, 2));

const requireRun = () => currentRun() ?? refuse("no run; start one with: up");

const ancestors = () => {
  const found = new Set<number>();

  for (let pid = process.pid; pid > 1 && !found.has(pid); pid = Number(tryRun("ps", ["-o", "ppid=", "-p", String(pid)]).trim())) found.add(pid);

  return found;
};

const checkoutDevProcesses = () => {
  const own = ancestors();

  return lines(tryRun("pgrep", ["-f", DEV_PROCESSES]))
    .map(Number)
    .filter((pid) => {
      if (own.has(pid)) return false;
      const cwd = cwdOf(pid);

      return cwd === "" || cwd === ROOT || cwd.startsWith(`${ROOT}/`);
    });
};

const meConfigured = async (url: string) => {
  try {
    const r = await fetch(`${url}/api/me`, { signal: AbortSignal.timeout(2000) });

    return r.ok && (await r.text()).includes('"configured":true');
  } catch {
    return false;
  }
};

const fakeAnswers = async (port: number) => {
  try {
    const r = await fetch(`http://localhost:${port}/v2/oauth2/access_token`, { method: "POST", signal: AbortSignal.timeout(2000) });

    return r.status === 400;
  } catch {
    return false;
  }
};

const signal = (pids: Iterable<number>, sig: NodeJS.Signals) => {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      continue;
    }
  }
};

const stopTree = async (root: number) => {
  const known = tree(root);
  const living = () => {
    for (const pid of [...known]) for (const d of tree(pid)) known.add(d);

    return [...known].filter(alive);
  };

  signal(living(), "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;

  while (living().length > 0 && Date.now() < deadline) await sleep(250);

  for (let i = 0; i < 8 && living().length > 0; i++) {
    signal(living(), "SIGKILL");
    await sleep(250);
  }
};

const restoreStorage = (run: Run) => {
  rmSync(STORAGE, { recursive: true, force: true });
  const stash = join(runDir(run.id), "stash");

  if (run.stashed && existsSync(stash)) renameSync(stash, STORAGE);
};

const teardown = async (run: Run) => {
  if (run.pid > 0) await stopTree(run.pid);
  restoreStorage(run);

  if (linked()) unlinkSync(CURRENT);
};

const up = async () => {
  const previous = currentRun();

  if (previous) refuse(`run ${previous.id} is ${alive(previous.pid) ? "still up" : "stale"}; run: down`);
  const foreign = checkoutDevProcesses();

  if (foreign.length > 0) refuse(`dev processes you did not start run from this checkout (pid ${foreign.join(" ")}); leave them alone`);

  const id = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = runDir(id);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  const logPath = join(dir, "server.log");
  let run: Run = { id, pid: 0, stashed: false, url: null, fakePort: null };
  saveRun(run);
  symlinkSync(dir, CURRENT);

  try {
    if (existsSync(STORAGE)) {
      renameSync(STORAGE, join(dir, "stash"));
      run = { ...run, stashed: true };
      saveRun(run);
    }

    const log = openSync(logPath, "w");

    const child = spawn("pnpm", ["dev:fake"], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, FAKE_PORT: "0", DEV_PORT: "0" },
    });

    child.unref();
    const pid = child.pid ?? refuse("pnpm dev:fake did not start");
    run = { ...run, pid };
    saveRun(run);
    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (!alive(pid)) refuse(`dev:fake exited; log: ${logPath}`);
      const text = readFileSync(logPath, "utf8");
      const fakePort = Number(text.match(/\[fake\] put\.io \+ Anthropic fake on http:\/\/localhost:(\d+)/)?.[1] ?? Number.NaN);
      const url = text.match(/ready at (http:\/\/localhost:\d+)/)?.[1] ?? null;

      if (url !== null && Number.isInteger(fakePort) && (await meConfigured(url))) {
        run = { ...run, url, fakePort };
        saveRun(run);
        console.log(`run ${id} up at ${url} (fake on :${fakePort}, evidence in ${join(dir, "evidence")})`);

        return;
      }

      await sleep(1000);
    }

    refuse(`not ready after ${READY_TIMEOUT_MS / 1000}s; log: ${logPath}`);
  } catch (cause) {
    await teardown(run);
    throw cause;
  }
};

const doctor = async () => {
  const run = requireRun();
  const problems: Array<string> = [];
  const report = (label: string, ok: boolean, detail: string) => {
    console.log(`${label.padEnd(9)} ${ok ? "" : "NOT "}${detail}`);

    if (!ok) problems.push(label);
  };

  console.log(`run:      ${run.id} at ${tryRun("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]).trim()}`);
  report("process:", alive(run.pid), `alive (pid ${run.pid})`);
  report("worker:", run.url !== null && (await meConfigured(run.url)), `answering /api/me at ${run.url ?? "?"}`);
  report("fake:", run.fakePort !== null && (await fakeAnswers(run.fakePort)), `answering on :${run.fakePort ?? "?"}`);

  const ours = tree(run.pid);

  for (const port of [run.fakePort, run.url === null ? null : Number(new URL(run.url).port)]) {
    const pids = port === null ? [] : listeners(port);
    report("owner:", pids.length > 0 && pids.every((p) => ours.has(p)), `listener on :${port ?? "?"} started by this run`);
  }

  if (problems.length > 0) refuse("instance not worth driving");
};

const ensureCli = () => {
  if (existsSync(CLI)) return;
  mkdirSync(CLI_DIR, { recursive: true });
  execFileSync("npm", ["install", "--prefix", CLI_DIR, "--no-audit", "--no-fund", "--silent", PLAYWRIGHT_CLI], { stdio: "inherit" });
};

const pw = (args: ReadonlyArray<string>) => {
  const run = requireRun();
  const evidence = join(runDir(run.id), "evidence");

  if (!existsSync(evidence)) refuse(`evidence folder is gone: ${evidence}`);
  ensureCli();
  const r = spawnSync(CLI, [`-s=puterminator-${run.id}`, ...args], { cwd: evidence, encoding: "utf8" });
  const shown = lines(`${r.stdout}\n${r.stderr}`).filter((l) => !/Update available|[╔║╚]/.test(l));
  console.log(shown.join("\n"));

  return r.status ?? 1;
};

const fakeLog = () => lines(readFileSync(join(runDir(requireRun().id), "server.log"), "utf8")).filter((l) => l.startsWith("[fake] "));

const WRITE = /^\[fake\] (\/v2\/(files\/(delete|rename|move|create-folder)|trash\/restore)|uploaded |POST \/v2\/download_links\/create)/;

const db = (sql: string) => {
  requireRun();
  const files = existsSync(STORAGE) ? readdirSync(STORAGE).filter((f) => /^[0-9a-f]+\.sqlite$/.test(f)) : [];
  const user = files.map((f) => `file:${join(STORAGE, f)}?mode=ro`).find((uri) => tryRun("sqlite3", [uri, "SELECT count(*) FROM secrets WHERE key = 'putio_token'"]).trim() === "1");
  const uri = user ?? refuse("no signed-in user Durable Object yet; sign in first");
  process.stdout.write(execFileSync("sqlite3", ["-header", uri, sql], { encoding: "utf8" }));
};

const down = async () => {
  const run = requireRun();

  if (existsSync(join(runDir(run.id), "evidence")) && existsSync(CLI)) pw(["close"]);
  await teardown(run);

  for (const port of [run.fakePort, run.url === null ? null : Number(new URL(run.url).port)]) {
    if (port !== null && listeners(port).length > 0) console.error(`verify: :${port} still listening`);
  }

  console.log(`run ${run.id} down; evidence kept in ${runDir(run.id)}`);
};

const main = async ([command, ...args]: ReadonlyArray<string>) => {
  for (const tool of ["lsof", "pgrep", "ps", "sqlite3", "npm", "pnpm"]) {
    if (spawnSync("sh", ["-c", `command -v ${tool}`]).status !== 0) refuse(`needs ${tool} on PATH`);
  }

  if (command === "up") return up();

  if (command === "doctor") return doctor();

  if (command === "down") return down();

  if (command === "pw") {
    process.exitCode = pw(args);

    return;
  }

  if (command === "writes") return console.log(fakeLog().filter((l) => WRITE.test(l)).join("\n"));

  if (command === "log") return console.log(fakeLog().join("\n"));

  if (command === "db" && args.length === 1 && args[0] !== undefined) return db(args[0]);

  refuse(`usage: ${basename(process.argv[1] ?? "verify.ts")} up|doctor|pw <playwright-cli args>|writes|log|db '<sql>'|down`);
};

main(process.argv.slice(2)).catch((cause: unknown) => {
  console.error(`verify: ${cause instanceof Refusal ? cause.message : String(cause)}`);
  process.exitCode = 1;
});
