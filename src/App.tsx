import React, { useState, useEffect, useRef } from "react";
import { 
  Server, 
  Activity, 
  Cpu, 
  Database, 
  Terminal, 
  Settings, 
  RefreshCw, 
  Play, 
  Square, 
  Zap, 
  GitBranch, 
  Package, 
  AlertTriangle, 
  CheckCircle2, 
  MessageSquare, 
  Phone, 
  ShieldAlert, 
  Search, 
  Clock, 
  Sparkles,
  Info,
  ChevronRight,
  ChevronLeft,
  Sliders,
  Send,
  BookOpen,
  X,
  Lock,
  Key,
  ArrowRight,
  LogOut
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { BasCentralCore, CoreStatus } from "./components/BasCentralCore";
import { SineWaveMonitor } from "./components/SineWaveMonitor";

interface AppState {
  id: string;
  name: string;
  version?: string;
  path: string;
  type: "backend" | "frontend";
  entry: string;
  port: number;
  autoStart: boolean;
  groups?: string[];
  status: "RUNNING" | "STOPPED" | "CRASHED" | "STARTING" | "BUILDING";
  pid: number | null;
  restarts: number;
  cpu: number;
  memory: number;
  uptime: number;
  lastCrashTime: string | null;
  logCount: number;
}

interface SMSGateway {
  provider: string;
  apiKey: string;
  endpoint: string;
  sender: string;
  recipient: string;
  enabled: boolean;
}

interface Settings {
  autoRestart: boolean;
  maxRestarts: number;
  restartDelayMs: number;
  soundEnabled?: boolean;
}

interface SystemMetrics {
  totalCpu: number;
  totalMemory: number;
  nodeVersion: string;
  platform: string;
  uptime: number;
}

interface AccessLog {
  ip: string;
  timestamp: string;
  action: string;
  success: boolean;
}

interface BannedIP {
  ip: string;
  expiry: number;
  expired: boolean;
}

export default function App() {
  const [needsLogin, setNeedsLogin] = useState<boolean>(false);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [apps, setApps] = useState<AppState[]>([]);
  const [smsGateway, setSmsGateway] = useState<SMSGateway>({
    provider: "kavenegar",
    apiKey: "",
    endpoint: "",
    sender: "",
    recipient: "",
    enabled: false
  });
  const [settings, setSettings] = useState<Settings>({
    autoRestart: true,
    maxRestarts: 5,
    restartDelayMs: 2000
  });
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics>({
    totalCpu: 0,
    totalMemory: 0,
    nodeVersion: "",
    platform: "",
    uptime: 0
  });

  const [activeTab, setActiveTab] = useState<"overview" | "logs" | "git" | "merger" | "settings" | "security">("overview");
  const [selectedAppId, setSelectedAppId] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [logsFilter, setLogsFilter] = useState<string>("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  
  // Security logs state
  const [securityLogs, setSecurityLogs] = useState<AccessLog[]>([]);
  const [bannedIPs, setBannedIPs] = useState<BannedIP[]>([]);
  
  // Logs controls
  const [isLogsPaused, setIsLogsPaused] = useState(false);
  const [isLogsFullScreen, setIsLogsFullScreen] = useState(false);
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
  
  // AI Diagnostics state
  const [aiAnalysis, setAiAnalysis] = useState<string>("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showAutoDiscoveryGuide, setShowAutoDiscoveryGuide] = useState(false);

  // Pagination for 4-card layout around central core
  const [overviewPage, setOverviewPage] = useState(0);

  // BAS Core Tension & Stabilization
  const [coreTension, setCoreTension] = useState(0);
  const [coreStabilized, setCoreStabilized] = useState(false);

  // Live HUD clock & Persian date
  const [currentTime, setCurrentTime] = useState<string>("");
  const [currentDate, setCurrentDate] = useState<string>("");

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      const seconds = String(now.getSeconds()).padStart(2, "0");
      setCurrentTime(`${hours}:${minutes}:${seconds}`);

      try {
        const persianDate = new Intl.DateTimeFormat("fa-IR", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric"
        }).format(now);
        setCurrentDate(persianDate);
      } catch (e) {
        setCurrentDate(now.toLocaleDateString("fa-IR"));
      }
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  // Git update state
  const [gitKeyword, setGitKeyword] = useState("");
  const [gitLogs, setGitLogs] = useState<string[]>([]);
  const [gitProgress, setGitProgress] = useState(0);
  const [gitRunning, setGitRunning] = useState(false);

  // Dependency merger state
  const [scannedApps, setScannedApps] = useState<any[]>([]);
  const [mergedDeps, setMergedDeps] = useState<Record<string, string>>({});
  const [isMerging, setIsMerging] = useState(false);
  const [mergeMessage, setMergeMessage] = useState("");

  const logsEndRef = useRef<HTMLDivElement>(null);
  const gitLogsEndRef = useRef<HTMLDivElement>(null);
  const previousAppsRef = useRef<AppState[]>([]);
  const settingsRef = useRef<Settings>(settings);

  // Sync settingsRef
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Play alarm sound
  const playAlarm = () => {
    if (settingsRef.current.soundEnabled === false) return; // Default true if undefined
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'square';
      // Repeat the siren pattern for 4 seconds (10 cycles of 0.4s)
      for (let i = 0; i < 10; i++) {
        osc.frequency.setValueAtTime(440, ctx.currentTime + i * 0.4);
        osc.frequency.setValueAtTime(880, ctx.currentTime + i * 0.4 + 0.2);
      }
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start();
      gain.gain.setValueAtTime(0.05, ctx.currentTime);
      gain.gain.setValueAtTime(0.05, ctx.currentTime + 3.5); // Hold volume
      gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 4.0); // Fade out at end
      osc.stop(ctx.currentTime + 4.0);
    } catch (e) {
      console.warn("Audio play failed", e);
    }
  };

  const playClickSound = () => {
    if (settingsRef.current.soundEnabled === false) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.1);
      osc.stop(ctx.currentTime + 0.1);
    } catch (e) {}
  };

  // Load state and apps
  const fetchState = async () => {
    try {
      const res = await fetch("/api/apps", { cache: "no-store" });
      
      if (res.status === 401 || res.status === 403) {
        setNeedsLogin(true);
        return;
      }
      setNeedsLogin(false);
      
      if (!res.ok) throw new Error("API Connection Failed");
      const data = await res.json();
      
      if (data.apps) {
        const hasNewCrash = data.apps.some((newApp: AppState) => {
          const oldApp = previousAppsRef.current.find(a => a.id === newApp.id);
          return oldApp && oldApp.status !== "CRASHED" && newApp.status === "CRASHED";
        });
        
        if (hasNewCrash) {
          playAlarm();
        }
        
        previousAppsRef.current = data.apps;
      }
      
      setApps(data.apps || []);
      setSystemMetrics(data.systemMetrics);
      setConnectionError(false);

      // Select first app as default if none selected
      if (!selectedAppId && data.apps && data.apps.length > 0) {
        setSelectedAppId(data.apps[0].id);
      }
    } catch (err) {
      console.error("Failed to fetch state:", err);
      setConnectionError(true);
    }
  };

  // Load config once
  const fetchConfig = async () => {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.settings) setSettings(data.settings);
        if (data.smsGateway) setSmsGateway(data.smsGateway);
      }
    } catch (err) {
      console.error("Failed to fetch config:", err);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  // Fetch security logs
  const fetchSecurityLogs = async () => {
    try {
      const res = await fetch("/api/security-logs", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setSecurityLogs(data.logs || []);
        setBannedIPs(data.bannedIPs || []);
      }
    } catch (err) {
      console.error("Failed to fetch security logs:", err);
    }
  };

  const handleUnban = async (ip: string) => {
    if (!window.confirm(`آیا از رفع مسدودی آی‌پی ${ip} اطمینان دارید؟`)) return;
    try {
      const res = await fetch("/api/security/unban", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip })
      });
      if (res.ok) {
        fetchSecurityLogs();
      } else {
        alert("خطا در رفع مسدودی.");
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Poll app states and security logs every 1.5 seconds
  useEffect(() => {
    fetchState();
    fetchSecurityLogs();
    const interval = setInterval(() => {
      fetchState();
      fetchSecurityLogs();
    }, 1500);
    return () => clearInterval(interval);
  }, [selectedAppId]);

  const [lastSeenBannedCount, setLastSeenBannedCount] = useState(0);

  useEffect(() => {
    if (activeTab === "security") {
      setLastSeenBannedCount(bannedIPs.length);
    }
  }, [activeTab, bannedIPs.length]);

  // Fetch logs for selected app
  const fetchLogs = async (appId: string) => {
    if (!appId || isLogsPaused) return;
    try {
      const res = await fetch(`/api/apps/${appId}/logs`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch (err) {
      console.error("Failed to fetch logs:", err);
    }
  };

  // Periodically fetch logs for selected app in Logs tab
  useEffect(() => {
    if (activeTab === "logs" && selectedAppId && !isLogsPaused) {
      fetchLogs(selectedAppId);
      const logInterval = setInterval(() => fetchLogs(selectedAppId), 1500);
      return () => clearInterval(logInterval);
    }
  }, [selectedAppId, activeTab, isLogsPaused]);

  // Clear Logs
  const clearLogs = async (appId: string) => {
    try {
      await fetch(`/api/apps/${appId}/logs/clear`, { method: "POST" });
      setLogs([`[${new Date().toISOString()}] [SYSTEM] Logs cleared by user.`]);
    } catch (e) {
      console.error(e);
    }
  };

  // Handle logs manual scroll
  const handleLogsScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    if (isAtBottom && !isAutoScrollEnabled) {
      setIsAutoScrollEnabled(true);
    } else if (!isAtBottom && isAutoScrollEnabled) {
      setIsAutoScrollEnabled(false);
    }
  };

  // Scroll to bottom of logs
  useEffect(() => {
    if (isAutoScrollEnabled) {
      logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, isAutoScrollEnabled]);
  useEffect(() => {
    let gitInterval: NodeJS.Timeout;
    if (gitRunning || activeTab === "git") {
      const getGitStatus = async () => {
        try {
          const res = await fetch("/api/apps/git-update/logs", { cache: "no-store" });
          if (res.ok) {
            const data = await res.json();
            setGitLogs(data.logs || []);
            setGitRunning(data.running);
            setGitProgress(data.progress);
          }
        } catch (e) {}
      };
      getGitStatus();
      gitInterval = setInterval(getGitStatus, 1000);
    }
    return () => clearInterval(gitInterval);
  }, [gitRunning, activeTab]);

  // Scroll to bottom of logs
  useEffect(() => {
    gitLogsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [gitLogs]);

  // Handle process actions (start, stop, restart)
  const triggerAction = async (id: string, action: "start" | "stop" | "restart") => {
    try {
      const res = await fetch(`/api/apps/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      if (res.ok) {
        fetchState();
        if (activeTab === "logs" && id === selectedAppId) {
          fetchLogs(id);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Simulate process crash
  const simulateCrash = async (id: string) => {
    // Optimistic UI state transition for instant responsiveness
    setApps(prev => prev.map(a => a.id === id ? { ...a, status: "CRASHED", pid: null, cpu: 0, memory: 0 } : a));

    try {
      const res = await fetch(`/api/apps/${id}/simulate-crash`, {
        method: "POST"
      });
      if (res.ok) {
        await fetchState();
        if (selectedAppId === id) {
          fetchLogs(id);
        }
      }
    } catch (e) {
      console.error("Crash simulation failed:", e);
      fetchState();
    }
  };

  // Trigger SRE AI analysis on logs
  const triggerAiAnalysis = async () => {
    if (!selectedAppId || logs.length === 0) return;
    setIsAnalyzing(true);
    setAiAnalysis("");
    try {
      const res = await fetch("/api/ai/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: selectedAppId, logs })
      });
      if (res.ok) {
        const data = await res.json();
        setAiAnalysis(data.analysis || "تحلیل با موفقیت انجام شد اما پاسخی دریافت نشد.");
      } else {
        const data = await res.json();
        setAiAnalysis(`خطا در ارتباط با هوش مصنوعی: ${data.error || "شناخته نشده"}`);
      }
    } catch (err: any) {
      setAiAnalysis(`خطای سیستمی: ${err.message}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Run git batch update
  const runGitUpdate = async () => {
    setGitRunning(true);
    setGitProgress(0);
    try {
      await fetch("/api/apps/git-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword: gitKeyword })
      });
      // Fetch status immediately to show logs
      const res = await fetch("/api/apps/git-update/logs", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setGitLogs(data.logs || []);
        setGitRunning(data.running);
        setGitProgress(data.progress);
      }
    } catch (e) {
      setGitRunning(false);
    }
  };

  // Scan and merge dependencies
  const scanAndMergeDeps = async (apply = false) => {
    setIsMerging(true);
    setMergeMessage("");
    try {
      const res = await fetch("/api/apps/merge-dependencies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply })
      });
      if (res.ok) {
        const data = await res.json();
        setMergedDeps(data.mergedDependencies || {});
        setScannedApps(data.scannedApps || []);
        if (apply) {
          setMergeMessage(data.message || "✓ دپندسی‌ها با موفقیت در فایل package.json اصلی ادغام و نصب شدند!");
        }
      }
    } catch (e) {
      setMergeMessage("⚠️ خطا در پردازش فایل‌های پکیج.");
    } finally {
      setIsMerging(false);
    }
  };

  // Save Orchestrator settings
  const saveGatewaySettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings,
          smsGateway
        })
      });
      if (res.ok) {
        alert("✓ تنظیمات سیستم با موفقیت ذخیره شد.");
      }
    } catch (e) {
      alert("خطا در ذخیره‌سازی تنظیمات.");
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoggingIn(true);
    setLoginError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginUsername, password: loginPassword })
      });
      if (res.ok) {
        setNeedsLogin(false);
        fetchState();
      } else {
        setLoginError("نام کاربری یا رمز عبور نامعتبر است.");
      }
    } catch (e) {
      setLoginError("خطا در ارتباط با سرور. لطفاً دوباره تلاش کنید.");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (e) {
      console.error(e);
    }
    setNeedsLogin(true);
    setLoginUsername("");
    setLoginPassword("");
  };

  // Format uptime compactly (e.g., 10s, 10m, 10h, 10d, 400d)
  const formatUptime = (seconds: number) => {
    if (!seconds || seconds <= 0) return "0s";
    const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d}d`;
    const h = Math.floor(seconds / 3600);
    if (h > 0) return `${h}h`;
    const m = Math.floor(seconds / 60);
    if (m > 0) return `${m}m`;
    return `${Math.floor(seconds)}s`;
  };

  if (needsLogin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0A0A0B] bg-cover bg-fixed bg-center p-4 relative" style={{ backgroundImage: "url('/bgbas.png')" }} dir="rtl">
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] pointer-events-none"></div>
        <motion.div 
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="relative z-10 w-full max-w-md bg-[#0f172a]/95 border border-slate-700/50 p-8 rounded-2xl shadow-2xl backdrop-blur-xl"
        >
          <div className="flex flex-col items-center justify-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-cyan-500/20 to-blue-500/20 border border-cyan-500/30 flex items-center justify-center mb-4 shadow-[0_0_30px_rgba(6,182,212,0.15)]">
              <Lock className="w-8 h-8 text-cyan-400" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">ورود به سیستم</h1>
            <p className="text-sm text-slate-400 text-center">
              برای دسترسی به داشبورد امنیتی، مشخصات خود را وارد کنید.
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-4">
              <div className="relative">
                <input
                  type="text"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  placeholder="نام کاربری"
                  className="block w-full bg-[#0a0f1d] border border-slate-700/50 rounded-xl py-3 px-4 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all text-left"
                  dir="ltr"
                  autoFocus
                />
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                  <Key className="h-5 w-5 text-slate-500" />
                </div>
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="رمز عبور"
                  className="block w-full bg-[#0a0f1d] border border-slate-700/50 rounded-xl py-3 pr-10 pl-4 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all text-left"
                  dir="ltr"
                />
              </div>
              {loginError && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-rose-400 mt-2 pr-1">
                  {loginError}
                </motion.p>
              )}
            </div>

            <button
              type="submit"
              disabled={isLoggingIn || !loginPassword || !loginUsername}
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold rounded-xl py-3 px-4 shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoggingIn ? (
                <RefreshCw className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  ورود به داشبورد
                  <ArrowRight className="w-5 h-5 rotate-180" />
                </>
              )}
            </button>
          </form>

          {/* Footer Branding */}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col justify-between bg-[#0A0A0B] bg-cover bg-fixed bg-center text-slate-300 font-sans antialiased selection:bg-emerald-500 selection:text-black p-3 sm:p-5 relative" style={{ backgroundImage: "url('/bgbas.png')" }} dir="rtl">
      
      {/* Top Right Floating Quick-Action Icons */}
      <div className="fixed top-4 right-4 sm:top-5 sm:right-6 z-40 flex items-center gap-2">
        <button
          onClick={handleLogout}
          className="w-10 h-10 rounded-xl bg-[#06111e]/85 backdrop-blur-md border border-[#0d3b5e]/80 hover:border-rose-500/80 text-rose-400 hover:text-rose-300 flex items-center justify-center shadow-[0_0_15px_rgba(244,63,94,0.2)] transition-all duration-300"
          title="خروج از حساب"
        >
          <LogOut className="w-5 h-5" />
        </button>
      </div>

      {/* Top Left Floating Quick-Action Icons */}
      <div className="fixed top-4 left-4 sm:top-5 sm:left-6 z-40 flex items-center gap-2">
        {/* Auto Discovery Guide Icon Button */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowAutoDiscoveryGuide(prev => !prev)}
            className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300 backdrop-blur-md border ${
              showAutoDiscoveryGuide
                ? "bg-cyan-950/90 text-cyan-300 border-cyan-400 shadow-[0_0_20px_rgba(6,182,212,0.6)]"
                : "bg-[#06111e]/85 text-cyan-400 hover:text-cyan-300 border-[#0d3b5e]/80 hover:border-cyan-500/80 shadow-[0_0_15px_rgba(6,182,212,0.2)]"
            }`}
            title="راهنمای سیستم کشف خودکار (Auto-Discovery)"
          >
            <Sparkles className="w-5 h-5 animate-pulse" />
          </button>

          {/* Floating Auto-Discovery Guide Popover */}
          <AnimatePresence>
            {showAutoDiscoveryGuide && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowAutoDiscoveryGuide(false)}
                />
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                  className="absolute top-full left-0 mt-3 z-50 w-[440px] max-w-[90vw] bg-[#06111e]/95 backdrop-blur-xl border border-cyan-500/80 p-5 rounded-2xl shadow-[0_0_45px_rgba(0,180,255,0.35)] text-right text-xs"
                  dir="rtl"
                >
                  <div className="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-400 to-transparent"></div>

                  <div>
                    <div className="flex items-center justify-between text-cyan-400 mb-3">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-cyan-400 animate-pulse" />
                        <h4 className="font-bold text-sm tracking-wide text-cyan-300">سیستم کشف خودکار (Auto-Discovery)</h4>
                      </div>
                      <button
                        onClick={() => setShowAutoDiscoveryGuide(false)}
                        className="w-7 h-7 rounded-lg bg-cyan-950/60 border border-cyan-800/60 flex items-center justify-center text-slate-400 hover:text-white hover:border-cyan-400 transition"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <p className="text-[11px] text-slate-300 leading-relaxed mb-2 font-medium">
                      برای افزودن یا حذف یک کامپوننت، کافیست آن را در مسیر <code className="font-mono bg-[#030914] border border-cyan-900/60 px-1.5 py-0.5 rounded text-cyan-300 text-[10px]">apps/</code> قرار دهید. سیستم به طور خودکار آن را شناسایی می‌کند.
                    </p>
                    <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
                      تنظیمات نهایی شامل تایپ، پورت، بوت و گروه‌بندی در فایل <code className="font-mono bg-[#030914] border border-cyan-900/60 px-1.5 py-0.5 rounded text-cyan-400 text-[10px]">bas.config.json</code> قابل ویرایش است:
                    </p>

                    <div className="bg-[#030914]/90 border border-cyan-900/60 rounded-xl p-3.5 shadow-[inset_0_0_15px_rgba(0,0,0,0.5)]" dir="ltr">
                      <pre className="text-[10px] text-cyan-200/90 font-mono overflow-x-auto leading-relaxed select-all">
{`{
  "name": "My Custom Service",
  "type": "backend", // or "frontend"
  "entry": "server.js", // build/dist for front
  "port": 5001, // optional auto-assigned port
  "autoStart": true,
  "groups": ["payment", "core"]
}`}
                      </pre>
                    </div>
                  </div>

                  <div className="text-[10px] text-slate-400 font-mono flex items-center gap-2 mt-4 justify-start" dir="ltr">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse"></span>
                    <span className="text-emerald-400 font-bold tracking-wider">ACTIVE DIRECTORY LISTENER ENABLED</span>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        {/* Documentation External Link Icon Button */}
        <a
          href="/docs.html"
          target="_blank"
          rel="noopener noreferrer"
          className="w-10 h-10 rounded-xl bg-[#06111e]/85 backdrop-blur-md border border-[#0d3b5e]/80 hover:border-emerald-500/80 text-emerald-400 hover:text-emerald-300 flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.2)] transition-all duration-300"
          title="مشاهده مستندات راهنما"
        >
          <BookOpen className="w-5 h-5" />
        </a>
      </div>

      {/* Main Layout: Right Menu (3 items) - Content (Center) - Left Menu (3 items) */}
      <main className="flex-1 w-full max-w-[1720px] mx-auto flex flex-col lg:flex-row items-stretch lg:items-center gap-4 min-h-[68vh] mb-6">
        
        {/* Right Vertical Navigation (3 Items Centered in Height) */}
        <div className="flex flex-row lg:flex-col gap-3 justify-center items-center shrink-0 order-1 lg:order-1 self-center my-auto">
          {/* Item 1: Services */}
          <button
            onClick={() => setActiveTab("overview")}
            className={`w-28 sm:w-32 py-3.5 px-2 rounded-2xl flex flex-col items-center justify-center gap-2 text-center transition-all duration-300 backdrop-blur-md ${
              activeTab === "overview"
                ? "bg-[#06111e]/95 border-2 border-cyan-400 text-cyan-300 shadow-[0_0_25px_rgba(6,182,212,0.45)] scale-[1.02]"
                : "bg-[#06111e]/80 border border-[#0d3b5e]/70 text-slate-400 hover:text-slate-200 hover:border-cyan-500/50 hover:bg-[#06111e]/95 shadow-[0_0_12px_rgba(0,180,255,0.06)]"
            }`}
          >
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center border transition-all ${
              activeTab === "overview"
                ? "bg-cyan-950/80 border-cyan-400 text-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.5)]"
                : "bg-[#030914]/80 border-cyan-900/40 text-slate-400"
            }`}>
              <Server className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-bold tracking-tight">سرویس‌ها</span>
          </button>

          {/* Item 2: AI Console */}
          <button
            onClick={() => setActiveTab("logs")}
            className={`w-28 sm:w-32 py-3.5 px-2 rounded-2xl flex flex-col items-center justify-center gap-2 text-center transition-all duration-300 backdrop-blur-md ${
              activeTab === "logs"
                ? "bg-[#06111e]/95 border-2 border-cyan-400 text-cyan-300 shadow-[0_0_25px_rgba(6,182,212,0.45)] scale-[1.02]"
                : "bg-[#06111e]/80 border border-[#0d3b5e]/70 text-slate-400 hover:text-slate-200 hover:border-cyan-500/50 hover:bg-[#06111e]/95 shadow-[0_0_12px_rgba(0,180,255,0.06)]"
            }`}
          >
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center border transition-all ${
              activeTab === "logs"
                ? "bg-cyan-950/80 border-cyan-400 text-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.5)]"
                : "bg-[#030914]/80 border-cyan-900/40 text-slate-400"
            }`}>
              <Terminal className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-bold tracking-tight">سرویس لاگ</span>
          </button>

          {/* Item 3: Dependency Merger */}
          <button
            onClick={() => {
              setActiveTab("merger");
              scanAndMergeDeps(false);
            }}
            className={`w-28 sm:w-32 py-3.5 px-2 rounded-2xl flex flex-col items-center justify-center gap-2 text-center transition-all duration-300 backdrop-blur-md ${
              activeTab === "merger"
                ? "bg-[#06111e]/95 border-2 border-cyan-400 text-cyan-300 shadow-[0_0_25px_rgba(6,182,212,0.45)] scale-[1.02]"
                : "bg-[#06111e]/80 border border-[#0d3b5e]/70 text-slate-400 hover:text-slate-200 hover:border-cyan-500/50 hover:bg-[#06111e]/95 shadow-[0_0_12px_rgba(0,180,255,0.06)]"
            }`}
          >
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center border transition-all ${
              activeTab === "merger"
                ? "bg-cyan-950/80 border-cyan-400 text-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.5)]"
                : "bg-[#030914]/80 border-cyan-900/40 text-slate-400"
            }`}>
              <Package className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-bold tracking-tight">ادغام دپندنسی</span>
          </button>
        </div>

        {/* Center Content Workspace Area (Expands up to top) */}
        <div className="flex-1 min-w-0 w-full order-3 lg:order-2">

        {/* Tab Contents */}
        <AnimatePresence mode="wait">
          {activeTab === "overview" && (
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.2 }}
              className="w-full flex flex-col justify-center my-auto min-h-[62vh]"
            >
              {(() => {
                const runningCount = apps.filter(a => a.status === "RUNNING").length;
                const crashedCount = apps.filter(a => a.status === "CRASHED").length;
                const hasCrashLog = apps.some(a => a.restarts > 0);
                
                let coreStatus: CoreStatus = "online";
                if (crashedCount > 0) coreStatus = "error";
                else if (apps.length === 0 || runningCount === 0) coreStatus = "offline";
                else if (runningCount < apps.length || hasCrashLog) coreStatus = "warning";
                else coreStatus = "online";

                const PAGE_SIZE = 4;
                const totalPages = Math.max(1, Math.ceil(apps.length / PAGE_SIZE));
                const safePage = Math.min(overviewPage, totalPages - 1);
                const currentApps = apps.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

                // Slot 0: Top-Left (Cyan)
                // Slot 1: Top-Right (Blue/Sky)
                // Slot 2: Bottom-Left (Purple)
                // Slot 3: Bottom-Right (Emerald)
                const slotThemes = [
                  {
                    border: "border-cyan-500/70 hover:border-cyan-400 shadow-[0_0_25px_rgba(6,182,212,0.2)]",
                    accent: "text-cyan-400",
                    barGradient: "from-cyan-600 via-cyan-400 to-cyan-300",
                    barShadow: "shadow-[0_0_8px_rgba(6,182,212,0.6)]",
                    badge: "bg-cyan-950/60 text-cyan-300 border-cyan-800/60",
                    glowDot: "#06b6d4"
                  },
                  {
                    border: "border-sky-500/70 hover:border-sky-400 shadow-[0_0_25px_rgba(14,165,233,0.2)]",
                    accent: "text-sky-400",
                    barGradient: "from-blue-600 via-sky-400 to-sky-300",
                    barShadow: "shadow-[0_0_8px_rgba(14,165,233,0.6)]",
                    badge: "bg-blue-950/60 text-sky-300 border-sky-800/60",
                    glowDot: "#0ea5e9"
                  },
                  {
                    border: "border-purple-500/70 hover:border-purple-400 shadow-[0_0_25px_rgba(168,85,247,0.2)]",
                    accent: "text-purple-400",
                    barGradient: "from-purple-600 via-purple-400 to-purple-300",
                    barShadow: "shadow-[0_0_8px_rgba(168,85,247,0.6)]",
                    badge: "bg-purple-950/60 text-purple-300 border-purple-800/60",
                    glowDot: "#a855f7"
                  },
                  {
                    border: "border-emerald-500/70 hover:border-emerald-400 shadow-[0_0_25px_rgba(16,185,129,0.2)]",
                    accent: "text-emerald-400",
                    barGradient: "from-emerald-600 via-emerald-400 to-emerald-300",
                    barShadow: "shadow-[0_0_8px_rgba(16,185,129,0.6)]",
                    badge: "bg-emerald-950/60 text-emerald-300 border-emerald-800/60",
                    glowDot: "#10b981"
                  }
                ];

                const crashedTheme = {
                  border: "border-orange-500/80 hover:border-orange-400 shadow-[0_0_28px_rgba(249,115,22,0.35)]",
                  accent: "text-orange-400",
                  barGradient: "from-orange-600 via-amber-400 to-amber-300",
                  barShadow: "shadow-[0_0_8px_rgba(249,115,22,0.6)]",
                  badge: "bg-orange-950/60 text-orange-300 border-orange-800/60",
                  glowDot: "#f97316"
                };

                const renderCard = (app: AppState, slotIdx: number) => {
                  const theme = app.status === "CRASHED" ? crashedTheme : slotThemes[slotIdx % slotThemes.length];

                  return (
                    <div key={app.id} className="relative rounded-2xl group overflow-hidden p-[1.5px] transition-all duration-300 flex flex-col justify-between">
                      {/* Normal border layer (shadow and color) */}
                      <div className={`absolute inset-0 rounded-2xl border ${theme.border} transition-colors duration-300 pointer-events-none group-hover:border-transparent group-hover:shadow-none`} />
                      
                      {/* Rotating glow border on hover */}
                      <div 
                        className="absolute -inset-[150%] opacity-0 group-hover:opacity-100 transition-opacity duration-500 animate-[spin_2.5s_linear_infinite] pointer-events-none"
                        style={{ 
                          background: `conic-gradient(from 0deg at 50% 50%, transparent 0%, transparent 65%, ${theme.glowDot} 100%)`
                        }}
                      />
                      
                      {/* Inner Card Content */}
                      <div className="relative z-10 bg-[#06111e]/95 backdrop-blur-md p-4 rounded-[15px] flex flex-col justify-between gap-3 h-full overflow-hidden">
                      {/* Ambient corner glow */}
                      <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-xl pointer-events-none group-hover:bg-cyan-500/10 transition-all" />

                      {/* Header Line: PID, Uptime & Status */}
                      <div className="flex justify-between items-center text-[10px] font-mono">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-slate-400 uppercase tracking-wider font-semibold">
                            PID: {app.pid || "OFFLINE"}
                          </span>
                          {app.status === "RUNNING" && app.uptime > 0 && (
                            <span
                              className="text-cyan-300 bg-cyan-950/70 border border-cyan-700/50 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-tight shadow-[0_0_6px_rgba(6,182,212,0.25)]"
                              title={`Uptime: ${formatUptime(app.uptime)}`}
                            >
                              {formatUptime(app.uptime)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider">
                          <span
                            className={`${
                              app.status === "RUNNING"
                                ? "text-emerald-400 drop-shadow-[0_0_6px_rgba(52,211,153,0.8)]"
                                : app.status === "CRASHED"
                                ? "text-rose-500 drop-shadow-[0_0_6px_rgba(244,63,94,0.8)]"
                                : "text-slate-400"
                            }`}
                          >
                            {app.status === "RUNNING" ? "ACTIVE" : app.status === "CRASHED" ? "CRASHED" : app.status === "BUILDING" ? "BUILDING" : "STOPPED"}
                          </span>
                          <span
                            className={`w-2 h-2 rounded-full ${
                              app.status === "RUNNING"
                                ? "bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse"
                                : app.status === "CRASHED"
                                ? "bg-rose-500 shadow-[0_0_8px_#f43f5e] animate-ping"
                                : "bg-slate-600"
                            }`}
                          />
                        </div>
                      </div>

                      {/* App Name, Badges & Path */}
                      <div className="text-center py-0.5">
                        <div className="flex items-center justify-center gap-2 flex-wrap mb-1">
                          <h3 className="text-base font-extrabold text-white tracking-wide">
                            {app.name}
                          </h3>
                          <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border uppercase ${
                            app.type === "backend"
                              ? "bg-blue-950/70 text-blue-300 border-blue-700/60 shadow-[0_0_6px_rgba(59,130,246,0.3)]"
                              : "bg-cyan-950/70 text-cyan-300 border-cyan-700/60 shadow-[0_0_6px_rgba(6,182,212,0.3)]"
                          }`}>
                            {app.type === "backend" ? "API" : "STATIC"}
                          </span>
                          {app.version && (
                            <span className="text-[9px] font-mono bg-slate-900/80 text-slate-300 border border-slate-700/60 px-1 py-0.5 rounded">
                              v{app.version}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-500 font-mono break-all">{app.path}</p>
                      </div>

                      {/* Stats 3-column Box */}
                      <div className="grid grid-cols-3 gap-1 bg-[#030914]/80 border border-[#0d3b5e]/60 py-2 px-2 rounded-xl font-mono text-center">
                        <div>
                          <div className="text-slate-500 text-[8px] uppercase font-bold tracking-wider mb-0.5">TYPE</div>
                          <div className="text-white font-bold text-[10px] uppercase">{app.type}</div>
                        </div>
                        <div className="border-x border-[#0d3b5e]/60">
                          <div className="text-slate-500 text-[8px] uppercase font-bold tracking-wider mb-0.5">RESTARTS</div>
                          <div className={`font-bold text-[11px] ${app.restarts > 0 ? "text-rose-400 font-black drop-shadow-[0_0_4px_rgba(244,63,94,0.6)]" : "text-slate-300"}`}>
                            {app.restarts}
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-500 text-[8px] uppercase font-bold tracking-wider mb-0.5">PORT</div>
                          <div className="text-white font-bold text-[10px]">{app.port}</div>
                        </div>
                      </div>

                      {/* Meters & Progress Bars */}
                      <div className="space-y-2 font-mono text-[10px] py-0.5">
                        {/* CPU LOAD */}
                        <div className="flex items-center gap-2">
                          <span className="text-emerald-400 font-bold w-12 text-left">{app.cpu}%</span>
                          <div className="flex-1 h-1.5 bg-[#030914] border border-cyan-950/90 rounded-full overflow-hidden p-[0.5px]">
                            <div
                              className={`h-full bg-gradient-to-r ${theme.barGradient} rounded-full transition-all duration-700 ${theme.barShadow}`}
                              style={{ width: `${Math.min(100, Math.max(3, app.cpu * 8))}%` }}
                            />
                          </div>
                          <span className="text-slate-400 uppercase font-bold tracking-wider w-16 text-right text-[9px]">CPU LOAD</span>
                        </div>

                        {/* MEMORY */}
                        <div className="flex items-center gap-2">
                          <span className="text-cyan-400 font-bold w-14 text-left whitespace-nowrap">MB {app.memory}</span>
                          <div className="flex-1 h-1.5 bg-[#030914] border border-cyan-950/90 rounded-full overflow-hidden p-[0.5px]">
                            <div
                              className="h-full bg-gradient-to-r from-blue-600 via-cyan-500 to-cyan-300 rounded-full transition-all duration-700 shadow-[0_0_8px_rgba(6,182,212,0.6)]"
                              style={{ width: `${Math.min(100, Math.max(5, (app.memory / 60) * 100))}%` }}
                            />
                          </div>
                          <span className="text-slate-400 uppercase font-bold tracking-wider w-16 text-right text-[9px]">MEMORY</span>
                        </div>
                      </div>

                      {/* Bottom Action Controls */}
                      <div className="flex items-center gap-2 pt-2 border-t border-[#0d3b5e]/40 font-mono">
                        <button
                          disabled={app.status !== "RUNNING"}
                          onClick={() => simulateCrash(app.id)}
                          className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition border ${
                            app.status === "RUNNING"
                              ? "bg-rose-950/50 border-rose-500/70 text-rose-400 hover:bg-rose-900/60 shadow-[0_0_12px_rgba(244,63,94,0.35)] active:scale-95 cursor-pointer"
                              : "bg-slate-900/40 text-slate-600 border-slate-800 cursor-not-allowed opacity-50"
                          }`}
                          title="شبیه‌سازی کرش پروسس"
                        >
                          CRASH
                        </button>

                        <button
                          onClick={() => {
                            setSelectedAppId(app.id);
                            setActiveTab("logs");
                          }}
                          className="px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider bg-[#030914]/90 border border-cyan-900/60 hover:border-cyan-500/60 text-slate-300 hover:text-cyan-300 transition"
                          title="View Live Logs"
                        >
                          LOGS
                        </button>

                        <button
                          onClick={() => triggerAction(app.id, "restart")}
                          className="px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider bg-[#030914]/90 border border-cyan-900/60 hover:border-cyan-500/60 text-slate-300 hover:text-cyan-300 transition"
                          title="Restart Process"
                        >
                          RESTART
                        </button>

                        {app.status === "RUNNING" ? (
                          <button
                            onClick={() => triggerAction(app.id, "stop")}
                            className="flex-1 bg-[#030914]/90 border border-slate-700 hover:border-slate-500 text-slate-300 hover:text-white text-[10px] font-bold uppercase py-1.5 px-3 rounded-lg tracking-wider transition text-center"
                          >
                            STOP
                          </button>
                        ) : (
                          <button
                            onClick={() => triggerAction(app.id, "start")}
                            className="flex-1 bg-emerald-950/60 border border-emerald-500/60 hover:bg-emerald-900/60 text-emerald-400 text-[10px] font-bold uppercase py-1.5 px-3 rounded-lg tracking-wider shadow-[0_0_12px_rgba(16,185,129,0.35)] transition text-center"
                          >
                            START
                          </button>
                        )}
                      </div>
                      </div>
                    </div>
                  );
                };

                const renderPlaceholderSlot = (slotIdx: number, slotName: string) => (
                  <div
                    key={`slot-ph-${slotIdx}`}
                    className="bg-[#06111e]/30 border border-dashed border-[#0d3b5e]/40 p-5 rounded-2xl min-h-[260px] flex flex-col items-center justify-center text-center text-slate-500 gap-2 backdrop-blur-sm"
                  >
                    <div className="w-10 h-10 rounded-xl bg-[#030914]/60 border border-cyan-950/60 flex items-center justify-center text-slate-600">
                      <Server className="w-5 h-5 opacity-30" />
                    </div>
                    <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-slate-500">
                      درگاه سرویس {slotName}
                    </span>
                    <span className="text-[10px] text-slate-600">آماده اتصال خودکار در پوشه apps/</span>
                  </div>
                );

                return (
                  <div className="grid grid-cols-1 lg:grid-cols-[1fr_310px_1fr] items-center gap-5 w-full max-w-[1500px] mx-auto relative z-0" dir="ltr">
                    {/* Left Column: Slot 0 (Top-Left) and Slot 2 (Bottom-Left) */}
                    <div className="flex flex-col gap-5 relative z-10">
                      {currentApps[0] ? renderCard(currentApps[0], 0) : renderPlaceholderSlot(0, "۱ (چپ بالا)")}
                      {currentApps[2] ? renderCard(currentApps[2], 2) : renderPlaceholderSlot(2, "۳ (چپ پایین)")}
                    </div>

                    {/* Center Column: Live Animated BAS Core with SVG & Status Glow + Pagination */}
                    <div className="flex flex-col items-center justify-center my-auto py-2 order-first lg:order-none relative z-0">
                      <BasCentralCore
                        status={coreStatus}
                        totalApps={apps.length}
                        activeApps={runningCount}
                        crashedApps={crashedCount}
                        onStateChange={(tension, stabilized) => {
                          setCoreTension(tension);
                          setCoreStabilized(stabilized);
                        }}
                        onClick={() => {
                          playClickSound();
                          setOverviewPage(p => {
                            const tot = Math.max(1, Math.ceil(apps.length / PAGE_SIZE));
                            return (p + 1) >= tot ? 0 : p + 1;
                          });
                        }}
                        paginationText={`${safePage * PAGE_SIZE}/${Math.min((safePage + 1) * PAGE_SIZE, apps.length)} (${apps.length})`}
                      />

                      {/* Pagination Controls / Page Switcher */}
                      {totalPages > 1 && (
                        <div className="flex items-center gap-2 mt-4 px-3.5 py-1.5 rounded-xl bg-[#06111e]/90 border border-[#0d3b5e]/80 shadow-[0_0_15px_rgba(6,182,212,0.15)] font-mono">
                          <button
                            onClick={() => setOverviewPage(p => Math.max(0, p - 1))}
                            disabled={safePage === 0}
                            className="p-1 rounded text-cyan-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition"
                            title="صفحه قبل"
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </button>
                          
                          <div className="flex items-center gap-1.5 px-2">
                            {Array.from({ length: totalPages }).map((_, idx) => (
                              <button
                                key={idx}
                                onClick={() => setOverviewPage(idx)}
                                className={`w-2 h-2 rounded-full transition-all ${
                                  idx === safePage
                                    ? "bg-cyan-400 w-5 shadow-[0_0_8px_#22d3ee]"
                                    : "bg-slate-700 hover:bg-slate-500"
                                }`}
                              />
                            ))}
                          </div>

                          <span className="text-[10px] text-cyan-300 font-bold px-1">
                            {safePage + 1}/{totalPages}
                          </span>

                          <button
                            onClick={() => setOverviewPage(p => Math.min(totalPages - 1, p + 1))}
                            disabled={safePage === totalPages - 1}
                            className="p-1 rounded text-cyan-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition"
                            title="صفحه بعد"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Right Column: Slot 1 (Top-Right) and Slot 3 (Bottom-Right) */}
                    <div className="flex flex-col gap-5 relative z-10">
                      {currentApps[1] ? renderCard(currentApps[1], 1) : renderPlaceholderSlot(1, "۲ (راست بالا)")}
                      {currentApps[3] ? renderCard(currentApps[3], 3) : renderPlaceholderSlot(3, "۴ (راست پایین)")}
                    </div>
                  </div>
                );
              })()}
            </motion.div>
          )}

          {activeTab === "logs" && (
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="w-full h-full flex flex-col my-auto min-h-[65vh] xl:min-h-[75vh]"
            >
              {/* Top Card: SRE Troubleshooter */}
              <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl p-6 mb-6 shadow-[0_0_30px_rgba(130,170,255,0.05)] relative overflow-hidden group flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/5 to-transparent pointer-events-none" />
                <div className="relative z-10">
                  <h3 className="text-sm font-bold text-emerald-400 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-emerald-400" />
                    عیب‌یاب هوشمند جمنی
                  </h3>
                  <p className="text-[11px] text-[#c0caf5]/70 mt-1 max-w-2xl">
                    در صورت بروز خطا یا رفتارهای غیرمنتظره در سرویس‌ها، لاگ‌های لایو را با کلید بومی هوش مصنوعی تحلیل کرده و راه‌حل بگیرید.
                  </p>
                </div>
                
                <div className="relative z-10">
                  {selectedAppId ? (
                    <button
                      onClick={triggerAiAnalysis}
                      disabled={isAnalyzing}
                      className="flex items-center justify-center gap-1.5 bg-[#1e2030] border border-[#82aaff]/30 hover:bg-emerald-500 hover:text-[#1a1b26] text-emerald-400 font-mono font-bold py-2 px-4 rounded-lg text-[10px] transition-all duration-300 shadow-[0_0_15px_rgba(16,185,129,0.1)] hover:shadow-[0_0_20px_rgba(16,185,129,0.4)] disabled:opacity-50"
                    >
                      {isAnalyzing ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          در حال فکر کردن...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3.5 h-3.5" />
                          تحلیل لاگ‌ها با AI
                        </>
                      )}
                    </button>
                  ) : (
                    <div className="text-[10px] text-[#c0caf5]/50 border border-[#82aaff]/20 bg-[#0a101d]/50 px-3 py-1.5 rounded-lg font-mono">
                      برای تحلیل، ابتدا یک سرویس انتخاب کنید
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full flex-1"
            >
              {/* App list Sidebar */}
              <div className="lg:col-span-3 space-y-3">
                <h3 className="font-bold text-xs uppercase text-slate-500 tracking-wider pr-1">انتخاب سرویس برای مشاهده لاگ</h3>
                <div className="space-y-1.5">
                  {apps.map((app) => (
                    <button
                      key={app.id}
                      onClick={() => setSelectedAppId(app.id)}
                      className={`w-full text-right p-3 rounded-2xl border flex items-center justify-between transition-all duration-300 text-xs ${
                        selectedAppId === app.id
                          ? "bg-[#050b14]/80 backdrop-blur-2xl border-[#82aaff]/50 text-white shadow-[0_0_15px_rgba(130,170,255,0.1)]"
                          : "bg-[#06111e]/85 backdrop-blur-md border-[#0d3b5e]/70 hover:border-[#145388] text-slate-400"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full ${
                          app.status === "RUNNING" ? "bg-emerald-500 animate-pulse" :
                          app.status === "CRASHED" ? "bg-red-500 animate-bounce" : "bg-slate-600"
                        }`} />
                        <span className="font-bold">{app.name}</span>
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                    </button>
                  ))}
                </div>

                
              </div>

              {/* Logs terminal & AI outputs */}
              <div className={isLogsFullScreen ? "fixed inset-0 z-50 bg-[#050b14]/90 backdrop-blur-3xl flex flex-col p-4" : "lg:col-span-9 space-y-4"}>
                <div className={isLogsFullScreen ? "border border-[#82aaff]/30 rounded-2xl overflow-hidden flex flex-col flex-1 shadow-[0_0_30px_rgba(130,170,255,0.05)] bg-[#050b14]/60 backdrop-blur-2xl relative" : "bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl overflow-hidden flex flex-col h-[500px] shadow-[0_0_30px_rgba(130,170,255,0.05)] relative group"}>
                  <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent pointer-events-none" />

                  {/* Top Bar */}
                  <div className="flex justify-between items-center pt-3 px-3 h-12 flex-wrap sm:flex-nowrap border-b border-[#82aaff]/10" dir="ltr">
                    {/* Left Toolbar */}
                    <div className="flex items-center gap-2 h-6 z-10 sm:mt-0 mt-2">
                      {/* Filter */}
                      <div className="relative">
                        <Search className="w-3 h-3 text-[#c0caf5]/70 absolute left-2 top-1.5" />
                        <input
                          type="text"
                          placeholder="...search"
                          value={logsFilter}
                          onChange={(e) => setLogsFilter(e.target.value)}
                          className="bg-[#1e2030] border border-[#82aaff]/20 text-[#c0caf5] rounded-md px-2 pl-7 py-0.5 text-[10px] focus:outline-none focus:border-[#82aaff]/60 font-mono w-24 sm:w-32 transition-all h-6 shadow-sm"
                        />
                      </div>
                      <button onClick={() => setIsLogsFullScreen(!isLogsFullScreen)} className="bg-[#1e2030] hover:bg-[#82aaff] hover:text-[#1a1b26] text-[#c0caf5] text-[10px] font-mono font-bold px-2.5 py-1 rounded-md border border-[#82aaff]/20 transition-all flex items-center gap-1.5 shadow-sm">
                        full <Settings className="w-3 h-3" />
                      </button>
                      <button onClick={() => { setIsAutoScrollEnabled(true); logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }} className="bg-[#1e2030] hover:bg-[#82aaff] hover:text-[#1a1b26] text-[#c0caf5] text-[10px] font-mono font-bold px-2.5 py-1 rounded-md border border-[#82aaff]/20 transition-all flex items-center gap-1.5 shadow-sm">
                        scroll ↓
                      </button>
                      <button onClick={() => setIsLogsPaused(!isLogsPaused)} className="bg-[#1e2030] hover:bg-[#82aaff] hover:text-[#1a1b26] text-[#c0caf5] text-[10px] font-mono font-bold px-2.5 py-1 rounded-md border border-[#82aaff]/20 transition-all flex items-center gap-1.5 shadow-sm">
                        {isLogsPaused ? "resume" : "pause"} {isLogsPaused ? <Play className="w-3 h-3" /> : <Square className="w-3 h-3" />}
                      </button>
                      <button onClick={() => clearLogs(selectedAppId)} className="bg-[#1e2030] hover:bg-[#82aaff] hover:text-[#1a1b26] text-[#c0caf5] text-[10px] font-mono font-bold px-2.5 py-1 rounded-md border border-[#82aaff]/20 transition-all flex items-center gap-1.5 shadow-sm">
                        clear <AlertTriangle className="w-3 h-3" />
                      </button>
                    </div>

                    
                  </div>

                  {/* Console Log output */}
                  <div 
                    className="flex-1 p-6 overflow-y-auto font-mono text-[11px] space-y-1 selection:bg-emerald-500 selection:text-black z-10"
                    dir="ltr"
                    onScroll={handleLogsScroll}
                  >
                    {logs.length === 0 ? (
                      <div className="text-[#c0caf5]/50 flex items-center gap-2">
                         <span className="text-[#82aaff] font-bold">~</span> در انتظار دریافت لاگ‌های سیستمی پروسس...
                      </div>
                    ) : (
                      logs
                        .filter((log) => log.toLowerCase().includes(logsFilter.toLowerCase()))
                        .map((log, index) => {
                          const isStderr = log.includes("[STDERR]") || log.includes("[FATAL]") || log.includes("[ERROR]");
                          const isSuccess = log.includes("[SUCCESS]") || log.includes("[SMS SUCCESS]");
                          const isSystem = log.includes("[SYSTEM]") || log.includes("[SMS API]");

                          return (
                            <div 
                              key={index} 
                              className={`leading-relaxed whitespace-pre-wrap break-all flex items-start gap-2 ${
                                isStderr ? "text-rose-400" :
                                isSuccess ? "text-emerald-400" :
                                isSystem ? "text-[#82aaff]" : "text-[#c0caf5]/80"
                              }`}
                            >
                              <span className={`font-bold ${isStderr ? "text-rose-400" : "text-[#82aaff]"}`}>~</span>
                              <div>{log}</div>
                            </div>
                          );
                        })
                    )}
                    <div ref={logsEndRef} />
                  </div>
                </div>

                {/* AI Troubleshooting panel content */}
                {aiAnalysis && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl p-6 mt-6 shadow-[0_0_30px_rgba(130,170,255,0.05)] relative overflow-hidden group"
                  >
                    <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent pointer-events-none" />
                    
                    <div className="flex items-center justify-between border-b border-[#82aaff]/20 pb-4 mb-4 relative z-10">
                      <div className="flex items-center gap-2 text-emerald-400">
                        <Sparkles className="w-4 h-4" />
                        <h3 className="font-bold text-[11px] uppercase tracking-wider font-mono">AI Deep Analysis Output</h3>
                      </div>
                      <div className="bg-[#1e2030] text-[#c0caf5] flex items-center px-2 py-1 font-mono text-[9px] font-bold rounded-sm border border-[#82aaff]/20">
                        gemini-pro-agent
                      </div>
                    </div>

                    <div className="text-[12px] leading-relaxed text-[#c0caf5]/90 whitespace-pre-wrap font-mono relative z-10" dir="rtl">
                      {aiAnalysis}
                    </div>
                  </motion.div>
                )}
              </div>
              </div>
            </motion.div>
          )}

          {activeTab === "git" && (
            <motion.div
              key="git"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="w-full h-full flex flex-col my-auto min-h-[65vh] xl:min-h-[75vh]"
            >
              {/* Top Card for Text */}
              <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl p-6 mb-6 shadow-[0_0_30px_rgba(130,170,255,0.05)] relative overflow-hidden group" dir="rtl">
                <div className="absolute inset-0 bg-gradient-to-r from-[#82aaff]/5 to-transparent pointer-events-none" />
                <h3 className="text-sm font-bold text-cyan-300 flex items-center gap-2 relative z-10">
                  <GitBranch className="w-4 h-4 text-[#82aaff]" />
                  سیستم به‌روزرسانی و همگام‌سازی ابری
                </h3>
                <p className="text-[11px] text-[#c0caf5]/70 mt-1 relative z-10">
                  جهت همگام‌سازی کدها از مخزن (Repository)، یک کلمه کلیدی از نام سرویس را وارد کرده و فرآیند واکشی را آغاز کنید.
                </p>
              </div>

              {/* Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full w-full max-w-[1500px] mx-auto flex-1">
                {/* Pane 1: Control (Right side) */}
                <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl overflow-hidden flex flex-col h-full shadow-[0_0_30px_rgba(130,170,255,0.05)] relative group" dir="rtl">
                  <div className="absolute inset-0 bg-gradient-to-br from-[#82aaff]/5 to-transparent pointer-events-none" />
                  
                  {/* Top Bar */}
                  <div className="flex justify-between items-center pt-3 px-3 h-12 border-b border-[#82aaff]/10">
                    <div className="flex items-stretch h-6 filter drop-shadow-md">
                      <div className="bg-[#82aaff] text-[#1a1b26] flex items-center px-4 text-[11px] font-bold rounded-r-sm z-10">
                        کنترلر بروزرسانی
                      </div>
                      <div className="w-0 h-0 border-y-[12px] border-y-transparent border-r-[12px] border-r-[#82aaff] relative z-20"></div>
                    </div>
                  </div>

                  {/* Content */}
                  <div className="flex-1 p-6 text-sm overflow-y-auto z-10 flex flex-col justify-center space-y-6">
                    <div className="space-y-3">
                      <label className="flex items-center gap-2 text-[#c0caf5] font-bold text-xs">
                        فیلتر نام سرویس (اختیاری)
                      </label>
                      <input
                        type="text"
                        value={gitKeyword}
                        onChange={(e) => setGitKeyword(e.target.value)}
                        placeholder="مثلا: auth یا api..."
                        disabled={gitRunning}
                        className="w-full bg-[#0a101d]/50 border border-[#82aaff]/20 rounded-xl p-3.5 text-[#c0caf5] focus:outline-none focus:border-[#82aaff]/60 focus:ring-1 focus:ring-[#82aaff]/30 transition-all font-mono text-left disabled:opacity-50 text-[13px]"
                        dir="ltr"
                      />
                    </div>
                    
                    <button
                      onClick={runGitUpdate}
                      disabled={gitRunning}
                      className="w-full py-4 px-4 bg-[#1e2030] hover:bg-[#82aaff] hover:text-[#1a1b26] text-[#c0caf5] rounded-xl text-[13px] font-bold transition-all border border-[#82aaff]/20 shadow-[0_0_10px_rgba(130,170,255,0.05)] hover:shadow-[0_0_15px_rgba(130,170,255,0.2)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {gitRunning ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          در حال واکشی اطلاعات...
                        </>
                      ) : (
                        <>
                          <GitBranch className="w-4 h-4" />
                          اجرای فرآیند بروزرسانی
                        </>
                      )}
                    </button>

                    <div className="mt-6">
                      <div className="flex justify-between text-[10px] text-[#c0caf5]/60 mb-2 font-mono" dir="ltr">
                        <span>Progress</span>
                        <span>{gitProgress}%</span>
                      </div>
                      <div className="h-1.5 w-full bg-[#0a101d]/80 rounded-full overflow-hidden border border-[#82aaff]/10">
                        <motion.div 
                          className="h-full bg-[#82aaff] shadow-[0_0_10px_rgba(130,170,255,0.5)]"
                          initial={{ width: 0 }}
                          animate={{ width: `${gitProgress}%` }}
                          transition={{ duration: 0.3 }}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Pane 2: Git Logs Terminal (Left side) */}
                <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl overflow-hidden flex flex-col h-full shadow-[0_0_30px_rgba(130,170,255,0.05)] relative group" dir="rtl">
                  <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent pointer-events-none" />
                  
                  {/* Top Bar */}
                  <div className="flex justify-between items-center pt-3 px-3 h-12 border-b border-[#82aaff]/10">
                    <div className="flex items-stretch h-6 filter drop-shadow-md shrink-0">
                      <div className="bg-emerald-500 text-[#1a1b26] flex items-center px-4 font-bold rounded-r-sm z-10 text-[11px]">
                        ترمینال وضعیت بروزرسانی
                      </div>
                      <div className="w-0 h-0 border-y-[12px] border-y-transparent border-r-[12px] border-r-emerald-500 relative z-20"></div>
                    </div>
                  </div>

                  {/* Terminal Content */}
                  <div className="flex-1 p-6 font-mono text-[11px] overflow-y-auto space-y-1 z-10 selection:bg-emerald-500 selection:text-black" dir="ltr">
                    {gitLogs.length === 0 ? (
                      <div className="text-[#c0caf5]/50 flex items-center gap-2">
                        <span className="text-[#82aaff] font-bold">~</span> Waiting for command...
                      </div>
                    ) : (
                      gitLogs.map((log, idx) => (
                        <div key={idx} className="flex items-start gap-2 text-[#c0caf5]/80 hover:text-[#c0caf5] hover:bg-[#1e2030]/30 px-1 py-0.5 rounded transition-colors break-words whitespace-pre-wrap">
                          <span className="text-emerald-400 font-bold shrink-0">&gt;</span>
                          <span className="flex-1">{log}</span>
                        </div>
                      ))
                    )}
                    <div ref={gitLogsEndRef} />
                  </div>
                </div>
              </div>
            </motion.div>
          )}
          {activeTab === "merger" && (
            <motion.div
              key="merger"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="w-full h-full flex flex-col my-auto min-h-[65vh] xl:min-h-[75vh]"
            >
              {/* Top Card for Text */}
              <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl p-6 mb-6 shadow-[0_0_30px_rgba(130,170,255,0.05)] relative overflow-hidden group" dir="rtl">
                <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/5 to-transparent pointer-events-none" />
                <h3 className="text-sm font-bold text-cyan-300 flex items-center gap-2 relative z-10">
                  <Package className="w-4 h-4 text-[#82aaff]" />
                  سیستم ادغام خودکار دپندنسی‌ها (Dependency Merger)
                </h3>
                <p className="text-[11px] text-[#c0caf5]/70 mt-1 relative z-10">
                  اسکن تمام پکیج‌جیسان‌های زیر‌پروژه‌ها در دایرکتوری <code className="bg-[#1e2030] text-[#82aaff] px-1 py-0.5 rounded mx-1 font-mono">apps/*</code> و ادغام آنها با دپندنسی‌های روت برای اشتراک‌گذاری ماژول‌ها و مصرف صفر رم.
                </p>
              </div>

              {/* Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full w-full max-w-[1500px] mx-auto flex-1">
                {/* Pane 1: Scanned Apps (Right side) */}
                <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl overflow-hidden flex flex-col h-full shadow-[0_0_30px_rgba(130,170,255,0.05)] relative group" dir="rtl">
                  <div className="absolute inset-0 bg-gradient-to-br from-[#82aaff]/5 to-transparent pointer-events-none" />
                  
                  {/* Top Bar */}
                  <div className="flex justify-between items-center pt-3 px-3 h-12 border-b border-[#82aaff]/10">
                    <div className="flex items-stretch h-6 filter drop-shadow-md">
                      <div className="bg-[#82aaff] text-[#1a1b26] flex items-center px-4 text-[11px] font-bold rounded-r-sm z-10">
                        سرویس‌های ردیابی شده
                      </div>
                      <div className="w-0 h-0 border-y-[12px] border-y-transparent border-r-[12px] border-r-[#82aaff] relative z-20"></div>
                    </div>
                  </div>

                  {/* Content */}
                  <div className="flex-1 p-6 text-sm overflow-y-auto z-10">
                    {scannedApps.length === 0 ? (
                      <div className="text-xs text-[#c0caf5]/50 py-6 text-center">درحال اسکن دایرکتوری...</div>
                    ) : (
                      <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
                        {scannedApps.map((app, idx) => (
                          <div key={idx} className="bg-[#0a101d]/50 p-4 rounded-lg border border-[#82aaff]/10">
                            <span className="font-bold text-[13px] text-emerald-400 font-mono block text-left" dir="ltr">{app.name}</span>
                            <div className="flex flex-wrap gap-1.5 mt-3" dir="ltr">
                              {Object.entries(app.dependencies).map(([dep, ver]) => (
                                <span key={dep} className="text-[10px] font-mono bg-[#1e2030] text-[#c0caf5] px-2 py-0.5 rounded-md border border-[#82aaff]/20 flex items-center gap-1.5 shadow-sm">
                                  {dep} <span className="text-[#82aaff] opacity-80">{ver}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Pane 2: Merged Dependencies (Left side) */}
                <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl overflow-hidden flex flex-col h-full shadow-[0_0_30px_rgba(130,170,255,0.05)] relative group" dir="rtl">
                  <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent pointer-events-none" />
                  
                  {/* Top Bar */}
                  <div className="flex justify-between items-center pt-3 px-3 h-12 border-b border-[#82aaff]/10">
                    <div className="flex items-stretch h-6 filter drop-shadow-md">
                      <div className="bg-emerald-500 text-[#1a1b26] flex items-center px-4 text-[11px] font-bold rounded-r-sm z-10">
                        پکیج‌های تلفیق‌شده برای روت
                      </div>
                      <div className="w-0 h-0 border-y-[12px] border-y-transparent border-r-[12px] border-r-emerald-500 relative z-20"></div>
                    </div>
                  </div>

                  {/* Content */}
                  <div className="flex-1 p-6 text-sm overflow-y-auto z-10 flex flex-col">
                    <div className="flex-1">
                      <div className="flex flex-wrap gap-2 max-h-[250px] overflow-y-auto pr-1" dir="ltr">
                        {Object.keys(mergedDeps).length === 0 ? (
                          <div className="text-xs text-[#c0caf5]/50 w-full text-center py-4 text-right" dir="rtl">پکیجی یافت نشد.</div>
                        ) : (
                          Object.entries(mergedDeps).map(([dep, ver]) => (
                            <span key={dep} className="text-[11px] font-mono bg-emerald-500/10 text-emerald-400 px-2.5 py-1 rounded-md border border-emerald-500/20 shadow-sm flex items-center gap-1.5">
                              {dep} <span className="text-emerald-400/60">{ver}</span>
                            </span>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="pt-6 mt-4 border-t border-[#82aaff]/10 space-y-4">
                      <div className="flex gap-3">
                        <button
                          onClick={() => scanAndMergeDeps(false)}
                          disabled={isMerging}
                          className="flex-1 py-2.5 px-4 bg-[#1e2030] hover:bg-[#82aaff] hover:text-[#1a1b26] text-[#c0caf5] rounded-md text-[11px] font-bold transition-all border border-[#82aaff]/20 shadow-[0_0_10px_rgba(130,170,255,0.05)] hover:shadow-[0_0_15px_rgba(130,170,255,0.2)] disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          اسکن مجدد
                        </button>
                        <button
                          onClick={() => scanAndMergeDeps(true)}
                          disabled={isMerging || Object.keys(mergedDeps).length === 0}
                          className="flex-1 py-2.5 px-4 bg-[#1e2030] hover:bg-emerald-500 hover:text-[#1a1b26] text-emerald-400 rounded-md text-[11px] font-bold transition-all border border-emerald-500/20 shadow-[0_0_10px_rgba(16,185,129,0.1)] hover:shadow-[0_0_15px_rgba(16,185,129,0.3)] disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          ادغام به روت اصلی
                        </button>
                      </div>

                      {mergeMessage && (
                        <div className="text-[11px] text-emerald-400 bg-emerald-500/10 p-3 rounded-lg border border-emerald-500/20 font-mono text-center shadow-sm">
                          {mergeMessage}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
          {activeTab === "settings" && (
            <motion.div
              key="settings"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="w-full h-full flex flex-col my-auto min-h-[65vh] xl:min-h-[75vh]"
            >
              {/* Top Card for Text */}
              <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl p-6 mb-6 shadow-[0_0_30px_rgba(130,170,255,0.05)] relative overflow-hidden group">
                <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/5 to-transparent pointer-events-none" />
                <h3 className="text-sm font-bold text-cyan-300 flex items-center gap-2 relative z-10">
                  <Sliders className="w-4 h-4 text-[#82aaff]" />
                  تنظیمات BAS و درگاه هشدار پیامک
                </h3>
                <p className="text-[11px] text-[#c0caf5]/70 mt-1 relative z-10">
                  پیکربندی سیستم هوشمند راه‌اندازی مجدد پروسس‌ها در صورت بروز خرابی، سقف دفعات تلاش، صدای هشدار و مشخصات درگاه پیامک.
                </p>
              </div>

              {/* Form Grid */}
              <form onSubmit={saveGatewaySettings} className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full w-full max-w-[1500px] mx-auto flex-1">
                
                {/* Pane 1: SMS Gateway (Right side visually due to RTL) */}
                <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl overflow-hidden flex flex-col shadow-[0_0_30px_rgba(130,170,255,0.05)] relative group" dir="rtl">
                  <div className="absolute inset-0 bg-gradient-to-br from-[#82aaff]/5 to-transparent pointer-events-none" />
                  
                  {/* Top Bar */}
                  <div className="flex justify-between items-center pt-3 px-3 h-12 border-b border-[#82aaff]/10">
                    <div className="flex items-stretch h-6 filter drop-shadow-md">
                      <div className="bg-[#82aaff] text-[#1a1b26] flex items-center px-4 font-mono text-[11px] font-bold rounded-r-sm z-10">
                        تنظیمات پیامک
                      </div>
                      <div className="w-0 h-0 border-y-[12px] border-y-transparent border-r-[12px] border-r-[#82aaff] relative z-20"></div>
                    </div>
                  </div>

                  {/* Content */}
                  <div className="flex-1 p-6 text-sm overflow-y-auto z-10 space-y-6">
                    <div className="text-[#c0caf5]/70 flex items-start gap-2 bg-[#0a101d]/50 p-3 rounded-lg border border-[#82aaff]/10">
                       <span className="text-[11px] leading-relaxed">
                         توجه: کلید امنیتی باید از طریق فایل <code className="bg-[#1e2030] text-[#82aaff] px-1 py-0.5 rounded mx-1 font-mono">.env</code> تنظیم شود. در اینجا با مقدار <code className="bg-[#1e2030] text-emerald-400 px-1 py-0.5 rounded mx-1 font-mono">jkzdlhj.</code> در زمان اجرا بارگذاری می‌شود.
                       </span>
                    </div>
                    
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-[#c0caf5] font-bold">
                        شماره پشتیبان
                      </div>
                      <div>
                        <input
                          type="text"
                          value={smsGateway.recipient}
                          onChange={(e) => setSmsGateway({ ...smsGateway, recipient: e.target.value })}
                          placeholder="09123456789"
                          className="w-full bg-[#0a101d]/50 border border-[#82aaff]/20 rounded-xl p-3 text-[#c0caf5] focus:outline-none focus:border-[#82aaff]/60 focus:ring-1 focus:ring-[#82aaff]/30 transition-all font-mono text-left"
                          dir="ltr"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Pane 2: Auto-Restart Engine (Left side visually) */}
                <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl overflow-hidden flex flex-col shadow-[0_0_30px_rgba(130,170,255,0.05)] relative group" dir="rtl">
                  <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent pointer-events-none" />
                  
                  {/* Top Bar */}
                  <div className="flex justify-between items-center pt-3 px-3 h-12 border-b border-[#82aaff]/10">
                    <div className="flex items-stretch h-6 filter drop-shadow-md">
                      <div className="bg-emerald-500 text-[#1a1b26] flex items-center px-4 font-mono text-[11px] font-bold rounded-r-sm z-10">
                        تنظیمات باس
                      </div>
                      <div className="w-0 h-0 border-y-[12px] border-y-transparent border-r-[12px] border-r-emerald-500 relative z-20"></div>
                    </div>

                    <div className="flex items-center gap-2 h-6 z-10">
                      <button type="submit" className="bg-[#1e2030] hover:bg-emerald-500 hover:text-[#1a1b26] text-emerald-400 text-[10px] font-bold px-4 py-1 rounded-md border border-emerald-500/20 transition-all shadow-[0_0_10px_rgba(16,185,129,0.1)] hover:shadow-[0_0_15px_rgba(16,185,129,0.3)]">
                        ذخیره تنظیمات
                      </button>
                    </div>
                  </div>

                  {/* Content */}
                  <div className="flex-1 p-6 text-sm overflow-y-auto space-y-6 z-10">
                    
                    {/* Alarm Sound */}
                    <div className="flex items-center justify-between border-b border-[#82aaff]/10 pb-4">
                      <div className="flex items-center gap-2 text-[#c0caf5] font-bold">
                        صدای آلارم
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={settings.soundEnabled !== false}
                          onChange={(e) => setSettings({ ...settings, soundEnabled: e.target.checked })}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-[#1e2030] border border-[#82aaff]/30 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[#c0caf5] after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500 peer-checked:border-emerald-500 peer-checked:after:bg-[#1a1b26]"></div>
                      </label>
                    </div>

                    {/* Auto-Restart Enabled */}
                    <div className="flex items-center justify-between border-b border-[#82aaff]/10 pb-4">
                      <div className="flex items-center gap-2 text-[#c0caf5] font-bold">
                        ری‌استارت اتوماتیک
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={settings.autoRestart}
                          onChange={(e) => setSettings({ ...settings, autoRestart: e.target.checked })}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-[#1e2030] border border-[#82aaff]/30 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[#c0caf5] after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500 peer-checked:border-emerald-500 peer-checked:after:bg-[#1a1b26]"></div>
                      </label>
                    </div>

                    {/* Max Restarts */}
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-[#c0caf5] font-bold">
                        حداکثر دفعات تلاش
                      </div>
                      <div>
                        <input
                          type="number"
                          value={settings.maxRestarts}
                          onChange={(e) => setSettings({ ...settings, maxRestarts: parseInt(e.target.value) })}
                          min="1"
                          max="20"
                          className="w-full bg-[#0a101d]/50 border border-[#82aaff]/20 rounded-xl p-3 text-[#c0caf5] focus:outline-none focus:border-[#82aaff]/60 focus:ring-1 focus:ring-[#82aaff]/30 transition-all text-left font-mono"
                          dir="ltr"
                        />
                      </div>
                    </div>

                    {/* Restart Delay */}
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-[#c0caf5] font-bold">
                        تاخیر شروع مجدد (میلی‌ثانیه)
                      </div>
                      <div>
                        <input
                          type="number"
                          value={settings.restartDelayMs}
                          onChange={(e) => setSettings({ ...settings, restartDelayMs: parseInt(e.target.value) })}
                          min="0"
                          step="500"
                          className="w-full bg-[#0a101d]/50 border border-[#82aaff]/20 rounded-xl p-3 text-[#c0caf5] focus:outline-none focus:border-[#82aaff]/60 focus:ring-1 focus:ring-[#82aaff]/30 transition-all text-left font-mono"
                          dir="ltr"
                        />
                      </div>
                    </div>

                  </div>
                </div>
              </form>
            </motion.div>
          )}
          
          {activeTab === "security" && (
            <motion.div
              key="security"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="w-full h-full flex flex-col my-auto min-h-[65vh] xl:min-h-[75vh]"
            >
              {/* Top Card for Text */}
              <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl p-6 mb-6 shadow-[0_0_30px_rgba(130,170,255,0.05)] relative overflow-hidden group">
                <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/5 to-transparent pointer-events-none" />
                <h3 className="text-sm font-bold text-cyan-300 flex items-center gap-2 relative z-10">
                  <ShieldAlert className="w-4 h-4 text-[#82aaff]" />
                  گزارشات امنیتی و دسترسی‌ها
                </h3>
                <p className="text-[11px] text-[#c0caf5]/70 mt-1 relative z-10">
                  مشاهده آی‌پی‌های مسدود شده و لاگ‌های دسترسی به سیستم. این پنل به صورت زنده تمامی فعالیت‌های مشکوک را ثبت و نمایش می‌دهد.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full w-full max-w-[1500px] mx-auto flex-1">
                
                {/* Pane 1: Banned IPs (Hyprland Terminal Style) */}
                <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl overflow-hidden flex flex-col h-full min-h-[500px] shadow-[0_0_30px_rgba(130,170,255,0.05)] relative group" dir="rtl">
                  {/* Subtle inner glow */}
                  <div className="absolute inset-0 bg-gradient-to-br from-[#82aaff]/5 to-transparent pointer-events-none" />
                  
                  {/* Top Bar */}
                  <div className="flex justify-between items-center pt-3 px-3 h-12 border-b border-[#82aaff]/10">
                    {/* Powerline Tabs */}
                    <div className="flex items-stretch h-6 filter drop-shadow-md">
                      <div className="bg-[#82aaff] text-[#1a1b26] flex items-center px-4 font-bold rounded-r-sm z-10 text-[11px]">
                        لیست سیاه آی‌پی‌ها
                      </div>
                      <div className="w-0 h-0 border-y-[12px] border-y-transparent border-r-[12px] border-r-[#82aaff] relative z-20"></div>
                    </div>

                    {/* Right Decor */}
                    <div className="flex items-center gap-2 h-6 z-10" dir="ltr">
                       <div className="bg-[#1e2030] text-[#c0caf5] text-[9px] font-mono font-bold px-3 py-1 rounded-sm border border-[#82aaff]/20 flex items-center gap-1.5 shadow-sm">
                         STATUS: ACTIVE <div className="w-1 h-2.5 bg-[#82aaff] animate-pulse"></div>
                       </div>
                    </div>
                  </div>

                  {/* Terminal Content */}
                  <div className="flex-1 p-6 font-mono text-xs overflow-y-auto z-10" dir="ltr">
                     {bannedIPs.length === 0 ? (
                       <div className="text-[#c0caf5]/50 flex items-center gap-2">
                         <span className="text-[#82aaff] font-bold">~</span> No blocked connections detected.
                       </div>
                     ) : (
                       <div className="space-y-4">
                         {bannedIPs.map((ipObj, idx) => (
                           <div key={idx} className="flex flex-col gap-1.5 bg-[#0a101d]/50 p-3 rounded-lg border border-[#82aaff]/10 group/ban">
                             <div className="flex items-center justify-between">
                               <div className="flex items-center gap-2 text-[#c0caf5]">
                                 <span className="text-rose-400 font-bold">root@hyprland ~ #</span> 
                                 <span className="text-[#82aaff]">deny</span> {ipObj.ip}
                               </div>
                               <button 
                                 onClick={() => handleUnban(ipObj.ip)}
                                 className="text-[#82aaff] hover:text-white bg-[#82aaff]/10 hover:bg-[#82aaff]/20 px-2 py-0.5 rounded text-[10px] font-bold transition-all opacity-0 group-hover/ban:opacity-100"
                               >
                                 UNBAN
                               </button>
                             </div>
                             <div className="text-[#c0caf5]/60 pl-4 flex items-center gap-2">
                               <div className="w-3 h-px bg-slate-700"></div>
                               <span className="text-[10px] tracking-wider uppercase">
                                 [status] {ipObj.expired ? "EXPIRED" : `BANNED UNTIL: ${new Date(ipObj.expiry).toLocaleString("fa-IR")}`}
                               </span>
                             </div>
                           </div>
                         ))}
                       </div>
                     )}
                  </div>
                </div>

                {/* Pane 2: Access Logs (Hyprland Terminal Style) */}
                <div className="bg-[#050b14]/60 backdrop-blur-2xl border border-[#82aaff]/30 rounded-2xl overflow-hidden flex flex-col h-full min-h-[500px] shadow-[0_0_30px_rgba(130,170,255,0.05)] relative group" dir="rtl">
                  {/* Subtle inner glow */}
                  <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent pointer-events-none" />
                  
                  {/* Top Bar */}
                  <div className="flex justify-between items-center pt-3 px-3 h-12 border-b border-[#82aaff]/10">
                    {/* Powerline Tabs */}
                    <div className="flex items-stretch h-6 filter drop-shadow-md">
                      <div className="bg-emerald-500 text-[#1a1b26] flex items-center px-4 font-bold rounded-r-sm z-10 text-[11px]">
                        لاگ زنده دسترسی‌ها
                      </div>
                      <div className="w-0 h-0 border-y-[12px] border-y-transparent border-r-[12px] border-r-emerald-500 relative z-20"></div>
                    </div>

                    {/* Right Decor */}
                    <div className="flex items-center gap-2 h-6 z-10" dir="ltr">
                       <div className="bg-[#1e2030] text-[#c0caf5] text-[9px] font-mono font-bold px-3 py-1 rounded-sm border border-emerald-400/20 flex items-center gap-1.5 shadow-sm">
                         MONITORING <div className="w-1 h-2.5 bg-emerald-400 animate-pulse"></div>
                       </div>
                    </div>
                  </div>

                  {/* Terminal Content */}
                  <div className="flex-1 p-6 font-mono text-[11px] overflow-y-auto space-y-2 z-10" dir="ltr">
                     {securityLogs.length === 0 ? (
                       <div className="text-[#c0caf5]/50 flex items-center gap-2">
                         <span className="text-[#82aaff] font-bold">~</span> Waiting for incoming connections...
                       </div>
                     ) : (
                        securityLogs.map((log, idx) => (
                          <div key={idx} className="flex gap-3 items-start group hover:bg-[#1e2030]/40 p-1.5 rounded transition">
                            <span className="text-[#c0caf5]/40 whitespace-nowrap">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                            <span className={`font-bold ${log.success ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {log.success ? 'ACCEPT' : 'DENY  '}
                            </span>
                            <span className="text-[#c0caf5] font-bold w-28 shrink-0">{log.ip}</span>
                            <span className="text-[#c0caf5]/70 break-words flex-1">{log.action}</span>
                          </div>
                        ))
                     )}
                  </div>
                </div>

              </div>
            </motion.div>
          )}
        </AnimatePresence>
        </div>

        {/* Left Vertical Navigation (3 Items Centered in Height) */}
        <div className="flex flex-row lg:flex-col gap-3 justify-center items-center shrink-0 order-2 lg:order-3 self-center my-auto">
          {/* Item 4: Git Sync */}
          <button
            onClick={() => setActiveTab("git")}
            className={`w-28 sm:w-32 py-3.5 px-2 rounded-2xl flex flex-col items-center justify-center gap-2 text-center transition-all duration-300 backdrop-blur-md ${
              activeTab === "git"
                ? "bg-[#06111e]/95 border-2 border-cyan-400 text-cyan-300 shadow-[0_0_25px_rgba(6,182,212,0.45)] scale-[1.02]"
                : "bg-[#06111e]/80 border border-[#0d3b5e]/70 text-slate-400 hover:text-slate-200 hover:border-cyan-500/50 hover:bg-[#06111e]/95 shadow-[0_0_12px_rgba(0,180,255,0.06)]"
            }`}
          >
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center border transition-all ${
              activeTab === "git"
                ? "bg-cyan-950/80 border-cyan-400 text-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.5)]"
                : "bg-[#030914]/80 border-cyan-900/40 text-slate-400"
            }`}>
              <GitBranch className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-bold tracking-tight">به‌روزرسانی</span>
          </button>

          {/* Item 5: SMS & Crash Alerts */}
          <button
            onClick={() => setActiveTab("settings")}
            className={`w-28 sm:w-32 py-3.5 px-2 rounded-2xl flex flex-col items-center justify-center gap-2 text-center transition-all duration-300 backdrop-blur-md ${
              activeTab === "settings"
                ? "bg-[#06111e]/95 border-2 border-cyan-400 text-cyan-300 shadow-[0_0_25px_rgba(6,182,212,0.45)] scale-[1.02]"
                : "bg-[#06111e]/80 border border-[#0d3b5e]/70 text-slate-400 hover:text-slate-200 hover:border-cyan-500/50 hover:bg-[#06111e]/95 shadow-[0_0_12px_rgba(0,180,255,0.06)]"
            }`}
          >
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center border transition-all ${
              activeTab === "settings"
                ? "bg-cyan-950/80 border-cyan-400 text-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.5)]"
                : "bg-[#030914]/80 border-cyan-900/40 text-slate-400"
            }`}>
              <Settings className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-bold tracking-tight">تنظیمات</span>
          </button>

          {/* Item 6: Security */}
          <button
            onClick={() => setActiveTab("security")}
            className={`w-28 sm:w-32 py-3.5 px-2 rounded-2xl flex flex-col items-center justify-center gap-2 text-center transition-all duration-300 backdrop-blur-md relative ${
              activeTab === "security"
                ? "bg-[#06111e]/95 border-2 border-cyan-400 text-cyan-300 shadow-[0_0_25px_rgba(6,182,212,0.45)] scale-[1.02]"
                : (bannedIPs.length > lastSeenBannedCount)
                ? "bg-rose-950/30 border-2 border-rose-500 text-rose-300 hover:text-rose-200 hover:bg-rose-950/40 shadow-[0_0_20px_rgba(244,63,94,0.4)] animate-pulse"
                : "bg-[#06111e]/80 border border-[#0d3b5e]/70 text-slate-400 hover:text-slate-200 hover:border-cyan-500/50 hover:bg-[#06111e]/95 shadow-[0_0_12px_rgba(0,180,255,0.06)]"
            }`}
          >
            {(bannedIPs.length > lastSeenBannedCount) && (
              <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-4 w-4 bg-rose-500 border-2 border-[#06111e]"></span>
              </span>
            )}
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center border transition-all ${
              activeTab === "security"
                ? "bg-cyan-950/80 border-cyan-400 text-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.5)]"
                : (bannedIPs.length > lastSeenBannedCount)
                ? "bg-rose-900/50 border-rose-400 text-rose-400 shadow-[0_0_15px_rgba(244,63,94,0.5)]"
                : "bg-[#030914]/80 border-cyan-900/40 text-slate-400"
            }`}>
              <ShieldAlert className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-bold tracking-tight">گزارشات امنیتی</span>
          </button>
        </div>
      </main>

      {/* Aesthetic Bento & Futuristic HUD Footer */}
      <footer className="mt-12 space-y-4 font-sans">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 xl:grid-cols-12 gap-3" dir="rtl">
          
          {/* Card 4 (Right on RTL): Date & Clock (xl:col-span-3) */}
          <div className="xl:col-span-3 bg-[#06111e]/85 backdrop-blur-md border border-[#0d3b5e]/70 rounded-xl p-3.5 flex items-center justify-between shadow-[0_0_20px_rgba(0,180,255,0.07)] hover:border-[#145388] transition-all">
            <div className="space-y-0.5">
              <div className="text-[11px] text-cyan-200/90 font-medium">
                {currentDate || "شنبه، ۲۹ دی ۱۴۰۲"}
              </div>
              <div className="text-2xl font-black font-mono text-cyan-400 tracking-wider drop-shadow-[0_0_10px_rgba(6,182,212,0.8)]" dir="ltr">
                {currentTime || "00:00:00"}
              </div>
            </div>
            <div className="w-11 h-11 rounded-full border border-cyan-500/50 bg-cyan-950/40 flex items-center justify-center shadow-[0_0_15px_rgba(6,182,212,0.35)] shrink-0 relative">
              <div className="absolute inset-0 rounded-full border border-cyan-400/20 animate-ping opacity-30"></div>
              <Clock className="w-6 h-6 text-cyan-400" />
            </div>
          </div>

          {/* Card 3: System Resources (xl:col-span-3) */}
          <div className="xl:col-span-3 bg-[#06111e]/85 backdrop-blur-md border border-[#0d3b5e]/70 rounded-xl p-3.5 flex flex-col justify-between gap-2 shadow-[0_0_20px_rgba(0,180,255,0.07)] hover:border-[#145388] transition-all">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-slate-200">منابع سیستم</span>
              <span className="text-[9px] font-mono text-cyan-400/80 uppercase">SYSTEM RESOURCES</span>
            </div>
            <div className="space-y-2">
              {/* CPU */}
              <div className="flex items-center gap-2 text-[10px] font-mono" dir="ltr">
                <span className="text-slate-400 w-8 font-bold">CPU</span>
                <div className="flex-1 h-2 bg-slate-900/90 rounded-full overflow-hidden border border-cyan-950/80 p-[1px]">
                  <div
                    className="h-full bg-gradient-to-r from-cyan-600 to-cyan-400 rounded-full transition-all duration-500 shadow-[0_0_8px_rgba(6,182,212,0.7)]"
                    style={{ width: `${Math.min(100, Math.max(5, systemMetrics.totalCpu || 0))}%` }}
                  />
                </div>
                <span className="text-amber-300 font-bold w-12 text-right">{systemMetrics.totalCpu || 0}%</span>
              </div>
              {/* RAM */}
              <div className="flex items-center gap-2 text-[10px] font-mono" dir="ltr">
                <span className="text-slate-400 w-8 font-bold">RAM</span>
                <div className="flex-1 h-2 bg-slate-900/90 rounded-full overflow-hidden border border-cyan-950/80 p-[1px]">
                  <div
                    className="h-full bg-gradient-to-r from-blue-600 via-cyan-500 to-cyan-400 rounded-full transition-all duration-500 shadow-[0_0_8px_rgba(6,182,212,0.7)]"
                    style={{ width: `${Math.min(100, Math.max(8, Math.round(((systemMetrics.totalMemory || 0) / 1024) * 100)))}%` }}
                  />
                </div>
                <span className="text-amber-300 font-bold w-16 text-right whitespace-nowrap">{systemMetrics.totalMemory || 0} MB</span>
              </div>
            </div>
          </div>

          {/* Card 2: Services Metrics (xl:col-span-4) */}
          <div className="xl:col-span-4 bg-[#06111e]/85 backdrop-blur-md border border-[#0d3b5e]/70 rounded-xl p-3 flex items-center justify-between gap-1 shadow-[0_0_20px_rgba(0,180,255,0.07)] hover:border-[#145388] transition-all">
            
            {/* Active Services */}
            <div className="flex-1 flex items-center gap-2 px-1">
              <div className="w-8 h-8 rounded-lg bg-cyan-950/60 border border-cyan-500/50 flex items-center justify-center shadow-[0_0_12px_rgba(6,182,212,0.35)] shrink-0">
                <Activity className="w-4 h-4 text-cyan-400" />
              </div>
              <div className="text-right flex flex-col justify-center">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-base font-black font-mono text-cyan-400">{apps.filter(a => a.status === "RUNNING").length}</span>
                  <span className="text-[11px] font-bold text-slate-200 whitespace-nowrap">فعال</span>
                </div>
              </div>
            </div>

            <div className="w-[1px] h-8 bg-cyan-900/40 shrink-0"></div>

            {/* Stopped Services */}
            <div className="flex-1 flex items-center gap-2 px-1">
              <div className="w-8 h-8 rounded-lg bg-rose-950/60 border border-rose-500/50 flex items-center justify-center shadow-[0_0_12px_rgba(244,63,94,0.35)] shrink-0">
                <Square className="w-3.5 h-3.5 text-rose-400 fill-rose-400/20" />
              </div>
              <div className="text-right flex flex-col justify-center">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-base font-black font-mono text-rose-400">{apps.filter(a => a.status === "STOPPED" || a.status === "CRASHED").length}</span>
                  <span className="text-[11px] font-bold text-slate-200 whitespace-nowrap">متوقف</span>
                </div>
              </div>
            </div>

            <div className="w-[1px] h-8 bg-cyan-900/40 shrink-0"></div>

            {/* Total Services */}
            <div className="flex-1 flex items-center gap-2 px-1">
              <div className="w-8 h-8 rounded-lg bg-blue-950/60 border border-blue-500/50 flex items-center justify-center shadow-[0_0_12px_rgba(59,130,246,0.35)] shrink-0">
                <Package className="w-4 h-4 text-blue-400" />
              </div>
              <div className="text-right flex flex-col justify-center">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-base font-black font-mono text-blue-400">{apps.length}</span>
                  <span className="text-[11px] font-bold text-slate-200 whitespace-nowrap">کل</span>
                </div>
              </div>
            </div>

          </div>

          {/* Card 1: System Status Waveform (xl:col-span-2) */}
          {(() => {
            const tensionPercentage = coreStabilized ? 0 : (coreTension / 60) * 100;
            const isOverload = tensionPercentage > 40;
            const hasCrash = apps.some(a => a.status === "CRASHED");
            const allStopped = apps.length > 0 && apps.every(a => a.status === "STOPPED");
            const noApps = apps.length === 0;
            const isWarning = apps.some(a => a.status === "STOPPED") && !allStopped;
            let waveStatus: any = "normal";
            if (isOverload) waveStatus = "error";
            else if (hasCrash) waveStatus = "error";
            else if (allStopped || noApps) waveStatus = "offline";
            else if (isWarning) waveStatus = "warning";

            return (
              <div 
                className={`xl:col-span-2 bg-[#06111e]/85 backdrop-blur-md border rounded-xl p-3 flex flex-col justify-between transition-all relative overflow-hidden group ${
                  isOverload
                    ? "border-red-500/80 shadow-[0_0_30px_rgba(239,68,68,0.4)]"
                    : "border-[#0d3b5e]/70 shadow-[0_0_20px_rgba(0,180,255,0.07)] hover:border-[#145388]"
                }`}
                style={
                  isOverload
                    ? { transform: `translate(${Math.random() * (tensionPercentage / 15)}px, ${Math.random() * (tensionPercentage / 15)}px)` }
                    : {}
                }
              >
                <div className="flex items-center justify-between z-10">
                  <span className={`text-[11px] font-bold font-sans tracking-wide ${isOverload ? "text-red-400" : "text-cyan-300"}`}>
                    {isOverload ? "هشدار فشار سیستم" : "کل وضعیت سیستم"}
                  </span>
                  <span className={`inline-flex items-center gap-1 text-[8px] font-mono font-bold ${
                    waveStatus === "error" ? "text-rose-400" : waveStatus === "warning" ? "text-amber-400" : waveStatus === "offline" ? "text-slate-500" : "text-emerald-400"
                  } ${isOverload ? "animate-pulse font-black" : ""}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${waveStatus !== "offline" ? "animate-pulse" : ""} ${
                      waveStatus === "error" ? "bg-rose-400 shadow-[0_0_6px_#f43f5e]" : waveStatus === "warning" ? "bg-amber-400 shadow-[0_0_6px_#f59e0b]" : waveStatus === "offline" ? "bg-slate-500 shadow-none" : "bg-emerald-400 shadow-[0_0_6px_#34d399]"
                    }`}></span>
                    {isOverload ? `OVERLOAD: ${Math.round(tensionPercentage)}%` : waveStatus === "error" ? "ALERT" : waveStatus === "warning" ? "STANDBY" : waveStatus === "offline" ? "OFFLINE" : "ACTIVE"}
                  </span>
                </div>
                <div className="relative h-11 w-full mt-0.5 flex items-center justify-center overflow-hidden" dir="ltr">
                  <SineWaveMonitor status={waveStatus} tension={tensionPercentage} />
                </div>
              </div>
            );
          })()}

        </div>
      </footer>
    </div>
  );
}
