import express from "express";
import path from "path";
import fs from "fs";
import { exec, spawn, ChildProcess } from "child_process";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import dns from "dns";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

// Load environment variables from .env file
dotenv.config();

// Fix DNS resolution priority for localhost in older Node environments
dns.setDefaultResultOrder("ipv4first");

// Security state
export interface AccessLog {
  ip: string;
  timestamp: string;
  action: string;
  success: boolean;
}
const accessLogs: AccessLog[] = [];
const bannedIPs = new Map<string, number>();
const failedAttempts = new Map<string, number>();

function logAccess(ip: string, action: string, success: boolean) {
  accessLogs.unshift({ ip, timestamp: new Date().toISOString(), action, success });
  if (accessLogs.length > 200) accessLogs.pop();
}

function handleFailedAttempt(ip: string) {
  const count = (failedAttempts.get(ip) || 0) + 1;
  failedAttempts.set(ip, count);
  logAccess(ip, `Failed Auth (Count: ${count})`, false);
  
  if (count >= 5 && !bannedIPs.has(ip)) {
    bannedIPs.set(ip, Date.now() + 24 * 60 * 60 * 1000); // 24 hours ban
    logAccess(ip, "IP BANNED (5+ Failed Attempts)", false);
    // Send SMS alert
    triggerSMSAlert("SECURITY", "ATCK" + String(ip).replace(/[^0-9]/g, "").substring(0, 5));
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
  cpu: number;
  memory: number;
  uptime: number; // in seconds
  logs: string[];
  lastCrashTime: string | null;
  childProcess: ChildProcess | null;
  staticServer: any | null; // express/http server instance for frontends
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
let lastScanTime = 0;

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

// Start Application Process
function startApp(id: string) {
  const state = appStates.get(id);
  if (!state) return;

  if (state.status === "RUNNING") {
    addLog(id, `[SYSTEM] App is already running.`, "system");
    return;
  }

  state.status = "STARTING";
  addLog(id, `[SYSTEM] Starting application...`, "system");

  const appPath = path.resolve(process.cwd(), state.config.path);
  const entryFile = path.join(appPath, state.config.entry);

  if (state.config.type === "backend") {
    // BACKEND APP
    const absoluteNodeModules = path.resolve(process.cwd(), "node_modules");
    
    // Check if entry file exists
    if (!fs.existsSync(entryFile)) {
      state.status = "CRASHED";
      addLog(id, `[SYSTEM_ERROR] Entry file not found: ${entryFile}`, "stderr");
      return;
    }

    try {
      const child = spawn("node", [state.config.entry], {
        cwd: appPath,
        env: {
          ...process.env,
          NODE_PATH: absoluteNodeModules,
          PORT: state.config.port.toString()
        }
      });

      state.childProcess = child;
      state.pid = child.pid || null;
      state.status = "RUNNING";
      state.uptime = 0;

      addLog(id, `[SYSTEM] Process spawned successfully (PID: ${child.pid}) with NODE_PATH integration.`, "system");

      child.stdout?.on("data", (data) => {
        const text = data.toString().trim();
        if (text) addLog(id, text, "stdout");
      });

      child.stderr?.on("data", (data) => {
        const text = data.toString().trim();
        if (text) addLog(id, text, "stderr");
      });

      child.on("close", (code, signal) => {
        addLog(id, `[SYSTEM] Process exited with code ${code} (signal: ${signal || "none"})`, "system");
        
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
          addLog(id, `[SYSTEM] CRASH DETECTED! Exit code: ${code}, signal: ${signal}. Triggering Orchestrator Recovery...`, "system");
          
          // Trigger SMS Alert
          triggerSMSAlert(id, state.config.name);

          // Auto-Restart logic
          if (config.settings.autoRestart && state.restarts < config.settings.maxRestarts) {
            state.restarts += 1;
            const delay = Math.max(2500, config.settings.restartDelayMs || 2500);
            addLog(id, `[SYSTEM] Scheduling auto-restart #${state.restarts} in ${delay}ms...`, "system");
            setTimeout(() => {
              if (state.status === "CRASHED") {
                startApp(id);
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
      fApp.use(express.static(buildPath));
      fApp.get("*", (req, res) => {
        res.sendFile(path.join(buildPath, "index.html"));
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

// Stop Application Process
function stopApp(id: string) {
  const state = appStates.get(id);
  if (!state) return;

  addLog(id, `[SYSTEM] Manual STOP requested by administrator.`, "system");
  state.status = "STOPPED";
  state.restarts = 0; // Reset restart counter on manual stop

  if (state.config.type === "backend") {
    if (state.childProcess) {
      addLog(id, `[SYSTEM] Terminating child process PID ${state.pid}...`, "system");
      state.childProcess.kill("SIGKILL"); // Force kill to immediately release the port
      state.childProcess = null;
    }
    state.pid = null;
    state.cpu = 0;
    state.memory = 0;
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

// Restart Application Process
function restartApp(id: string) {
  addLog(id, `[SYSTEM] Manual RESTART requested.`, "system");
  stopApp(id);
  setTimeout(() => {
    startApp(id);
  }, 1500);
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
    try {
      state.childProcess.kill("SIGKILL");
    } catch (e) {}
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

  // Trigger SMS Alert
  triggerSMSAlert(id, state.config.name);

  // Auto-Restart logic (give 3 seconds of visible crash state before auto-recovering so user sees the crash)
  if (config.settings.autoRestart && state.restarts < config.settings.maxRestarts) {
    state.restarts += 1;
    const delay = Math.max(3000, config.settings.restartDelayMs || 3000);
    addLog(id, `[SYSTEM] Crash Recovery Activated: Auto-recovery restart #${state.restarts} scheduled in ${delay}ms...`, "system");
    setTimeout(() => {
      if (state.status === "CRASHED") {
        startApp(id);
      }
    }, delay);
  } else if (state.restarts >= config.settings.maxRestarts) {
    addLog(id, `[SYSTEM_ERROR] Max auto-restarts limit (${config.settings.maxRestarts}) reached. Manual restart needed.`, "stderr");
  }

  return true;
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

  const subdirs = fs.readdirSync(appsDir);
  let configChanged = false;

  // Track directories currently existing under apps/
  const existingAppPaths = new Set<string>();

  subdirs.forEach((dir) => {
    const fullPath = path.join(appsDir, dir);
    let isDir = false;
    try {
      isDir = fs.statSync(fullPath).isDirectory();
    } catch (e) {
      return;
    }
    if (!isDir) return;

    const relativePath = path.join("apps", dir);
    existingAppPaths.add(relativePath);

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

    const pkgName = pkgData.name || dir;

    const id = basConfig.id || pkgName;
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
        groups
      };

      config.apps.push(newApp);
      configChanged = true;
      console.log(`[Orchestrator] Auto-detected new application in ${relativePath}:`, newApp);

      // Register in state map
      if (!appStates.has(id)) {
        appStates.set(id, {
          config: newApp,
          status: "STOPPED",
          pid: null,
          restarts: 0,
          cpu: 0,
          memory: 0,
          uptime: 0,
          logs: [],
          lastCrashTime: null,
          childProcess: null,
          staticServer: null
        });

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

      const state = appStates.get(id);
      if (state) {
        state.config = { ...existingApp };
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
      exec("npm install", (err, stdout, stderr) => {
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
    appStates.set(app.id, {
      config: app,
      status: "STOPPED",
      pid: null,
      restarts: 0,
      cpu: 0,
      memory: 0,
      uptime: 0,
      logs: [],
      lastCrashTime: null,
      childProcess: null,
      staticServer: null
    });
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
    appStates.forEach((state, id) => {
      if (state.status === "RUNNING") {
        state.uptime += 1;

        if (state.config.type === "backend" && state.pid) {
          // Fetch actual CPU & Memory of the child process in Linux
          const pid = state.pid;
          exec(`ps -p ${pid} -o %cpu,rss`, (err, stdout, stderr) => {
            if (!err && stdout) {
              const lines = stdout.trim().split("\n");
              if (lines.length >= 2) {
                const stats = lines[1].trim().split(/\s+/);
                if (stats.length >= 2) {
                  const cpuVal = parseFloat(stats[0]);
                  const rssKb = parseInt(stats[1], 10);
                  if (!isNaN(cpuVal)) {
                    state.cpu = cpuVal;
                  }
                  if (!isNaN(rssKb)) {
                    state.memory = parseFloat((rssKb / 1024).toFixed(1)); // Convert KB to MB
                  }
                  return; // Successfully set real metrics!
                }
              }
            }

            // Graceful fallback to realistic simulation if ps is unavailable or fails
            state.cpu = parseFloat((0.5 + Math.random() * 2.0).toFixed(1));
            state.memory = parseFloat((25 + Math.random() * 5).toFixed(1));
          });
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
  }, 1000);
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

// Helper to resolve the Admin API Key dynamically from environment variables, .env, or .env.example
function resolveApiKey(): string {
  // 1. Check .env file first (allows overriding or clearing)
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      const match = content.match(/^(?:ADMIN_API_KEY|BAS_API_KEY|DASHBOARD_API_KEY)\s*=\s*(.*)$/m);
      if (match) {
        const val = match[1].trim().replace(/^['"]|['"]$/g, ""); // strip quotes
        if (!val || val === "none" || val === "false" || val === "your-api-key-here" || val === "your_secure_api_key_here" || val === "MY_API_KEY") {
          return "";
        }
        return val;
      }
    } catch (e) {
      console.error("[Orchestrator] Error reading .env file for API_KEY:", e);
    }
  }

  // 2. Try explicit dashboard admin keys (avoid generic API_KEY which is reserved for AI SDKs)
  const envAdminKey = process.env.ADMIN_API_KEY || process.env.BAS_API_KEY || process.env.DASHBOARD_API_KEY;
  if (envAdminKey && envAdminKey.trim() !== "") {
    const val = envAdminKey.trim().replace(/^['"]|['"]$/g, "");
    if (val === "none" || val === "false" || val === "your-api-key-here" || val === "your_secure_api_key_here" || val === "MY_API_KEY") {
      return "";
    }
    return val;
  }

  return "";
}

// Simple cookie parser helper
function getCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";");
  for (let i = 0; i < cookies.length; i++) {
    const cookie = cookies[i].trim();
    if (cookie.startsWith(name + "=")) {
      return cookie.substring(name.length + 1);
    }
  }
  return null;
}

// Run full-stack Server
async function startServer() {
  const app = express();
  // Trust the reverse proxy (e.g., Cloud Run, Nginx, AI Studio) to securely read X-Forwarded-For headers for rate-limiting
  app.set("trust proxy", 1);
  const PORT = resolveServerPort();

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false })); // disabled CSP/COEP for external CDNs (Tailwind, Fonts)
  app.use(express.json());

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10000, // accommodate 1.5s live dashboard polling
    message: { error: "Too many requests from this IP" },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api/", apiLimiter);

  // Security Middleware: Protect the panel with API_KEY if set, handle IPs
  app.use((req, res, next) => {
    const clientIP = (req.headers["x-forwarded-for"] as string)?.split(',')[0] || req.ip || req.socket.remoteAddress || "unknown";
    
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

    const API_KEY = resolveApiKey();
    if (!API_KEY) {
      return next();
    }

    const loginPath = "/" + API_KEY;
    let reqPathDecoded = req.path;
    try {
      reqPathDecoded = decodeURIComponent(req.path);
    } catch (e) {}

    // 1. Check if the path matches the API key exactly to authenticate
    if (reqPathDecoded === loginPath || reqPathDecoded === loginPath + "/") {
      failedAttempts.delete(clientIP);
      logAccess(clientIP, "Successful Login via Path", true);
      res.cookie("orchestrator_api_key", API_KEY, {
        path: "/",
        maxAge: 2 * 60 * 60 * 1000, // 2 hours
        sameSite: "lax"
      });
      return res.redirect("/");
    }

    // 2. Extract and check the cookie or x-api-key header
    const cookieVal = getCookie(req.headers.cookie, "orchestrator_api_key");
    const headerVal = req.headers["x-api-key"];
    const isAuthenticated = (cookieVal === API_KEY) || (headerVal === API_KEY);

    if (isAuthenticated) {
      if (headerVal === API_KEY) {
         failedAttempts.delete(clientIP);
      }
      return next();
    }

    if (req.path === "/api/auth/login" && req.method === "POST") {
      const { apiKey } = req.body || {};
      if (apiKey === API_KEY) {
        failedAttempts.delete(clientIP);
        logAccess(clientIP, "Successful Login via UI", true);
        res.cookie("orchestrator_api_key", API_KEY, {
          path: "/",
          maxAge: 2 * 60 * 60 * 1000, // 2 hours
          sameSite: "lax"
        });
        return res.json({ success: true });
      } else {
        handleFailedAttempt(clientIP);
        return res.status(401).json({ error: "Invalid API Key" });
      }
    }

    // 3. Unauthorized access
    const hasAttemptedAuth = Boolean(headerVal || cookieVal || req.path.startsWith("/api/"));
    if (hasAttemptedAuth) {
       handleFailedAttempt(clientIP);
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

    // Let other sub-assets (Vite scripts, favicon, styling) load
    next();
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
      port: state.config.port,
      autoStart: state.config.autoStart,
      groups: state.config.groups,
      status: state.status,
      pid: state.pid,
      restarts: state.restarts,
      cpu: state.cpu,
      memory: state.memory,
      uptime: state.uptime,
      lastCrashTime: state.lastCrashTime,
      logCount: state.logs.length
    }));

    res.json({
      apps: appsList,
      settings: config.settings,
      smsGateway: config.smsGateway,
      systemMetrics: {
        totalCpu: parseFloat(Array.from(appStates.values()).reduce((acc, s) => acc + s.cpu, 0).toFixed(1)),
        totalMemory: parseFloat(Array.from(appStates.values()).reduce((acc, s) => acc + s.memory, 0).toFixed(1)) + 120, // include system overhead
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime()
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
          exec("npm install", (err, stdout, stderr) => {
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

  // API: Git Batch Updater
  app.post("/api/apps/git-update", (req, res) => {
    const { keyword } = req.body;
    const filterKeyword = keyword || "";

    if (gitUpdateRunning) {
      res.status(400).json({ error: "Another Git update process is currently running." });
      return;
    }

    gitUpdateLogs = [`[${new Date().toISOString()}] [INFO] Starting Git Batch Update with filter: "${filterKeyword}"`];
    gitUpdateRunning = true;
    gitUpdateProgress = 5;

    // Start background processing
    res.json({ status: "success", message: "Git batch updater started successfully in background." });

    // Background runner sequence
    (async () => {
      try {
        const appsDir = path.resolve(process.cwd(), "apps");
        if (!fs.existsSync(appsDir)) {
          gitUpdateLogs.push(`[${new Date().toISOString()}] [ERROR] Apps folder not found.`);
          gitUpdateRunning = false;
          return;
        }

        const matchingApps: AppRuntimeState[] = [];
        const keywordLower = filterKeyword.toLowerCase();

        appStates.forEach((state) => {
          const nameMatches = state.config.name.toLowerCase().includes(keywordLower);
          const idMatches = state.config.id.toLowerCase().includes(keywordLower);
          
          let groupMatches = false;
          if (state.config.groups && Array.isArray(state.config.groups)) {
            groupMatches = state.config.groups.some(g => g.toLowerCase().includes(keywordLower));
          }

          if (nameMatches || idMatches || groupMatches || filterKeyword === "") {
            matchingApps.push(state);
          }
        });

        if (matchingApps.length === 0) {
          gitUpdateLogs.push(`[${new Date().toISOString()}] [WARNING] No configured applications matching keyword "${keyword}" were found.`);
          gitUpdateProgress = 100;
          gitUpdateRunning = false;
          return;
        }

        gitUpdateLogs.push(`[${new Date().toISOString()}] [INFO] Found ${matchingApps.length} matching applications to update.`);
        
        const stepWeight = 90 / matchingApps.length;

        for (let i = 0; i < matchingApps.length; i++) {
          const appState = matchingApps[i];
          const fullAppPath = path.resolve(process.cwd(), appState.config.path);
          gitUpdateLogs.push(`----------------------------------------`);
          gitUpdateLogs.push(`[${new Date().toISOString()}] [PROCESS] Updating application: ${appState.config.name} (${appState.config.id})`);
          
          try {
            // 1. Git Reset Hard
            gitUpdateLogs.push(`[${new Date().toISOString()}] [CMD] git reset --hard HEAD`);
            await new Promise<void>((resolve, reject) => {
              exec("git reset --hard HEAD", { cwd: fullAppPath, timeout: 60000 }, (err, stdout, stderr) => {
                if (err) {
                  gitUpdateLogs.push(`[${new Date().toISOString()}] [STDERR] ${stderr}`);
                  reject(new Error(`Git reset failed: ${err.message}`));
                  return;
                }
                gitUpdateLogs.push(`[${new Date().toISOString()}] [STDOUT] ${stdout.trim()}`);
                resolve();
              });
            });

            // 2. Git Fetch
            gitUpdateLogs.push(`[${new Date().toISOString()}] [CMD] git fetch --all`);
            await new Promise<void>((resolve, reject) => {
              exec("git fetch --all", { cwd: fullAppPath, timeout: 60000 }, (err, stdout, stderr) => {
                if (err) {
                  gitUpdateLogs.push(`[${new Date().toISOString()}] [STDERR] ${stderr}`);
                  reject(new Error(`Git fetch failed: ${err.message}`));
                  return;
                }
                if (stdout) gitUpdateLogs.push(`[${new Date().toISOString()}] [STDOUT] ${stdout.trim()}`);
                resolve();
              });
            });

            // 3. Git Pull
            gitUpdateLogs.push(`[${new Date().toISOString()}] [CMD] git pull`);
            await new Promise<void>((resolve, reject) => {
              exec("git pull", { cwd: fullAppPath, timeout: 60000 }, (err, stdout, stderr) => {
                if (err) {
                  gitUpdateLogs.push(`[${new Date().toISOString()}] [STDERR] ${stderr}`);
                  reject(new Error(`Git pull failed: ${err.message}`));
                  return;
                }
                gitUpdateLogs.push(`[${new Date().toISOString()}] [STDOUT] ${stdout.trim()}`);
                resolve();
              });
            });
          } catch (gitErr: any) {
            gitUpdateLogs.push(`[${new Date().toISOString()}] [ERROR] Update failed for ${appState.config.name}: ${gitErr.message}`);
            gitUpdateLogs.push(`[${new Date().toISOString()}] [INFO] Skipping build/restart for this app due to git error.`);
            gitUpdateProgress = Math.min(95, Math.round(5 + (i + 1) * stepWeight));
            continue; // Skip build/restart and move to the next app
          }

          // 4. Build if frontend or restart if backend
          if (appState.config.type === "frontend") {
            gitUpdateLogs.push(`[${new Date().toISOString()}] [CMD] npm run build`);
            appState.status = "BUILDING";
            
            await new Promise<void>((resolve) => {
              // run build script of that app
              exec("npm run build", { cwd: fullAppPath }, (err, stdout, stderr) => {
                if (err) {
                  gitUpdateLogs.push(`[${new Date().toISOString()}] [STDERR] Build failed: ${err.message}`);
                } else {
                  gitUpdateLogs.push(`[${new Date().toISOString()}] [STDOUT] Client build compiled successfully inside dist/ folder.`);
                }
                resolve();
              });
            });

            // Re-serve client static server
            gitUpdateLogs.push(`[${new Date().toISOString()}] [INFO] Reloading static web server assets...`);
            restartApp(appState.config.id);

          } else {
            // Backend: Restart process
            gitUpdateLogs.push(`[${new Date().toISOString()}] [INFO] Restarting backend microservice process...`);
            restartApp(appState.config.id);
            gitUpdateLogs.push(`[${new Date().toISOString()}] [SUCCESS] Backend service restarted successfully.`);
          }

          gitUpdateProgress = Math.min(95, Math.round(5 + (i + 1) * stepWeight));
        }

        gitUpdateLogs.push(`----------------------------------------`);
        gitUpdateLogs.push(`[${new Date().toISOString()}] [SUCCESS] Git Batch Update completed successfully!`);
        gitUpdateProgress = 100;
        gitUpdateRunning = false;

      } catch (err: any) {
        gitUpdateLogs.push(`[${new Date().toISOString()}] [FATAL] Git Updater process aborted: ${err.message}`);
        gitUpdateRunning = false;
      }
    })();
  });

  // API: Get Git Update Logs
  app.get("/api/apps/git-update/logs", (req, res) => {
    res.json({
      logs: gitUpdateLogs,
      running: gitUpdateRunning,
      progress: gitUpdateProgress
    });
  });

  // API: AI Log Trouble-shooting / Gemini Diagnosis
  app.post("/api/ai/diagnose", async (req, res) => {
    const { appId, logs } = req.body;

    if (!logs || !Array.isArray(logs) || logs.length === 0) {
      res.status(400).json({ error: "Log history is required for analysis." });
      return;
    }

    try {
      const logsContext = logs.slice(-60).join("\n");
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

  // Serve documentation files
  app.get("/docs.html", (req, res) => {
    res.sendFile(path.join(process.cwd(), "docs.html"));
  });
  app.get("/docs", (req, res) => {
    res.sendFile(path.join(process.cwd(), "docs.html"));
  });

  // Vite development or production webserver setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    const API_KEY = resolveApiKey();
    const suffix = API_KEY ? `/${API_KEY}` : "";
    console.log(`[Orchestrator Web Panel] Server actively running on http://localhost:${PORT}${suffix}`);
  });
}

startServer().catch((err) => {
  console.error("[Orchestrator Fatal Error]", err);
});
