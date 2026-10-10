import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { exec, spawn, ChildProcess } from "child_process";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import dns from "dns";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

// Load environment variables from .env file. These are BAS's own settings
// (panel password, API keys…) and are kept out of the apps' environment.
const basPrivateEnv = Object.keys(dotenv.config().parsed || {});

// Fix DNS resolution priority for localhost in older Node environments
dns.setDefaultResultOrder("ipv4first");

// Set by the esbuild production build (see package.json), so `npm start` never serves the Vite dev server
declare const BAS_PRODUCTION_BUILD: boolean | undefined;
const isProduction = process.env.NODE_ENV === "production" || (typeof BAS_PRODUCTION_BUILD !== "undefined" && BAS_PRODUCTION_BUILD);

// BAS's own settings and secrets, which must not reach managed apps, npm scripts or git
const BAS_PRIVATE_ENV_KEYS = ["ADMIN_USERNAME", "ADMIN_PASSWORD", "GEMINI_API_KEY", "SMS_API_URL", "SMS_APIKEY_BAS", "ALLOWED_IPS", "UNAUTHORIZED_REDIRECT_URL"];

// Environment for child processes: BAS's environment minus its private keys and BAS_* settings
function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  Object.keys(env).forEach((key) => {
    if (BAS_PRIVATE_ENV_KEYS.includes(key) || key.startsWith("BAS_")) delete env[key];
  });
  return { ...env, ...extra };
}

// Security state
export interface AccessLog {
  ip: string;
  timestamp: string;
  action: string;
  success: boolean;
}
const accessLogs: AccessLog[] = [];
const bannedIPs = new Map<string, number>();
// Failed sign-ins per IP, forgotten after a day without failures. `keys` holds recently rejected API keys,
// so a stale key repeated by an old open tab counts once instead of banning the admin's own IP.
const failedAttempts = new Map<string, { count: number; lastAt: number; keys: string[] }>();
const FAILED_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
let lastSecuritySmsAt = 0;

function logAccess(ip: string, action: string, success: boolean) {
  accessLogs.unshift({ ip, timestamp: new Date().toISOString(), action, success });
  if (accessLogs.length > 200) accessLogs.pop();
}

function handleFailedAttempt(ip: string, rejectedKey?: string) {
  const now = Date.now();
  if (failedAttempts.size > 10000) {
    failedAttempts.forEach((entry, key) => {
      if (now - entry.lastAt > FAILED_ATTEMPT_WINDOW_MS) failedAttempts.delete(key);
    });
    bannedIPs.forEach((expiry, key) => {
      if (now > expiry) bannedIPs.delete(key);
    });
  }

  const previous = failedAttempts.get(ip);
  const entry: { count: number; lastAt: number; keys: string[] } =
    previous && now - previous.lastAt < FAILED_ATTEMPT_WINDOW_MS ? previous : { count: 0, lastAt: now, keys: [] };
  if (rejectedKey) {
    const keyHash = sha256(rejectedKey);
    if (entry.keys.includes(keyHash)) return;
    entry.keys = [...entry.keys.slice(-9), keyHash];
  }
  entry.count += 1;
  entry.lastAt = now;
  failedAttempts.set(ip, entry);
  const count = entry.count;
  logAccess(ip, `Failed Auth (Count: ${count})`, false);
  
  if (count >= 5 && !bannedIPs.has(ip)) {
    bannedIPs.set(ip, now + 24 * 60 * 60 * 1000); // 24 hours ban
    logAccess(ip, "IP BANNED (5+ Failed Attempts)", false);
    // At most one SMS per 15 minutes, so attempts from many addresses can't flood the admin's phone
    if (now - lastSecuritySmsAt > 15 * 60 * 1000) {
      lastSecuritySmsAt = now;
      triggerSMSAlert("SECURITY", "ATCK" + String(ip).replace(/[^0-9]/g, "").substring(0, 5));
    }
  }
}

interface AppConfig {
  id: string;
  name: string;
  path: string;
  type: "backend" | "frontend";
  entry: string;
  port: number;
  autoStart: boolean;
  version?: string;
  groups?: string[];
  alertEnabled?: boolean;
  alertThreshold?: number;
  gitUrl?: string;
  gitBranch?: string;
  // Any-language backends (Go, Python, binaries…), all optional:
  start?: string; // shell command that runs the app instead of `node <entry>`
  build?: string; // shell command run before starting (start / restart / git update)
  env?: Record<string, string>; // extra environment variables for build and start
  stopTimeout?: number; // seconds between SIGTERM and SIGKILL when stopping (default 10)
}

interface SMSGatewayConfig {
  provider: string;
  apiKey: string;
  endpoint: string;
  sender: string;
  recipient: string;
  enabled: boolean;
}

interface OrchestratorSettings {
  autoRestart: boolean;
  maxRestarts: number;
  restartDelayMs: number;
}

interface OrchestratorConfig {
  apps: AppConfig[];
  smsGateway: SMSGatewayConfig;
  settings: OrchestratorSettings;
}

interface AppRuntimeState {
  config: AppConfig;
  status: "RUNNING" | "STOPPED" | "CRASHED" | "STARTING" | "BUILDING";
  pid: number | null;
  restarts: number;
  crashCount: number;
  cpu: number;
  memory: number;
  uptime: number; // in seconds
  logs: string[];
  lastCrashTime: string | null;
  childProcess: ChildProcess | null;
  buildProcess?: ChildProcess | null;
  stopping?: Promise<void> | null; // set while a stop is waiting for the process to exit
  staticServer: any | null; // express/http server instance for frontends
  servingRoot?: string | null; // set during an update's build: serve this copy of the previous build instead
}

// Global Orchestrator State
let config: OrchestratorConfig = {
  apps: [],
  smsGateway: { provider: "", apiKey: "", endpoint: "", sender: "", recipient: "", enabled: false },
  settings: { autoRestart: true, maxRestarts: 5, restartDelayMs: 2000 }
};

const appStates = new Map<string, AppRuntimeState>();
let gitUpdateLogs: string[] = [];
let gitUpdateRunning = false;
let gitUpdateProgress = 0;
let gitAuthRequired = false;
// Per-deployment files: every copy of a repository (e.g. one per customer) keeps its own version of these
const INSTANCE_FILES = ["bas.config.json", ".env"];
// npm install / build can take far longer than git on small servers
const NPM_STEP_TIMEOUT_MS = 15 * 60 * 1000;
let lastScanTime = 0;

// System Hardware & HTOP Telemetry
export interface CpuCoreMetric {
  core: number;
  usage: number; // 0-100%
  speed: number;
  model: string;
}

interface PrevCpuTimes {
  idle: number;
  total: number;
}

let lastCpuTimes: PrevCpuTimes[] = [];
let cachedCoresMetric: CpuCoreMetric[] = [];

function sampleCpuTicks(): CpuCoreMetric[] {
  try {
    const cpus = os.cpus() || [];
    if (cpus.length === 0) return [];

    const currentTimes = cpus.map((cpu) => {
      const times = cpu.times;
      const total = times.user + times.nice + times.sys + times.idle + times.irq;
      return { idle: times.idle, total };
    });

    const coreResults: CpuCoreMetric[] = [];

    if (lastCpuTimes.length === currentTimes.length) {
      for (let i = 0; i < currentTimes.length; i++) {
        const prev = lastCpuTimes[i];
        const curr = currentTimes[i];
        const totalDiff = curr.total - prev.total;
        const idleDiff = curr.idle - prev.idle;
        const usage = totalDiff > 0 ? Math.max(0, Math.min(100, Math.round(((totalDiff - idleDiff) / totalDiff) * 1000) / 10)) : 0;
        coreResults.push({
          core: i + 1,
          usage,
          speed: cpus[i]?.speed || 0,
          model: cpus[i]?.model || "CPU"
        });
      }
    } else {
      for (let i = 0; i < currentTimes.length; i++) {
        const times = cpus[i].times;
        const total = times.user + times.nice + times.sys + times.idle + times.irq;
        const usage = total > 0 ? Math.max(0, Math.min(100, Math.round(((total - times.idle) / total) * 1000) / 10)) : 0;
        coreResults.push({
          core: i + 1,
          usage,
          speed: cpus[i]?.speed || 0,
          model: cpus[i]?.model || "CPU"
        });
      }
    }

    lastCpuTimes = currentTimes;
    cachedCoresMetric = coreResults;
    return coreResults;
  } catch (e) {
    return cachedCoresMetric;
  }
}

function getDetailedMemory() {
  let totalMb = Math.round(os.totalmem() / (1024 * 1024));
  let freeMb = Math.round(os.freemem() / (1024 * 1024));
  let availableMb = freeMb;
  let cachedMb = 0;
  let buffersMb = 0;
  let swapTotalMb = 0;
  let swapFreeMb = 0;
  let swapUsedMb = 0;

  try {
    if (fs.existsSync("/proc/meminfo")) {
      const content = fs.readFileSync("/proc/meminfo", "utf-8");
      const lines = content.split("\n");
      const map: Record<string, number> = {};
      for (const line of lines) {
        const parts = line.split(":");
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parseInt(parts[1].trim().split(/\s+/)[0], 10);
          if (!isNaN(val)) {
            map[key] = val; // in kB
          }
        }
      }
      if (map["MemTotal"]) totalMb = Math.round(map["MemTotal"] / 1024);
      if (map["MemFree"]) freeMb = Math.round(map["MemFree"] / 1024);
      if (map["MemAvailable"]) availableMb = Math.round(map["MemAvailable"] / 1024);
      else availableMb = freeMb + Math.round((map["Cached"] || 0) / 1024) + Math.round((map["Buffers"] || 0) / 1024);
      if (map["Cached"]) cachedMb = Math.round(map["Cached"] / 1024);
      if (map["Buffers"]) buffersMb = Math.round(map["Buffers"] / 1024);
      if (map["SwapTotal"]) swapTotalMb = Math.round(map["SwapTotal"] / 1024);
      if (map["SwapFree"]) swapFreeMb = Math.round(map["SwapFree"] / 1024);
      swapUsedMb = Math.max(0, swapTotalMb - swapFreeMb);
    }
  } catch (e) {
    // fallback to standard Node os.freemem
  }

  const usedMb = Math.max(0, totalMb - availableMb);
  const usedPercent = totalMb > 0 ? parseFloat(((usedMb / totalMb) * 100).toFixed(1)) : 0;
  const freePercent = totalMb > 0 ? parseFloat(((freeMb / totalMb) * 100).toFixed(1)) : 0;
  const availablePercent = totalMb > 0 ? parseFloat(((availableMb / totalMb) * 100).toFixed(1)) : 0;

  return {
    totalMb,
    usedMb,
    freeMb,
    availableMb,
    cachedMb,
    buffersMb,
    usedPercent,
    freePercent,
    availablePercent,
    swapTotalMb,
    swapUsedMb,
    swapFreeMb
  };
}

// Initial sample
sampleCpuTicks();

// Load Config File
const configPath = path.resolve(process.cwd(), "config.json");
function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, "utf-8");
      config = JSON.parse(data);
      console.log("[Orchestrator] Configuration loaded successfully.");
    } else {
      console.warn("[Orchestrator] config.json not found, using default template.");
    }
  } catch (error) {
    console.error("[Orchestrator] Error loading config.json:", error);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    console.log("[Orchestrator] Configuration saved successfully.");
  } catch (error) {
    console.error("[Orchestrator] Error saving config.json:", error);
  }
}

// Initialize Gemini Client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Helper to push logs with timestamps
function addLog(appId: string, text: string, type: "stdout" | "stderr" | "system" = "stdout") {
  const state = appStates.get(appId);
  if (!state) return;

  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] [${type.toUpperCase()}] ${text}`;
  
  state.logs.push(logLine);
  if (state.logs.length > 500) {
    state.logs.shift(); // Keep buffer max 500 lines
  }
}

// Send SMS alert via custom SMS Gateway
async function triggerSMSAlert(appId: string, appName: string) {
  const gateway = config.smsGateway;
  if (!gateway.enabled) {
    console.log(`[Orchestrator] SMS alert is disabled for crash of ${appName}.`);
    return;
  }

  addLog(appId, `[SYSTEM] Triggering SMS alert to ${gateway.recipient}...`, "system");

  const apiKey = process.env.SMS_APIKEY_BAS;
  const apiUrl = process.env.SMS_API_URL;
  
  if (!apiKey || !apiUrl) {
    addLog(appId, `[SMS ERROR] SMS_APIKEY_BAS or SMS_API_URL environment variable is not set in .env`, "system");
    return;
  }

  try {
    const targetUrl = new URL(apiUrl);
    targetUrl.searchParams.append("receiver", gateway.recipient);
    targetUrl.searchParams.append("message", `هشدار: سرویس ${appName || appId} متوقف شده و در حال راه‌اندازی مجدد است.`);
    targetUrl.searchParams.append("token", apiKey);

    addLog(appId, `[SMS API] GET Request to configured SMS gateway`, "system");

    const response = await fetch(targetUrl.toString(), {
      method: "GET"
    });

    if (response.ok) {
      const respText = await response.text();
      addLog(appId, `[SMS SUCCESS] SMS Alert sent successfully. Status: ${response.status}. Response: ${respText}`, "system");
    } else {
      const respText = await response.text();
      addLog(appId, `[SMS WARNING] SMS API returned non-200 code: ${response.status}. Response: ${respText}`, "system");
    }
  } catch (error: any) {
    addLog(appId, `[SMS ERROR] SMS gateway delivery failed. Network info: ${error.message}`, "system");
  }
}

const isWindows = process.platform === "win32";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Environment for an app's build and start commands. PORT always comes from BAS.
function appEnv(state: AppRuntimeState): NodeJS.ProcessEnv {
  const env = childEnv();
  for (const key of basPrivateEnv) delete env[key]; // e.g. BAS's ADMIN_PASSWORD must not leak into apps
  return {
    ...env,
    NODE_PATH: path.resolve(process.cwd(), "node_modules"),
    ...(state.config.env || {}),
    PORT: state.config.port.toString()
  };
}

// Apps run in their own process group, so stopping one also stops whatever it
// spawned (e.g. `sh -c "cd server && ./app"` → the shell and the app).
function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (isWindows) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (e) {
    try {
      child.kill(signal);
    } catch (e2) {}
  }
}

function groupAlive(child: ChildProcess): boolean {
  if (!child.pid) return false;
  if (isWindows) return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

async function waitGroupGone(child: ChildProcess, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!groupAlive(child)) return true;
    await sleep(200);
  }
  return !groupAlive(child);
}

function pipeLogs(id: string, child: ChildProcess) {
  child.stdout?.on("data", (data) => {
    const text = data.toString().trim();
    if (text) addLog(id, text, "stdout");
  });
  child.stderr?.on("data", (data) => {
    const text = data.toString().trim();
    if (text) addLog(id, text, "stderr");
  });
}

// Runs the app's `build` command. Resolves true on success.
function runBuild(id: string, state: AppRuntimeState, appPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    addLog(id, `[SYSTEM] Building: ${state.config.build}`, "system");
    state.status = "BUILDING";
    let child: ChildProcess;
    try {
      child = spawn(state.config.build!, {
        cwd: appPath,
        env: appEnv(state),
        shell: true,
        detached: !isWindows,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err: any) {
      addLog(id, `[SYSTEM_ERROR] Could not run build: ${err.message}`, "stderr");
      resolve(false);
      return;
    }
    state.buildProcess = child;
    pipeLogs(id, child);
    const timer = setTimeout(() => {
      addLog(id, `[SYSTEM_ERROR] Build took longer than 15 minutes; stopping it.`, "stderr");
      signalGroup(child, "SIGKILL");
    }, 15 * 60 * 1000);
    child.on("error", (err) => addLog(id, `[SYSTEM_ERROR] Build failed to start: ${err.message}`, "stderr"));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (state.buildProcess === child) state.buildProcess = null;
      addLog(id, code === 0 ? `[SYSTEM] Build finished.` : `[SYSTEM_ERROR] Build failed (exit code ${code}).`, code === 0 ? "system" : "stderr");
      resolve(code === 0);
    });
  });
}

// Start Application Process. Runs the `build` command first unless opts.build is false
// (crash recovery restarts skip it so they stay fast).
async function startApp(id: string, opts: { build?: boolean } = {}) {
  const state = appStates.get(id);
  if (!state) return;
  if (state.stopping) await state.stopping; // never start while the old process still holds the port

  if (state.status === "RUNNING" || state.status === "STARTING" || state.status === "BUILDING") {
    addLog(id, `[SYSTEM] App is already ${state.status === "RUNNING" ? "running" : "starting"}.`, "system");
    return;
  }

  state.status = "STARTING";
  addLog(id, `[SYSTEM] Starting application...`, "system");

  const appPath = path.resolve(process.cwd(), state.config.path);
  const entryFile = path.join(appPath, state.config.entry);

  if (state.config.type === "backend") {
    // BACKEND APP
    if (state.config.build && opts.build !== false) {
      const ok = await runBuild(id, state, appPath);
      if ((state.status as AppRuntimeState["status"]) === "STOPPED") return; // stopped while building
      if (!ok) addLog(id, `[SYSTEM] Starting with the previous build.`, "system");
      state.status = "STARTING";
    }

    const command = state.config.start?.trim();

    // Check if entry file exists
    if (!command && !fs.existsSync(entryFile)) {
      state.status = "CRASHED";
      addLog(id, `[SYSTEM_ERROR] Entry file not found: ${entryFile}`, "stderr");
      return;
    }

    try {
      const child = command
        ? spawn(command, { cwd: appPath, env: appEnv(state), shell: true, detached: !isWindows })
        : spawn("node", [state.config.entry], { cwd: appPath, env: appEnv(state), detached: !isWindows });

      state.childProcess = child;
      state.pid = child.pid || null;
      state.status = "RUNNING";
      state.uptime = 0;

      addLog(
        id,
        command
          ? `[SYSTEM] Process spawned successfully (PID: ${child.pid}): ${command}`
          : `[SYSTEM] Process spawned successfully (PID: ${child.pid}) with NODE_PATH integration.`,
        "system"
      );

      pipeLogs(id, child);

      child.on("close", (code, signal) => {
        addLog(id, `[SYSTEM] Process exited with code ${code} (signal: ${signal || "none"})`, "system");

        // A process we already stopped or replaced (restart) must not touch the new one's state.
        if (state.childProcess !== child) {
          return;
        }

        state.childProcess = null;
        state.pid = null;
        state.cpu = 0;
        state.memory = 0;

        // If it was stopped intentionally, keep status STOPPED
        if (state.status === "STOPPED") {
          return;
        }

        // If it was already marked as CRASHED (e.g. via simulation), don't overwrite
        if (state.status === "CRASHED") {
          return;
        }

        if ((code !== 0 && code !== null) || (signal && signal !== "SIGTERM")) {
          // Crashed!
          state.status = "CRASHED";
          state.lastCrashTime = new Date().toISOString();
          state.crashCount += 1;
          addLog(id, `[SYSTEM] CRASH DETECTED! Exit code: ${code}, signal: ${signal}. Triggering Orchestrator Recovery...`, "system");
          
          // Trigger SMS Alert based on project settings
          const alertEnabled = state.config.alertEnabled !== false; // Default true if undefined
          const alertThreshold = state.config.alertThreshold ?? 5; // Default 5 crashes
          if (alertEnabled && state.crashCount % alertThreshold === 0) {
             triggerSMSAlert(id, state.config.name);
          }

          // Auto-Restart logic
          if (config.settings.autoRestart && state.restarts < config.settings.maxRestarts) {
            state.restarts += 1;
            const delay = Math.max(2500, config.settings.restartDelayMs || 2500);
            addLog(id, `[SYSTEM] Scheduling auto-restart #${state.restarts} in ${delay}ms...`, "system");
            setTimeout(() => {
              if (state.status === "CRASHED") {
                startApp(id, { build: false });
              }
            }, delay);
          } else if (state.restarts >= config.settings.maxRestarts) {
            addLog(id, `[SYSTEM_ERROR] Max auto-restarts limit (${config.settings.maxRestarts}) reached. Manual intervention required.`, "stderr");
          }
        } else {
          state.status = "STOPPED";
        }
      });

      child.on("error", (err) => {
        state.status = "CRASHED";
        addLog(id, `[SYSTEM_ERROR] Failed to spawn process: ${err.message}`, "stderr");
      });

    } catch (err: any) {
      state.status = "CRASHED";
      addLog(id, `[SYSTEM_ERROR] Error spawning child process: ${err.message}`, "stderr");
    }

  } else {
    // FRONTEND APP - Serve build folder statically on custom port
    const buildPath = path.resolve(appPath, state.config.entry);
    addLog(id, `[SYSTEM] Frontend client: serving static assets from: ${buildPath}`, "system");

    try {
      const fApp = express();
      const serveBuild = express.static(buildPath);
      fApp.use((req, res, next) => (state.servingRoot ? express.static(state.servingRoot) : serveBuild)(req, res, next));
      fApp.get("*", (req, res) => {
        res.sendFile(path.join(state.servingRoot || buildPath, "index.html"));
      });

      const fServer = fApp.listen(state.config.port, "0.0.0.0", () => {
        addLog(id, `[SYSTEM] Static Web Server actively serving client on port ${state.config.port}`, "system");
      });

      state.staticServer = fServer;
      state.status = "RUNNING";
      state.pid = 9999 + Math.floor(Math.random() * 1000); // Mock PID for display
      state.uptime = 0;

      fServer.on("error", (err: any) => {
        state.status = "CRASHED";
        addLog(id, `[SYSTEM_ERROR] Static server port conflict or error: ${err.message}`, "stderr");
      });

    } catch (err: any) {
      state.status = "CRASHED";
      addLog(id, `[SYSTEM_ERROR] Failed to start frontend static web server: ${err.message}`, "stderr");
    }
  }
}

// Stop Application Process: SIGTERM so the app can save its data and close
// cleanly, then SIGKILL if it hasn't exited after `stopTimeout` seconds.
// Resolves once the app and everything it started are gone (port released).
function stopApp(id: string, reason = "Manual STOP requested by administrator."): Promise<void> {
  const state = appStates.get(id);
  if (!state) return Promise.resolve();
  const done = stopAppNow(id, state, reason).finally(() => {
    if (state.stopping === done) state.stopping = null;
  });
  state.stopping = done;
  return done;
}

async function stopAppNow(id: string, state: AppRuntimeState, reason: string) {

  addLog(id, `[SYSTEM] ${reason}`, "system");
  state.status = "STOPPED";
  state.restarts = 0; // Reset restart counter on manual stop

  if (state.buildProcess) {
    signalGroup(state.buildProcess, "SIGKILL");
    state.buildProcess = null;
  }

  if (state.config.type === "backend") {
    const child = state.childProcess;
    state.childProcess = null;
    state.pid = null;
    state.cpu = 0;
    state.memory = 0;
    if (!child || !groupAlive(child)) return;

    const timeout = Math.max(1, state.config.stopTimeout ?? 10);
    addLog(id, `[SYSTEM] Sending SIGTERM to PID ${child.pid} (force kill after ${timeout}s)...`, "system");
    signalGroup(child, "SIGTERM");
    if (!(await waitGroupGone(child, timeout * 1000))) {
      addLog(id, `[SYSTEM] Process did not exit in ${timeout}s; sending SIGKILL.`, "system");
      signalGroup(child, "SIGKILL");
      await waitGroupGone(child, 3000);
    }
    addLog(id, `[SYSTEM] Process stopped.`, "system");
  } else {
    if (state.staticServer) {
      addLog(id, `[SYSTEM] Stopping frontend web server on port ${state.config.port}...`, "system");
      state.staticServer.close();
      state.staticServer = null;
    }
    state.pid = null;
    state.cpu = 0;
    state.memory = 0;
  }
}

// Restart Application Process (waits for the old process to exit first)
async function restartApp(id: string) {
  addLog(id, `[SYSTEM] Manual RESTART requested.`, "system");
  await stopApp(id, "Stopping for restart...");
  await startApp(id);
}

// Simulate Process Crash (For testing recovery, SRE, logs and notifications)
function simulateAppCrash(id: string): boolean {
  const state = appStates.get(id);
  if (!state || state.status !== "RUNNING") return false;

  addLog(id, `[CRITICAL FATAL EXCEPTION] Process uncaughtException: simulated fatal memory corruption at 0x7fff5fbff8b0 (SIGSEGV)`, "stderr");
  addLog(id, `[CRITICAL FATAL EXCEPTION] Stack trace: Error: OutOfMemory / Segmentation Fault at WorkerThread.run (/apps/${state.config.path}/${state.config.entry}:42:15)`, "stderr");
  addLog(id, `[SYSTEM] Emergency core dump written. Process terminated unexpectedly. Status updated to CRASHED.`, "system");

  state.status = "CRASHED";
  state.lastCrashTime = new Date().toISOString();

  // Terminate backend child process or static server
  if (state.childProcess) {
    signalGroup(state.childProcess, "SIGKILL");
    state.childProcess = null;
  }
  if (state.staticServer) {
    try {
      state.staticServer.close();
    } catch (e) {}
    state.staticServer = null;
  }

  state.pid = null;
  state.cpu = 0;
  state.memory = 0;
  state.crashCount += 1;

  // Trigger SMS Alert based on project settings
  const alertEnabled = state.config.alertEnabled !== false;
  const alertThreshold = state.config.alertThreshold ?? 5;
  if (alertEnabled && state.crashCount % alertThreshold === 0) {
     triggerSMSAlert(id, state.config.name);
  }

  // Auto-Restart logic (give 3 seconds of visible crash state before auto-recovering so user sees the crash)
  if (config.settings.autoRestart && state.restarts < config.settings.maxRestarts) {
    state.restarts += 1;
    const delay = Math.max(3000, config.settings.restartDelayMs || 3000);
    addLog(id, `[SYSTEM] Crash Recovery Activated: Auto-recovery restart #${state.restarts} scheduled in ${delay}ms...`, "system");
    setTimeout(() => {
      if (state.status === "CRASHED") {
        startApp(id, { build: false });
      }
    }, delay);
  } else if (state.restarts >= config.settings.maxRestarts) {
    addLog(id, `[SYSTEM_ERROR] Max auto-restarts limit (${config.settings.maxRestarts}) reached. Manual restart needed.`, "stderr");
  }

  return true;
}

// Read an app folder's package.json and bas.config.json
function readAppManifest(fullPath: string, dir: string): { pkgData: any; basConfig: any } {
  // Read package.json if it exists
  const pkgPath = path.join(fullPath, "package.json");
  let pkgData: any = {};
  if (fs.existsSync(pkgPath)) {
    try {
      pkgData = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    } catch (e) {
      console.error(`[BAS] Error parsing package.json for ${dir}:`, e);
    }
  }

  // Read bas.config.json
  const basConfigPath = path.join(fullPath, "bas.config.json");
  let basConfig: any = {};
  if (fs.existsSync(basConfigPath)) {
    try {
      const rawConfig = JSON.parse(fs.readFileSync(basConfigPath, "utf-8"));
      // If they just renamed their package.json, the config is under .orchestrator
      basConfig = rawConfig.orchestrator || rawConfig;
    } catch (e) {
      console.error(`[BAS] Error parsing bas.config.json for ${dir}:`, e);
    }
  } else {
    // Fallback for backwards compatibility
    basConfig = pkgData.orchestrator || {};
  }

  return { pkgData, basConfig };
}

function createAppState(appConfig: AppConfig): AppRuntimeState {
  return {
    config: appConfig,
    status: "STOPPED",
    pid: null,
    restarts: 0,
    crashCount: 0,
    cpu: 0,
    memory: 0,
    uptime: 0,
    logs: [],
    lastCrashTime: null,
    childProcess: null,
    staticServer: null
  };
}

// Automatically scan apps directory and sync with config with throttling to protect performance
function scanAppsDirectory(force = false) {
  const now = Date.now();
  if (!force && (now - lastScanTime < 10000)) {
    return; // Skip physical I/O scan if performed within last 10 seconds
  }
  lastScanTime = now;

  const appsDir = path.resolve(process.cwd(), "apps");
  if (!fs.existsSync(appsDir)) {
    try {
      fs.mkdirSync(appsDir, { recursive: true });
    } catch (e) {
      console.error("[Orchestrator] Failed to create apps directory:", e);
      return;
    }
  }

  const appDirs = fs.readdirSync(appsDir).filter((dir) => {
    try {
      return fs.statSync(path.join(appsDir, dir)).isDirectory();
    } catch (e) {
      return false;
    }
  });
  const manifests = new Map(appDirs.map((dir) => [dir, readAppManifest(path.join(appsDir, dir), dir)] as const));
  let configChanged = false;

  // Several folders can be deployments of the same repository (e.g. one per customer) and so share the same
  // package.json name. Count the candidate ids so those folders fall back to their unique folder name instead.
  const idCounts = new Map<string, number>();
  manifests.forEach(({ pkgData, basConfig }, dir) => {
    const candidate = basConfig.id || pkgData.name || dir;
    idCounts.set(candidate, (idCounts.get(candidate) || 0) + 1);
  });

  // Track directories currently existing under apps/
  const existingAppPaths = new Set<string>();

  appDirs.forEach((dir) => {
    const fullPath = path.join(appsDir, dir);
    const relativePath = path.join("apps", dir);
    existingAppPaths.add(relativePath);

    const { pkgData, basConfig } = manifests.get(dir)!;

    const pkgName = pkgData.name || dir;

    let id = basConfig.id || pkgName;
    if ((idCounts.get(id) || 0) > 1) {
      if (basConfig.id) {
        console.warn(`[BAS] Duplicate id "${id}" in ${relativePath}/bas.config.json, using folder name "${dir}" instead.`);
      }
      id = dir;
    }
    const name = basConfig.name || pkgData.description || dir;
    const version = pkgData.version || "1.0.0";
    
    let groups: string[] = [];
    if (basConfig.groups) {
      if (Array.isArray(basConfig.groups)) {
        groups = basConfig.groups;
      } else if (typeof basConfig.groups === "string") {
        groups = basConfig.groups.split(",").map((s: string) => s.trim()).filter(Boolean);
      }
    }

    let type: "backend" | "frontend" = "backend";
    if (basConfig.type) {
      type = basConfig.type;
    } else {
      const deps = { ...(pkgData.dependencies || {}), ...(pkgData.devDependencies || {}) };
      if (deps.react || deps.vue || deps.svelte || deps.vite || deps.next || deps.astro || pkgData.scripts?.build) {
        type = "frontend";
      }
    }

    let entry = "server.js";
    if (type === "frontend") {
      entry = basConfig.entry || "dist";
    } else {
      // Intelligently resolve the entry file for backend by checking what actually exists
      if (basConfig.entry && fs.existsSync(path.join(fullPath, basConfig.entry))) {
        entry = basConfig.entry;
      } else if (pkgData.main && fs.existsSync(path.join(fullPath, pkgData.main))) {
        entry = pkgData.main;
      } else {
        // Look for common entry files that physically exist
        const commonEntries = ["index.js", "server.js", "app.js", "index.ts", "server.ts", "app.ts"];
        const foundEntry = commonEntries.find((cand) => fs.existsSync(path.join(fullPath, cand)));
        if (foundEntry) {
          entry = foundEntry;
        } else {
          // Absolute fallback if nothing physically exists yet
          entry = basConfig.entry || pkgData.main || "server.js";
        }
      }
    }

    const autoStart = basConfig.autoStart !== undefined ? basConfig.autoStart : true;
    const gitUrl: string | undefined = basConfig.gitUrl || undefined;
    const gitBranch: string | undefined = basConfig.gitBranch || undefined;
    const start = typeof basConfig.start === "string" && basConfig.start.trim() ? basConfig.start.trim() : undefined;
    const build = typeof basConfig.build === "string" && basConfig.build.trim() ? basConfig.build.trim() : undefined;
    const env =
      basConfig.env && typeof basConfig.env === "object"
        ? Object.fromEntries(Object.entries(basConfig.env).map(([k, v]) => [k, String(v)]))
        : undefined;
    const stopTimeout = Number(basConfig.stopTimeout) > 0 ? Number(basConfig.stopTimeout) : undefined;

    // Check if app is already registered in config
    let existingApp = config.apps.find((app) => app.path === relativePath);

    if (!existingApp) {
      // Find an available port starting from 8080
      let port = basConfig.port;
      if (!port) {
        const usedPorts = new Set(config.apps.map((app) => app.port));
        let candidatePort = 8080;
        while (usedPorts.has(candidatePort)) {
          candidatePort++;
        }
        port = candidatePort;
      }

      const newApp: AppConfig = {
        id,
        name,
        version,
        path: relativePath,
        type,
        entry,
        port,
        autoStart,
        groups,
        gitUrl,
        gitBranch,
        start,
        build,
        env,
        stopTimeout
      };

      config.apps.push(newApp);
      configChanged = true;
      console.log(`[Orchestrator] Auto-detected new application in ${relativePath}:`, newApp);

      // Register in state map
      if (!appStates.has(id)) {
        appStates.set(id, createAppState(newApp));

        if (newApp.autoStart) {
          // Delay start slightly to prevent process racing on initial boot
          setTimeout(() => startApp(id), 100);
        }
      }
    } else {
      // Update config.json if there are edits inside package.json orchestrator config
      let changed = false;
      if (existingApp.id !== id) {
        // Change of ID can happen if name inside package.json changed
        const oldId = existingApp.id;
        existingApp.id = id;
        changed = true;
        
        // Transfer process state
        const oldState = appStates.get(oldId);
        if (oldState) {
          appStates.delete(oldId);
          appStates.set(id, oldState);
        }
      }
      if (existingApp.name !== name) {
        existingApp.name = name;
        changed = true;
      }
      if (existingApp.version !== version) {
        existingApp.version = version;
        changed = true;
      }
      if (existingApp.type !== type) {
        existingApp.type = type;
        changed = true;
      }
      if (existingApp.entry !== entry) {
        existingApp.entry = entry;
        changed = true;
      }
      if (basConfig.port && existingApp.port !== basConfig.port) {
        existingApp.port = basConfig.port;
        changed = true;
      }
      if (existingApp.autoStart !== autoStart) {
        existingApp.autoStart = autoStart;
        changed = true;
      }
      if (JSON.stringify(existingApp.groups || []) !== JSON.stringify(groups)) {
        existingApp.groups = groups;
        changed = true;
      }
      if (existingApp.gitUrl !== gitUrl || existingApp.gitBranch !== gitBranch) {
        existingApp.gitUrl = gitUrl;
        existingApp.gitBranch = gitBranch;
        changed = true;
      }
      const runSpec = (a: Partial<AppConfig>) => JSON.stringify([a.start, a.build, a.env, a.stopTimeout]);
      if (runSpec(existingApp) !== runSpec({ start, build, env, stopTimeout })) {
        existingApp.start = start;
        existingApp.build = build;
        existingApp.env = env;
        existingApp.stopTimeout = stopTimeout;
        changed = true;
      }

      const state = appStates.get(id);
      if (state) {
        state.config = { ...existingApp };
      } else {
        // Happens when folders that previously shared one id (same package.json name) are given their own ids
        appStates.set(id, createAppState({ ...existingApp }));
        if (existingApp.autoStart) {
          setTimeout(() => startApp(id), 100);
        }
      }

      if (changed) {
        configChanged = true;
      }
    }
  });

  // Check if any registered app folder has been deleted
  config.apps = config.apps.filter((app) => {
    const keep = existingAppPaths.has(app.path);
    if (!keep) {
      console.log(`[Orchestrator] Directory removed. Unregistering app: ${app.name} (${app.id})`);
      stopApp(app.id);
      appStates.delete(app.id);
      configChanged = true;
    }
    return keep;
  });

  if (configChanged) {
    saveConfig();
  }
}

// Automatically scan all sub-apps' package.json files, merge missing dependencies into root package.json and run npm install
function autoSyncDependencies() {
  // BAS_AUTO_SYNC_DEPENDENCIES=false: don't install the apps' dependencies into BAS's own folder on start
  if (process.env.BAS_AUTO_SYNC_DEPENDENCIES === "false") return;
  const appsDir = path.resolve(process.cwd(), "apps");
  if (!fs.existsSync(appsDir)) return;

  const subdirs = fs.readdirSync(appsDir);
  const subDeps: Record<string, string> = {};

  subdirs.forEach((dir) => {
    const pkgPath = path.join(appsDir, dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkgData = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const deps = pkgData.dependencies || {};
        Object.keys(deps).forEach((depName) => {
          subDeps[depName] = deps[depName];
        });
      } catch (e) {
        console.error(`[Orchestrator] Error reading package.json for ${dir}:`, e);
      }
    }
  });

  const rootPkgPath = path.resolve(process.cwd(), "package.json");
  if (!fs.existsSync(rootPkgPath)) return;

  try {
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
    if (!rootPkg.dependencies) {
      rootPkg.dependencies = {};
    }

    let changed = false;
    Object.keys(subDeps).forEach((depName) => {
      // If the dependency is completely missing from root, or version doesn't match
      if (!rootPkg.dependencies[depName]) {
        rootPkg.dependencies[depName] = subDeps[depName];
        changed = true;
        console.log(`[Orchestrator Sync] Found missing global dependency from apps: ${depName}@${subDeps[depName]}`);
      }
    });

    if (changed) {
      fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2), "utf-8");
      console.log("[Orchestrator Sync] Root package.json updated with new sub-app dependencies. Triggering npm install...");
      
      // Execute npm install asynchronously in the background so it doesn't block the Orchestrator startup
      exec("npm install", { env: childEnv() }, (err, stdout, stderr) => {
        if (err) {
          console.error(`[Orchestrator Sync] npm install failed: ${err.message}`);
          return;
        }
        console.log("[Orchestrator Sync] npm install completed successfully. Global node_modules updated!");
      });
    } else {
      console.log("[Orchestrator Sync] All sub-app dependencies are already present in global root. No install needed.");
    }
  } catch (err: any) {
    console.error(`[Orchestrator Sync] Error syncing dependencies: ${err.message}`);
  }
}

// Initialize Orchestrator and Apps State
function initOrchestrator() {
  loadConfig();

  // Populate state maps with loaded configuration first
  config.apps.forEach((app) => {
    appStates.set(app.id, createAppState(app));
  });

  // Scan physical directory to discover new apps / remove deleted ones
  scanAppsDirectory();

  // Automatically sync missing dependencies into root node_modules
  autoSyncDependencies();

  // Start autoStart apps
  appStates.forEach((state, id) => {
    if (state.config.autoStart && state.status !== "RUNNING" && state.status !== "STARTING") {
      startApp(id);
    }
  });

  // Start periodic monitor and metric updater
  setInterval(() => {
    const running: AppRuntimeState[] = [];
    appStates.forEach((state) => {
      if (state.status === "RUNNING") {
        state.uptime += 1;
        if (state.config.type === "backend" && state.pid) {
          running.push(state);
        } else {
          // Frontend static server (in-process) metrics simulation
          state.cpu = parseFloat((0.1 + Math.random() * 0.3).toFixed(1));
          state.memory = parseFloat((12 + Math.random() * 2).toFixed(1));
        }
      } else {
        state.cpu = 0;
        state.memory = 0;
      }
    });

    // Real CPU & memory per app, summed over its whole process group
    // (an app may be a shell plus the program it started).
    if (running.length > 0) {
      exec("ps -A -o pgid=,pcpu=,rss=", (err, stdout) => {
        const totals = new Map<number, { cpu: number; rss: number }>();
        if (!err && stdout) {
          for (const line of stdout.trim().split("\n")) {
            const [pgid, cpu, rss] = line.trim().split(/\s+/).map(Number);
            if (isNaN(pgid)) continue;
            const t = totals.get(pgid) || { cpu: 0, rss: 0 };
            t.cpu += isNaN(cpu) ? 0 : cpu;
            t.rss += isNaN(rss) ? 0 : rss;
            totals.set(pgid, t);
          }
        }
        for (const state of running) {
          const t = state.pid ? totals.get(state.pid) : undefined;
          if (t) {
            state.cpu = parseFloat(t.cpu.toFixed(1));
            state.memory = parseFloat((t.rss / 1024).toFixed(1)); // KB -> MB
          } else {
            // Graceful fallback to realistic simulation if ps is unavailable or fails
            state.cpu = parseFloat((0.5 + Math.random() * 2.0).toFixed(1));
            state.memory = parseFloat((25 + Math.random() * 5).toFixed(1));
          }
        }
      });
    }

    // Update system CPU ticks
    sampleCpuTicks();
  }, 1000);

  // Apps run in their own process groups, so stop them ourselves when BAS exits.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Orchestrator] ${signal} received, stopping all apps...`);
    await Promise.all(Array.from(appStates.keys()).map((id) => stopApp(id, `BAS is shutting down (${signal}).`)));
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Helper to resolve the main server port dynamically from environment variables, .env, or .env.example
function resolveServerPort(): number {
  // 1. Try process.env.PORT
  if (process.env.PORT && !isNaN(Number(process.env.PORT))) {
    return Number(process.env.PORT);
  }

  // 2. Try parsing .env file
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      const match = content.match(/^PORT\s*=\s*(\d+)/m);
      if (match && match[1]) {
        return Number(match[1]);
      }
    } catch (e) {
      console.error("[Orchestrator] Error reading .env file:", e);
    }
  }

  // 3. Try parsing .env.example file
  const envExamplePath = path.resolve(process.cwd(), ".env.example");
  if (fs.existsSync(envExamplePath)) {
    try {
      const content = fs.readFileSync(envExamplePath, "utf-8");
      const match = content.match(/^PORT\s*=\s*(\d+)/m);
      if (match && match[1]) {
        return Number(match[1]);
      }
    } catch (e) {
      console.error("[Orchestrator] Error reading .env.example file:", e);
    }
  }

  // 4. Default to 3000
  return 3000;
}

// Helper to resolve the Admin credentials dynamically from environment variables or .env
function resolveAdminCredentials(): { username?: string; password?: string } {
  let username = process.env.ADMIN_USERNAME || "admin";
  let password = process.env.ADMIN_PASSWORD;

  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      
      const userMatch = content.match(/^ADMIN_USERNAME\s*=\s*(.*)$/m);
      if (userMatch) {
        username = userMatch[1].trim().replace(/^['"]|['"]$/g, "");
      }
      
      const passMatch = content.match(/^ADMIN_PASSWORD\s*=\s*(.*)$/m);
      if (passMatch) {
        password = passMatch[1].trim().replace(/^['"]|['"]$/g, "");
      }
    } catch (e) {
      console.error("[Orchestrator] Error reading .env file for Admin credentials:", e);
    }
  }

  if (!username) {
    username = "admin";
  }

  if (!password || password === "none" || password === "false") {
    password = undefined; // never fall back to a default password; see ensureAdminPassword()
  }

  return { username, password };
}

// The panel must never run with a default password: on a start without ADMIN_PASSWORD, generate one into .env
function ensureAdminPassword() {
  if (resolveAdminCredentials().password) return;

  const envPath = path.resolve(process.cwd(), ".env");
  const line = `ADMIN_PASSWORD=${crypto.randomBytes(18).toString("base64url")}`;
  try {
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
    const updated = /^ADMIN_PASSWORD\s*=.*$/m.test(content)
      ? content.replace(/^ADMIN_PASSWORD\s*=.*$/m, line)
      : `${content}${content && !content.endsWith("\n") ? "\n" : ""}${line}\n`;
    fs.writeFileSync(envPath, updated, { encoding: "utf-8", mode: 0o600 });
    console.warn(`[Security] ADMIN_PASSWORD was not set. A random password was generated and saved as ADMIN_PASSWORD in ${envPath}`);
  } catch (e: any) {
    console.error(`[Security] ADMIN_PASSWORD is not set and could not be written to ${envPath} (${e.message}). The panel stays locked until it is set.`);
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Constant-time string comparison
function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

// Admin sessions: a random token in an HttpOnly cookie, kept in memory (a BAS restart signs everyone out)
const SESSION_COOKIE = "bas_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map<string, { credKey: string; expiresAt: number }>();

function createSession(credKey: string): string {
  const now = Date.now();
  sessions.forEach((session, token) => {
    if (session.expiresAt < now) sessions.delete(token);
  });
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { credKey, expiresAt: now + SESSION_TTL_MS });
  return token;
}

// A session ends when it expires or when the admin username/password changes
function isValidSession(token: string | null, credKey: string): boolean {
  const session = token ? sessions.get(token) : undefined;
  return !!session && session.expiresAt > Date.now() && session.credKey === credKey;
}

// BAS_TRUST_PROXY: which proxies may report the client address via X-Forwarded-For (express "trust proxy").
// The default only trusts a proxy on this machine, so a client connecting directly can't fake its address.
function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value) return "loopback";
  if (value === "true" || value === "false") return value === "true";
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

// Blocks state-changing requests that a browser sends on behalf of another site (CSRF)
function isCrossSiteRequest(req: express.Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return false;
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite) return fetchSite !== "same-origin" && fetchSite !== "none";
  // Older browsers: compare Origin with the host the panel is served on; no Origin means not a browser
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== (req.headers["x-forwarded-host"] || req.headers.host);
  } catch (e) {
    return true;
  }
}

// The built panel's server bundle is written next to its assets in dist/ and must not be downloadable
const SERVER_BUNDLE_PATHS = ["/server.cjs", "/server.cjs.map"];

// What the login screen needs before a session exists. In development Vite serves the whole project
// folder (apps/, config.json, sources), so only the panel's own modules and public files are public.
const PUBLIC_PAGE_PATHS = ["/", "/index.html", "/docs", "/docs.html"];
const DEV_PUBLIC_PREFIXES = ["/src/", "/@vite/", "/@react-refresh", "/@id/", "/node_modules/", "/@vite-plugin-pwa/"];
let devPublicFiles: Set<string> | null = null;

function isPublicAsset(urlPath: string): boolean {
  if (PUBLIC_PAGE_PATHS.includes(urlPath)) return true;
  if (SERVER_BUNDLE_PATHS.includes(urlPath)) return false;
  // Production serves only the built panel from dist/
  if (isProduction) return true;
  if (DEV_PUBLIC_PREFIXES.some((prefix) => urlPath.startsWith(prefix))) return true;
  if (!devPublicFiles) {
    devPublicFiles = new Set(["/manifest.webmanifest", "/registerSW.js", "/dev-sw.js"]);
    try {
      fs.readdirSync(path.resolve(process.cwd(), "public")).forEach((file) => devPublicFiles!.add(`/${file}`));
    } catch (e) {}
  }
  return devPublicFiles.has(urlPath);
}

// Simple cookie parser helper
function getCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";");
  for (let i = 0; i < cookies.length; i++) {
    const cookie = cookies[i].trim();
    if (cookie.startsWith(name + "=")) {
      try {
        return decodeURIComponent(cookie.substring(name.length + 1));
      } catch (e) {
        return null;
      }
    }
  }
  return null;
}

// Mask credentials in log lines before they leave the server (AI diagnosis)
function redactSecrets(text: string): string {
  return text
    .replace(/(\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, "$1 [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1[REDACTED]");
}

// Run full-stack Server
async function startServer() {
  const app = express();
  // Client addresses come from req.ip; see parseTrustProxy() for which proxies are believed
  app.set("trust proxy", parseTrustProxy(process.env.BAS_TRUST_PROXY));
  const PORT = resolveServerPort();
  ensureAdminPassword();

  app.use(helmet({
    // Production only: Vite's dev server injects inline scripts and styles
    contentSecurityPolicy: isProduction ? {
      useDefaults: true,
      directives: {
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "blob:"],
        "frame-ancestors": ["'self'"],
        // The panel is often reached over plain http://ip:port; upgrading its requests would break it
        "upgrade-insecure-requests": null
      }
    } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
  }));
  app.use(express.json());

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10000, // accommodate 1.5s live dashboard polling
    message: { error: "Too many requests from this IP" },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api/", apiLimiter);

  // Security Middleware: admin session or API key, banned IPs, IP whitelist, CSRF
  app.use((req, res, next) => {
    const clientIP = normalizeIp(req.ip || req.socket.remoteAddress || "unknown");
    
    const banExpiry = bannedIPs.get(clientIP);
    if (banExpiry) {
      if (Date.now() > banExpiry) {
        bannedIPs.delete(clientIP);
      } else {
        return res.status(403).json({ error: "Your IP is banned due to too many failed attempts." });
      }
    }

    const allowedIPsStr = process.env.ALLOWED_IPS;
    if (allowedIPsStr && allowedIPsStr.trim() !== "") {
      const allowedIPs = allowedIPsStr.split(",").map(i => i.trim());
      if (allowedIPs.length > 0 && !allowedIPs.includes(clientIP)) {
        logAccess(clientIP, "Blocked by IP Whitelist", false);
        return res.status(403).json({ error: "Access denied from this IP" });
      }
    }

    const { username, password } = resolveAdminCredentials();
    if (!username || !password) {
      // Fail closed: see ensureAdminPassword()
      return res.status(503).json({ error: "ADMIN_PASSWORD is not configured on the server." });
    }
    const credKey = sha256(`${username}\n${password}`);
    const sessionToken = getCookie(req.headers.cookie, SESSION_COOKIE);

    if (req.path === "/api/auth/login" && req.method === "POST") {
      const { username: reqUser, password: reqPass } = req.body || {};

      if (typeof reqUser === "string" && typeof reqPass === "string" && safeEqual(reqUser, username) && safeEqual(reqPass, password)) {
        failedAttempts.delete(clientIP);
        logAccess(clientIP, "Successful Login via UI", true);
        res.cookie(SESSION_COOKIE, createSession(credKey), {
          path: "/",
          maxAge: SESSION_TTL_MS,
          httpOnly: true,
          sameSite: "strict",
          secure: req.secure
        });
        return res.json({ success: true });
      } else {
        handleFailedAttempt(clientIP);
        return res.status(401).json({ error: "Invalid credentials" });
      }
    }

    if (req.path === "/api/auth/logout" && req.method === "POST") {
      if (sessionToken) sessions.delete(sessionToken);
      res.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "strict", secure: req.secure });
      return res.json({ success: true });
    }

    // API key for scripts: base64("username:password") in x-api-key or an Authorization header
    const headerKey = (req.headers["x-api-key"] as string | undefined) || req.headers["authorization"]?.replace(/^(Bearer|Basic) /, "");
    const apiKeyValid = !!headerKey && safeEqual(headerKey, Buffer.from(`${username}:${password}`).toString("base64"));

    if (apiKeyValid || isValidSession(sessionToken, credKey)) {
      if (apiKeyValid) {
        failedAttempts.delete(clientIP);
      }
      if (isCrossSiteRequest(req)) {
        logAccess(clientIP, `Blocked cross-site ${req.method} ${req.path}`, false);
        return res.status(403).json({ error: "Cross-site request blocked" });
      }
      return next();
    }

    // A wrong API key counts as a failed sign-in (an expired session cookie does not)
    if (headerKey) {
      handleFailedAttempt(clientIP, headerKey);
    }

    // For API requests, return 401 Unauthorized
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Unauthorized: Invalid or missing API Key" });
    }

    // For main page / document routes, redirect to custom URL immediately instead of showing lock screen if configured
    const redirectUrl = process.env.UNAUTHORIZED_REDIRECT_URL;
    if (redirectUrl) {
      const pagePaths = ["/", "/index.html", "/docs", "/docs.html"];
      if (pagePaths.includes(req.path) || req.path === "") {
        return res.redirect(redirectUrl);
      }
    }

    // Let the login screen and its assets load; nothing else is served without a session
    if (isPublicAsset(req.path)) {
      return next();
    }
    res.status(404).send("Not Found");
  });

  // Initialize Orchestrator core
  initOrchestrator();

  // API: Get App States
  app.get("/api/apps", (req, res) => {
    // Scan directory on demand to live-sync any newly created folder under apps/*
    scanAppsDirectory();

    const appsList = Array.from(appStates.values()).map((state) => ({
      id: state.config.id,
      name: state.config.name,
      version: state.config.version,
      path: state.config.path,
      type: state.config.type,
      entry: state.config.entry,
      start: state.config.start,
      build: state.config.build,
      port: state.config.port,
      autoStart: state.config.autoStart,
      groups: state.config.groups,
      alertEnabled: state.config.alertEnabled,
      alertThreshold: state.config.alertThreshold,
      status: state.status,
      pid: state.pid,
      restarts: state.restarts,
      crashCount: state.crashCount,
      cpu: state.cpu,
      memory: state.memory,
      uptime: state.uptime,
      lastCrashTime: state.lastCrashTime,
      logCount: state.logs.length
    }));

    const detailedMem = getDetailedMemory();
    const coreMetrics = cachedCoresMetric.length > 0 ? cachedCoresMetric : sampleCpuTicks();
    const totalHostCpu = coreMetrics.length > 0
      ? parseFloat((coreMetrics.reduce((acc, c) => acc + c.usage, 0) / coreMetrics.length).toFixed(1))
      : parseFloat(Array.from(appStates.values()).reduce((acc, s) => acc + s.cpu, 0).toFixed(1));

    const appsCpuTotal = parseFloat(Array.from(appStates.values()).reduce((acc, s) => acc + s.cpu, 0).toFixed(1));
    const appsMemoryTotal = parseFloat(Array.from(appStates.values()).reduce((acc, s) => acc + s.memory, 0).toFixed(1));

    const cpusInfo = os.cpus() || [];
    const cpuModel = cpusInfo[0]?.model || "x86_64 Processor";
    const cpuSpeedMhz = cpusInfo[0]?.speed || 0;
    const coresCount = cpusInfo.length || 1;
    const loadAvg = (os.loadavg() || [0, 0, 0]).map((v) => parseFloat(v.toFixed(2)));

    res.json({
      apps: appsList,
      settings: config.settings,
      smsGateway: config.smsGateway,
      systemMetrics: {
        totalCpu: totalHostCpu,
        totalMemory: detailedMem.usedMb,
        memory: detailedMem,
        coresCount,
        cpuModel,
        cpuSpeedMhz,
        cores: coreMetrics,
        loadAvg,
        hostname: os.hostname(),
        platform: process.platform,
        arch: os.arch(),
        kernel: `${os.type()} ${os.release()}`,
        serverUptime: Math.floor(os.uptime()),
        processUptime: Math.floor(process.uptime()),
        nodeVersion: process.version,
        appsCpuTotal,
        appsMemoryTotal
      }
    });
  });

  // API: Get Security Logs
  app.get("/api/security-logs", (req, res) => {
    const banned = Array.from(bannedIPs.entries()).map(([ip, expiry]) => ({
      ip,
      expiry,
      expired: Date.now() > expiry
    }));
    res.json({ logs: accessLogs, bannedIPs: banned });
  });

  // API: Unban IP
  app.post("/api/security/unban", express.json(), (req, res) => {
    const { ip } = req.body;
    if (!ip) {
      res.status(400).json({ error: "IP is required" });
      return;
    }
    if (bannedIPs.has(ip)) {
      bannedIPs.delete(ip);
      // Remove failed attempts so they don't get banned immediately again
      failedAttempts.delete(ip);
      res.json({ success: true, message: `IP ${ip} unbanned successfully` });
    } else {
      res.status(404).json({ error: "IP not found in ban list" });
    }
  });

  // API: Get Git Update Logs and status
  // (registered before the /api/apps/:id/... routes, otherwise "git-update" is taken as an app id)
  app.get("/api/apps/git-update/logs", (req, res) => {
    res.json({
      logs: gitUpdateLogs,
      running: gitUpdateRunning,
      progress: gitUpdateProgress,
      authRequired: gitAuthRequired
    });
  });

  // API: Clear Git Update Logs
  app.post("/api/apps/git-update/clear", (req, res) => {
    gitUpdateLogs = [];
    gitAuthRequired = false;
    res.json({ success: true });
  });

  // API: Get Single App Details & Logs
  app.get("/api/apps/:id/logs", (req, res) => {
    const { id } = req.params;
    const state = appStates.get(id);
    if (!state) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    res.json({ logs: state.logs });
  });

  // API: Clear App Logs
  app.post("/api/apps/:id/logs/clear", (req, res) => {
    const { id } = req.params;
    const state = appStates.get(id);
    if (!state) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    state.logs = [`[${new Date().toISOString()}] [SYSTEM] Logs cleared by user.`];
    res.json({ status: "success" });
  });

  // API: Update App Config
  app.post("/api/apps/:id/config", (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    const state = appStates.get(id);

    if (!state) {
      res.status(404).json({ error: "App not found" });
      return;
    }

    // Update in memory runtime state
    state.config = { ...state.config, ...updates };
    
    // Update in config.json array
    const configAppIndex = config.apps.findIndex(a => a.id === id);
    if (configAppIndex > -1) {
      config.apps[configAppIndex] = { ...config.apps[configAppIndex], ...updates };
      saveConfig();
    }

    res.json({ status: "success", config: state.config });
  });

  // API: Process Actions (start, stop, restart)
  app.post("/api/apps/:id/action", (req, res) => {
    const { id } = req.params;
    const { action } = req.body;
    const state = appStates.get(id);

    if (!state) {
      res.status(404).json({ error: "App not found" });
      return;
    }

    if (action === "start") {
      startApp(id);
    } else if (action === "stop") {
      stopApp(id);
    } else if (action === "restart") {
      restartApp(id);
    } else {
      res.status(400).json({ error: "Invalid action" });
      return;
    }

    res.json({ status: "success", appStatus: state.status });
  });

  // API: Simulate App Crash
  app.post("/api/apps/:id/simulate-crash", (req, res) => {
    const { id } = req.params;
    const state = appStates.get(id);

    if (!state) {
      res.status(404).json({ error: "App not found" });
      return;
    }

    if (state.status !== "RUNNING") {
      res.status(400).json({ error: "App must be running to crash it" });
      return;
    }

    const ok = simulateAppCrash(id);
    if (ok) {
      res.json({ status: "success", message: "Process crash simulated successfully. Orchestrator recovery initiated." });
    } else {
      res.status(500).json({ error: "Failed to trigger crash simulation" });
    }
  });

  // API: Get Orchestrator Configuration
  app.get("/api/config", (req, res) => {
    res.json(config);
  });

  // API: Update Orchestrator Settings
  app.post("/api/config", (req, res) => {
    const { settings, smsGateway } = req.body;
    
    if (settings) {
      config.settings = { ...config.settings, ...settings };
    }
    if (smsGateway) {
      config.smsGateway = { ...config.smsGateway, ...smsGateway };
    }

    saveConfig();
    res.json({ status: "success", config });
  });

  // API: Dependency Merger
  app.post("/api/apps/merge-dependencies", async (req, res) => {
    const { apply } = req.body;
    const appsDir = path.resolve(process.cwd(), "apps");
    const mergedDeps: Record<string, string> = {};

    try {
      if (!fs.existsSync(appsDir)) {
        res.status(400).json({ error: "Apps directory not found." });
        return;
      }

      const subdirs = fs.readdirSync(appsDir);
      const scannedApps: any[] = [];

      subdirs.forEach((dir) => {
        const pkgPath = path.join(appsDir, dir, "package.json");
        if (fs.existsSync(pkgPath)) {
          try {
            const pkgData = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
            const deps = pkgData.dependencies || {};
            scannedApps.push({
              name: pkgData.name,
              path: path.join("apps", dir),
              dependencies: deps
            });

            Object.keys(deps).forEach((depName) => {
              // Store dependency version. If collision, keep latest version or let user inspect.
              mergedDeps[depName] = deps[depName];
            });
          } catch (e) {}
        }
      });

      // Apply changes to main package.json if requested
      if (apply) {
        const rootPkgPath = path.resolve(process.cwd(), "package.json");
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
        
        rootPkg.dependencies = {
          ...rootPkg.dependencies,
          ...mergedDeps
        };

        fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2), "utf-8");
        
        console.log("[Orchestrator Merger] Dependencies updated in package.json. Running npm install to update global node_modules...");
        
        // Wait for npm install to complete
        await new Promise<void>((resolve, reject) => {
          exec("npm install", { env: childEnv() }, (err, stdout, stderr) => {
            if (err) {
              console.error(`[Orchestrator Merger] npm install failed: ${err.message}`);
              reject(new Error(`npm install execution failed: ${err.message}`));
            } else {
              console.log("[Orchestrator Merger] npm install completed successfully.");
              resolve();
            }
          });
        });

        res.json({
          status: "success",
          message: "✓ پکیج‌ها با موفقیت در روت اصلی ادغام و با موفقیت نصب شدند!",
          mergedDependencies: mergedDeps,
          scannedApps
        });
      } else {
        res.json({
          status: "success",
          mergedDependencies: mergedDeps,
          scannedApps
        });
      }

    } catch (err: any) {
      res.status(500).json({ error: `Dependency merge failed: ${err.message}` });
    }
  });

  // Helper: Run command with live line-by-line output streaming
  function streamProcess(
    cmd: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    onLine: (line: string, type: "cmd" | "stdout" | "stderr" | "error" | "info" | "success") => void,
    timeoutMs = 180000
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      // Safely mask any passwords from displayed command line
      const displayArgs = args.map((arg) => {
        if (arg.includes("password=")) {
          return arg.replace(/password=([^;"'\s]+)/g, "password=******");
        }
        return arg;
      });

      onLine(`$ ${cmd} ${displayArgs.join(" ")}`, "cmd");

      let stdoutAcc = "";
      let stderrAcc = "";
      let stdoutBuffer = "";
      let stderrBuffer = "";

      let child: ChildProcess;
      try {
        child = spawn(cmd, args, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          // Own process group, so a timeout also kills what the command started (e.g. vite under npm run build)
          detached: process.platform !== "win32"
        });
      } catch (err: any) {
        onLine(`[SPAWN_ERROR] Failed to start ${cmd}: ${err.message}`, "error");
        resolve({ code: 1, stdout: "", stderr: err.message });
        return;
      }

      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          stdoutAcc += text;
          stdoutBuffer += text;
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() || "";
          for (const line of lines) {
            if (line.trim()) onLine(line, "stdout");
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          stderrAcc += text;
          stderrBuffer += text;
          const lines = stderrBuffer.split(/\r?\n/);
          stderrBuffer = lines.pop() || "";
          for (const line of lines) {
            if (line.trim()) onLine(line, "stderr");
          }
        });
      }

      const timer = setTimeout(() => {
        onLine(`[TIMEOUT] Process ${cmd} exceeded timeout limit (${Math.round(timeoutMs / 1000)}s). Terminating...`, "error");
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch (e) {}
        resolve({ code: -1, stdout: stdoutAcc, stderr: stderrAcc + "\nProcess timed out" });
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (stdoutBuffer.trim()) onLine(stdoutBuffer, "stdout");
        if (stderrBuffer.trim()) onLine(stderrBuffer, "stderr");
        resolve({ code: code ?? 0, stdout: stdoutAcc, stderr: stderrAcc });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        onLine(`[ERROR] Process error: ${err.message}`, "error");
        resolve({ code: 1, stdout: stdoutAcc, stderr: stderrAcc + `\n${err.message}` });
      });
    });
  }

  // API: Git Batch Updater with Authentication & Live Terminal Streaming
  app.post("/api/apps/git-update", (req, res) => {
    const { 
      targetType = "all", 
      targetValue = "", 
      keyword = "", 
      username = "", 
      password = "", 
      branch = "", 
      gitUrl = "",
      appIds = [],
      forceClean = true,
      autoInstall = true,
      autoBuild = true
    } = req.body;

    if (gitUpdateRunning) {
      res.status(400).json({ error: "یک فرآیند بروزرسانی گیت در حال اجراست. لطفاً تا پایان آن منتظر بمانید." });
      return;
    }

    const pushGitLog = (text: string, type: "cmd" | "stdout" | "stderr" | "error" | "info" | "success" | "auth" = "info") => {
      const now = new Date();
      const timeStr = now.toLocaleTimeString("fa-IR", { hour12: false });
      const tag = type.toUpperCase();
      gitUpdateLogs.push(`[${timeStr}] [${tag}] ${text}`);
      if (gitUpdateLogs.length > 1000) {
        gitUpdateLogs.shift();
      }
    };

    gitUpdateLogs = [];
    gitAuthRequired = false;
    gitUpdateRunning = true;
    gitUpdateProgress = 5;

    pushGitLog(`شروع فرآیند واکشی و به‌روزرسانی گیت (Target: ${targetType}${targetValue ? ` - ${targetValue}` : ""})`, "info");
    if (username) {
      pushGitLog(`احراز هویت گیت با نام کاربری: ${username} فعال شد.`, "info");
    }

    res.json({ status: "success", message: "فرآیند همگام‌سازی و بروزرسانی گیت آغاز گردید." });

    (async () => {
      try {
        const appsDir = path.resolve(process.cwd(), "apps");
        if (!fs.existsSync(appsDir)) {
          try {
            fs.mkdirSync(appsDir, { recursive: true });
          } catch (e) {}
        }

        // Re-scan directory to ensure newest state
        scanAppsDirectory();

        // Detect matching applications based on target criteria
        const matchingApps: AppRuntimeState[] = [];
        const tVal = (targetValue || keyword || "").trim().toLowerCase();

        const requestedIds: string[] = Array.isArray(appIds) ? appIds : [];

        appStates.forEach((state) => {
          if (requestedIds.length > 0) {
            // Exactly the services shown in the panel's preview
            if (requestedIds.includes(state.config.id)) matchingApps.push(state);
          } else if (targetType === "all") {
            matchingApps.push(state);
          } else if (targetType === "group") {
            const hasGroup = state.config.groups && Array.isArray(state.config.groups) &&
              state.config.groups.some(g => g.toLowerCase() === tVal || g.toLowerCase().includes(tVal));
            if (hasGroup) matchingApps.push(state);
          } else if (targetType === "service") {
            const isId = state.config.id.toLowerCase() === tVal;
            const isName = state.config.name.toLowerCase() === tVal || state.config.name.toLowerCase().includes(tVal);
            const isPath = state.config.path.toLowerCase().includes(tVal);
            if (isId || isName || isPath) matchingApps.push(state);
          } else {
            // Fallback keyword search
            const nameMatches = state.config.name.toLowerCase().includes(tVal);
            const idMatches = state.config.id.toLowerCase().includes(tVal);
            const groupMatches = state.config.groups && state.config.groups.some(g => g.toLowerCase().includes(tVal));
            if (nameMatches || idMatches || groupMatches || tVal === "") {
              matchingApps.push(state);
            }
          }
        });

        if (matchingApps.length === 0) {
          pushGitLog(`هیچ سرویس فعالی مطابق با فیلتر مشخص شده (${targetType}: ${tVal || "خالی"}) یافت نشد.`, "error");
          pushGitLog(`راهنما: بررسی کنید که پوشه سرویس در مسیر apps/ موجود باشد یا نام و گروه آن درست انتخاب شده باشد.`, "info");
          gitUpdateProgress = 100;
          gitUpdateRunning = false;
          return;
        }

        pushGitLog(`تعداد ${matchingApps.length} سرویس جهت همگام‌سازی شناسایی شد: [${matchingApps.map(a => a.config.name).join(", ")}]`, "info");

        // Prepare Git authentication parameters
        const gitEnv: NodeJS.ProcessEnv = {
          ...childEnv(),
          GIT_TERMINAL_PROMPT: "0",
          // Empty rather than "echo": git then fails with a clear error instead of sending the prompt text as credentials
          GIT_ASKPASS: "",
          LC_ALL: "C"
        };

        // Extra arguments for the commands that talk to the remote
        const authArgs: string[] = [];
        if (username && password) {
          // Credentials reach the helper through env vars, so characters like $ " ` \ in the password are never
          // interpreted by the shell. The empty helper entry drops system/global helpers, so a stale stored password
          // can't take precedence and the panel's password is never written to ~/.git-credentials.
          gitEnv.BAS_GIT_USERNAME = username;
          gitEnv.BAS_GIT_PASSWORD = password;
          authArgs.push(
            "-c",
            "credential.helper=",
            "-c",
            `credential.helper=!f() { test "$1" = get || exit 0; printf '%s\\n' "username=$BAS_GIT_USERNAME" "password=$BAS_GIT_PASSWORD"; }; f`
          );
        }

        const isAuthError = (text: string) => {
          return /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Invalid username or password|HTTP Basic: Access denied|Invalid credentials|returned error: 40[13]|HTTP 40[13]|Permission denied \(publickey/i.test(text);
        };

        const reportGitFailure = (step: string, result: { code: number; stdout: string; stderr: string }) => {
          if (isAuthError(result.stderr + result.stdout)) {
            gitAuthRequired = true;
            pushGitLog(`⚠️ [خطای احراز هویت]: مخزن نیازمند نام کاربری و رمز عبور یا Personal Access Token (PAT) است، یا مقدار وارد شده اشتباه است.`, "auth");
            pushGitLog(`👉 فیلدهای احراز هویت گیت را در پنل بالا تکمیل کرده و مجدداً بروزرسانی کنید.`, "auth");
          } else {
            pushGitLog(`❌ خطا در اجرای ${step} (کد: ${result.code})`, "error");
          }
        };

        const stepWeight = 90 / matchingApps.length;
        const failedApps: string[] = [];

        for (let i = 0; i < matchingApps.length; i++) {
          const appState = matchingApps[i];
          const fullAppPath = path.resolve(process.cwd(), appState.config.path);
          
          if (!fs.existsSync(fullAppPath)) {
            try {
              fs.mkdirSync(fullAppPath, { recursive: true });
            } catch (e) {}
          }

          pushGitLog(`────────────────────────────────────────────────────────`, "info");
          pushGitLog(`▶ شروع بروزرسانی سرویس: ${appState.config.name} (شناسه: ${appState.config.id})`, "info");
          pushGitLog(`مسیر سرویس در سرور: ${appState.config.path}`, "info");

          // safe.directory: BAS may run as a different OS user than the one who owns the app folder
          const git = (args: string[], onLine: (line: string, type: "cmd" | "stdout" | "stderr" | "error" | "info" | "success") => void = pushGitLog) =>
            streamProcess("git", ["-c", `safe.directory=${fullAppPath}`, ...args], fullAppPath, gitEnv, onLine);
          const quiet = () => {};

          const remoteRepoUrl = gitUrl || appState.config.gitUrl;
          const isGitRepo = fs.existsSync(path.join(fullAppPath, ".git"));

          let updateSucceeded = true;

          if (!isGitRepo && !remoteRepoUrl) {
            pushGitLog(`⚠️ توجه: پوشه این سرویس مخزن گیت (.git) ندارد و آدرس مخزن ریموت ست نشده است.`, "info");
            pushGitLog(`ℹ️ مراحل گیت نادیده گرفته شد؛ بیلد و راه‌اندازی با کدهای موجود ادامه می‌یابد.`, "info");
          } else {
            if (!isGitRepo) {
              // init + fetch instead of clone, so it also works when the folder already holds bas.config.json or .env
              pushGitLog(`پوشه فاقد ریپازیتوری گیت است. در حال ایجاد مخزن و اتصال به ${remoteRepoUrl}...`, "info");
              await git(["init", "-q"]);
              await git(["remote", "add", "origin", remoteRepoUrl]);
            } else if (gitUrl) {
              pushGitLog(`تنظیم آدرس ریموت origin به: ${gitUrl}`, "info");
              await git(["remote", "set-url", "origin", gitUrl]);
            }

            // 1. Git Fetch: the only step that talks to the remote, so credentials are needed only here
            pushGitLog(`در حال واکشی آخرین تغییرات از مخزن ریموت (git fetch)...`, "info");
            const fetchRes = await git([...authArgs, "fetch", "--prune", "origin"]);
            if (fetchRes.code !== 0) {
              updateSucceeded = false;
              reportGitFailure("git fetch", fetchRes);
            }

            // 2. Branch to deploy: panel > gitBranch in bas.config.json > current branch > remote's default branch
            let targetBranch = branch || appState.config.gitBranch || "";
            if (updateSucceeded && !targetBranch) {
              const current = (await git(["symbolic-ref", "--short", "-q", "HEAD"], quiet)).stdout.trim();
              if (current && (await git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${current}`], quiet)).code === 0) {
                targetBranch = current;
              } else {
                await git([...authArgs, "remote", "set-head", "origin", "--auto"], quiet);
                targetBranch = (await git(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], quiet)).stdout.trim().replace(/^origin\//, "");
              }
            }
            if (updateSucceeded && (!targetBranch || (await git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${targetBranch}`], quiet)).code !== 0)) {
              updateSucceeded = false;
              pushGitLog(`❌ شاخه ${targetBranch || "(نامشخص)"} روی مخزن ریموت پیدا نشد. نام شاخه را در پنل یا در فیلد gitBranch فایل bas.config.json مشخص کنید.`, "error");
            }

            // 3. Move the working tree to origin/<branch> (no second network round-trip and no merge, unlike git pull)
            if (updateSucceeded) {
              let applyRes: { code: number; stdout: string; stderr: string };
              if (forceClean) {
                pushGitLog(`همگام‌سازی کامل با origin/${targetBranch} و حذف تغییرات محلی فایل‌های گیت...`, "info");
                // checkout -f discards local edits to tracked files but leaves untracked ones (uploads, .env, ...) alone.
                // Per-deployment files edited locally are restored in case the repository itself tracks them.
                const statusRes = await git(["status", "--porcelain", "--", ...INSTANCE_FILES], quiet);
                const instanceFiles = statusRes.stdout.split("\n")
                  .filter((line) => line.length > 3)
                  .map((line) => path.join(fullAppPath, line.slice(3)))
                  .filter((file) => fs.existsSync(file))
                  .map((file) => ({ file, content: fs.readFileSync(file) }));
                applyRes = await git(["checkout", "-f", "-B", targetBranch, `origin/${targetBranch}`]);
                instanceFiles.forEach(({ file, content }) => fs.writeFileSync(file, content));
              } else {
                pushGitLog(`در حال اعمال تغییرات شاخه ${targetBranch} (fast-forward)...`, "info");
                applyRes = await git(["checkout", targetBranch]);
                if (applyRes.code === 0) {
                  applyRes = await git(["merge", "--ff-only", `origin/${targetBranch}`]);
                }
              }

              if (applyRes.code !== 0) {
                updateSucceeded = false;
                pushGitLog(`❌ اعمال تغییرات شاخه ${targetBranch} ناموفق بود (کد: ${applyRes.code})`, "error");
              } else {
                // Show latest commit summary
                await git(["log", "-1", "--pretty=format:آخرین کامیت: %h - %s (%cr)"], (l) => pushGitLog(l, "success"));
              }
            }
          }

          // If git failed due to authentication or fatal error, skip build for this app
          if (!updateSucceeded) {
            failedApps.push(appState.config.name);
            pushGitLog(`⏭️ رد شدن از بیلد و ری‌استارت ${appState.config.name} به دلیل خطای گیت.`, "error");
            gitUpdateProgress = Math.min(95, Math.round(5 + (i + 1) * stepWeight));
            continue;
          }

          // npm runs package scripts, so it gets neither the git credentials nor BAS's own secrets
          const npmEnv = childEnv();
          const needsBuild = appState.config.type === "frontend" && autoBuild;
          // A service whose dependencies or build failed keeps running its current version
          let readyToRestart = true;

          // 4. Install npm dependencies if package.json exists
          const pkgPath = path.join(fullAppPath, "package.json");
          if (fs.existsSync(pkgPath) && autoInstall) {
            pushGitLog(`در حال بررسی و نصب وابستگی‌های پکیج (npm install)...`, "info");
            // Build tools (vite, ...) are devDependencies, which npm skips when NODE_ENV=production
            const installArgs = ["install", "--prefer-offline", "--no-audit", ...(needsBuild ? ["--include=dev"] : [])];
            const installRes = await streamProcess("npm", installArgs, fullAppPath, npmEnv, pushGitLog, NPM_STEP_TIMEOUT_MS);
            if (installRes.code !== 0) {
              readyToRestart = false;
              pushGitLog(`❌ نصب وابستگی‌ها ناموفق بود (کد: ${installRes.code})`, "error");
            }
          }

          // 5. Build the frontend. Build tools empty the output folder first, so meanwhile the site is served from
          // a copy of the previous build, and that copy is put back if the build fails or times out.
          if (readyToRestart && needsBuild) {
            const buildPath = path.resolve(fullAppPath, appState.config.entry);
            const relBuildPath = path.relative(fullAppPath, buildPath);
            const previousBuild = path.join(path.dirname(buildPath), `.${path.basename(buildPath)}.bas-previous`);
            let hasPreviousBuild = false;
            if (relBuildPath && !relBuildPath.startsWith("..") && !path.isAbsolute(relBuildPath) && fs.existsSync(buildPath)) {
              try {
                fs.rmSync(previousBuild, { recursive: true, force: true });
                fs.cpSync(buildPath, previousBuild, { recursive: true });
                appState.servingRoot = previousBuild;
                hasPreviousBuild = true;
              } catch (e: any) {
                pushGitLog(`⚠️ تهیه نسخه پشتیبان از بیلد قبلی ممکن نشد (${e.message})؛ سایت تا پایان بیلد در دسترس نخواهد بود.`, "error");
              }
            }

            pushGitLog(`در حال کامپایل و بیلد فرانت‌اند (npm run build)...`, "info");
            const statusBeforeBuild = appState.status;
            appState.status = "BUILDING";
            const buildRes = await streamProcess("npm", ["run", "build"], fullAppPath, npmEnv, pushGitLog, NPM_STEP_TIMEOUT_MS);
            if (appState.status === "BUILDING") {
              appState.status = statusBeforeBuild;
            }

            if (buildRes.code === 0) {
              appState.servingRoot = null;
              try {
                fs.rmSync(previousBuild, { recursive: true, force: true });
              } catch (e) {}
              pushGitLog(`بیلد فرانت‌اند با موفقیت تولید شد.`, "success");
            } else {
              readyToRestart = false;
              pushGitLog(`❌ بیلد فرانت‌اند ناموفق بود (کد: ${buildRes.code})`, "error");
              if (hasPreviousBuild) {
                try {
                  fs.rmSync(buildPath, { recursive: true, force: true });
                  fs.renameSync(previousBuild, buildPath);
                  appState.servingRoot = null;
                  pushGitLog(`بیلد قبلی بازگردانده شد و سایت با نسخه قبلی در دسترس است.`, "info");
                } catch (e: any) {
                  // Keep serving the copy rather than a broken output folder
                  pushGitLog(`❌ بازگردانی بیلد قبلی ممکن نشد (${e.message})؛ سایت همچنان از ${previousBuild} سرو می‌شود.`, "error");
                }
              }
            }
          }

          // 6. Restart App (backends with a `build` command are rebuilt as part of the restart)
          const servesSamePort = appState.config.type === "frontend" && appState.status === "RUNNING" &&
            appState.staticServer?.address()?.port === appState.config.port;
          if (readyToRestart && servesSamePort) {
            // The static server reads the build folder on every request, so the new build is already live
            pushGitLog(`✅ نسخه جدید ${appState.config.name} بدون نیاز به ری‌استارت در حال سرو شدن است.`, "success");
          } else if (readyToRestart) {
            pushGitLog(`در حال راه‌اندازی مجدد و اعمال نسخه جدید سرویس ${appState.config.name}...`, "info");
            if (appState.config.type === "backend" && appState.config.build) {
              pushGitLog(`در حال بیلد (${appState.config.build})؛ خروجی بیلد در لاگ‌های همین سرویس است...`, "info");
            }
            await restartApp(appState.config.id);
            if (appState.status === "RUNNING") {
              pushGitLog(`✅ سرویس ${appState.config.name} با موفقیت ری‌استارت شد.`, "success");
            } else {
              failedApps.push(appState.config.name);
              pushGitLog(`❌ سرویس ${appState.config.name} بعد از ری‌استارت اجرا نشد؛ لاگ‌های سرویس را بررسی کنید.`, "error");
            }
          } else {
            failedApps.push(appState.config.name);
            pushGitLog(`⏭️ سرویس ${appState.config.name} ری‌استارت نشد و با نسخه قبلی به کار ادامه می‌دهد. پس از رفع خطا دوباره بروزرسانی کنید.`, "error");
          }

          gitUpdateProgress = Math.min(95, Math.round(5 + (i + 1) * stepWeight));
        }

        pushGitLog(`────────────────────────────────────────────────────────`, "info");
        if (failedApps.length > 0) {
          pushGitLog(`⚠️ فرآیند پایان یافت اما ${failedApps.length} سرویس بروز نشد: [${failedApps.join(", ")}]`, "error");
          if (gitAuthRequired) {
            pushGitLog(`⚠️ یک یا چند سرویس نیازمند وارد کردن نام کاربری و توکن/رمز گیت بودند.`, "auth");
          }
        } else {
          pushGitLog(`🎉 عملیات بروزرسانی گیت با موفقیت کامل انجام شد! تمام سرویس‌ها بروز و فعال هستند.`, "success");
        }
        gitUpdateProgress = 100;
        gitUpdateRunning = false;

      } catch (err: any) {
        pushGitLog(`[FATAL] خطای پیش‌بینی نشده در فرآیند بروزرسانی: ${err.message}`, "error");
        gitUpdateProgress = 100;
        gitUpdateRunning = false;
      }
    })();
  });

  // API: AI Log Trouble-shooting / Gemini Diagnosis
  app.post("/api/ai/diagnose", async (req, res) => {
    const { appId, logs } = req.body;

    if (!logs || !Array.isArray(logs) || logs.length === 0) {
      res.status(400).json({ error: "Log history is required for analysis." });
      return;
    }

    try {
      const logsContext = redactSecrets(logs.slice(-60).join("\n"));
      const prompt = `You are an expert Devops Architect and System SRE (Site Reliability Engineer). 
Analyze the following runtime crash logs from the application process "${appId}". 
Identify the root cause of the crash, explain it simply, and provide 3 clear, actionable steps to resolve this bug.

Write your response in elegant Persian (فارسی) as requested by the server administration, utilizing technical terminology correctly. Use Markdown styling for lists and code snippets.

CRASH LOGS:
\`\`\`
${logsContext}
\`\`\`
`;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: prompt,
        config: {
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH
          }
        }
      });

      res.json({
        analysis: response.text
      });

    } catch (err: any) {
      console.error("[Orchestrator AI Error]", err);
      res.status(500).json({ error: `Gemini AI analysis failed: ${err.message}. Please configure GEMINI_API_KEY.` });
    }
  });

  // API: Create new app config
  app.post("/api/apps/create", (req, res) => {
    const { id, name, path: aPath, type, entry, port, autoStart } = req.body;

    if (!id || !name || !aPath || !type || !entry || !port) {
      res.status(400).json({ error: "All application registration fields are required." });
      return;
    }

    if (appStates.has(id)) {
      res.status(400).json({ error: "An application with this ID is already registered." });
      return;
    }

    const newApp: AppConfig = {
      id,
      name,
      path: aPath,
      type,
      entry,
      port: parseInt(port),
      autoStart: autoStart || false
    };

    config.apps.push(newApp);
    saveConfig();

    appStates.set(id, {
      config: newApp,
      status: "STOPPED",
      pid: null,
      restarts: 0,
          crashCount: 0,
      cpu: 0,
      memory: 0,
      uptime: 0,
      logs: [],
      lastCrashTime: null,
      childProcess: null,
      staticServer: null
    });

    if (newApp.autoStart) {
      startApp(id);
    }

    res.json({ status: "success", app: newApp });
  });

  // Serve documentation files (static page that loads Tailwind and Lucide from CDNs)
  const sendDocs = (req: express.Request, res: express.Response) => {
    res.removeHeader("Content-Security-Policy");
    res.sendFile(path.join(process.cwd(), "docs.html"));
  };
  app.get("/docs.html", sendDocs);
  app.get("/docs", sendDocs);

  // Vite development or production webserver setup
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use((req, res, next) => (SERVER_BUNDLE_PATHS.includes(req.path) ? res.status(404).send("Not Found") : next()));
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // BAS_HOST=127.0.0.1 keeps the panel reachable only through a local reverse proxy (e.g. nginx with TLS)
  const HOST = process.env.BAS_HOST || "0.0.0.0";
  app.listen(PORT, HOST, () => {
    console.log(`[Orchestrator Web Panel] Server actively running on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("[Orchestrator Fatal Error]", err);
});
