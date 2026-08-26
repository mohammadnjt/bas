import React, { useState } from "react";
import { 
  Cpu, 
  HardDrive, 
  Activity, 
  Server, 
  X, 
  RefreshCw, 
  Terminal, 
  Zap, 
  Clock, 
  Layers, 
  CheckCircle2, 
  AlertCircle,
  Shield,
  Gauge
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export interface CpuCoreMetric {
  core: number;
  usage: number;
  speed: number;
  model: string;
}

export interface DetailedMemory {
  totalMb: number;
  usedMb: number;
  freeMb: number;
  availableMb: number;
  cachedMb?: number;
  buffersMb?: number;
  usedPercent: number;
  freePercent: number;
  availablePercent: number;
  swapTotalMb?: number;
  swapUsedMb?: number;
  swapFreeMb?: number;
}

export interface SystemMetrics {
  totalCpu: number;
  totalMemory: number;
  nodeVersion: string;
  platform: string;
  uptime?: number;
  serverUptime?: number;
  processUptime?: number;
  memory?: DetailedMemory;
  coresCount?: number;
  cpuModel?: string;
  cpuSpeedMhz?: number;
  cores?: CpuCoreMetric[];
  loadAvg?: [number, number, number];
  hostname?: string;
  arch?: string;
  kernel?: string;
  appsCpuTotal?: number;
  appsMemoryTotal?: number;
}

export interface AppStateItem {
  id: string;
  name: string;
  type: string;
  status: string;
  pid: number | null;
  cpu: number;
  memory: number;
  port: number;
  restarts: number;
  uptime: number;
}

interface HtopMonitorModalProps {
  isOpen: boolean;
  onClose: () => void;
  systemMetrics: SystemMetrics;
  apps: AppStateItem[];
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

function formatUptime(seconds: number = 0): string {
  if (!seconds || isNaN(seconds)) return "0s";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function formatBytesMb(mb: number = 0): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb} MB`;
}

export const HtopMonitorModal: React.FC<HtopMonitorModalProps> = ({
  isOpen,
  onClose,
  systemMetrics,
  apps,
  onRefresh,
  isRefreshing = false
}) => {
  const [filterQuery, setFilterQuery] = useState("");
  const [sortField, setSortField] = useState<"cpu" | "memory" | "pid" | "name">("cpu");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  if (!isOpen) return null;

  const mem = systemMetrics.memory || {
    totalMb: systemMetrics.totalMemory || 1024,
    usedMb: systemMetrics.totalMemory || 256,
    freeMb: Math.max(0, (systemMetrics.totalMemory || 1024) - (systemMetrics.totalMemory || 256)),
    availableMb: Math.max(0, (systemMetrics.totalMemory || 1024) - (systemMetrics.totalMemory || 256)),
    usedPercent: 25,
    freePercent: 75,
    availablePercent: 75
  };

  const cores = systemMetrics.cores && systemMetrics.cores.length > 0 
    ? systemMetrics.cores 
    : Array.from({ length: systemMetrics.coresCount || 1 }).map((_, i) => ({
        core: i + 1,
        usage: systemMetrics.totalCpu || 0,
        speed: systemMetrics.cpuSpeedMhz || 2400,
        model: systemMetrics.cpuModel || "CPU Core"
      }));

  const runningApps = apps.filter(a => a.status === "RUNNING");
  const stoppedApps = apps.filter(a => a.status === "STOPPED" || a.status === "CRASHED");

  const filteredApps = apps
    .filter(a => a.name.toLowerCase().includes(filterQuery.toLowerCase()) || String(a.pid || "").includes(filterQuery))
    .sort((a, b) => {
      const mult = sortOrder === "desc" ? -1 : 1;
      if (sortField === "cpu") return (a.cpu - b.cpu) * mult;
      if (sortField === "memory") return (a.memory - b.memory) * mult;
      if (sortField === "pid") return ((a.pid || 0) - (b.pid || 0)) * mult;
      return a.name.localeCompare(b.name) * mult;
    });

  const handleSort = (field: "cpu" | "memory" | "pid" | "name") => {
    if (sortField === field) {
      setSortOrder(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/85 backdrop-blur-md">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2 }}
          className="w-full max-w-6xl max-h-[92vh] flex flex-col bg-[#050b14] border border-[#00e5ff]/40 rounded-2xl shadow-[0_0_50px_rgba(0,229,255,0.15)] overflow-hidden text-slate-200 font-mono"
        >
          {/* Header Bar */}
          <div className="flex items-center justify-between px-5 py-3.5 bg-[#030914] border-b border-[#0d3b5e] select-none" dir="rtl">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-cyan-950/80 border border-cyan-400 flex items-center justify-center shadow-[0_0_12px_rgba(6,182,212,0.4)]">
                <Gauge className="w-4 h-4 text-cyan-300" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-cyan-300 font-sans tracking-wide">
                    کنسول دقیق پایش سخت‌افزار (HTOP Hardware Monitor)
                  </h2>
                  <span className="text-[10px] bg-cyan-950 text-cyan-400 border border-cyan-500/30 px-2 py-0.5 rounded font-mono font-bold">
                    LIVE
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 font-sans mt-0.5">
                  گزارش لحظه‌ای و دقیق پردازنده (CPU)، هسته‌ها، رم آزاد و وضعیت پردازش‌های سرور
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2" dir="ltr">
              {onRefresh && (
                <button
                  onClick={onRefresh}
                  disabled={isRefreshing}
                  className="px-3 py-1.5 rounded-lg bg-[#0d2238] hover:bg-[#14375b] text-cyan-300 border border-cyan-500/30 text-xs font-mono font-bold flex items-center gap-1.5 transition active:scale-95 disabled:opacity-50"
                  title="به‌روزرسانی لحظه‌ای"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin text-cyan-400" : ""}`} />
                  <span>REFRESH</span>
                </button>
              )}
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-lg bg-slate-900/80 hover:bg-rose-950/80 text-slate-400 hover:text-rose-400 border border-slate-700/60 hover:border-rose-500/60 flex items-center justify-center transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Modal Body */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 text-xs custom-scrollbar">
            
            {/* Top Quick Summary Info HUD */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" dir="ltr">
              
              {/* Host / OS */}
              <div className="bg-[#030914]/90 p-3 rounded-xl border border-[#0d3b5e]/80 shadow-inner">
                <div className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                  <Server className="w-3 h-3 text-cyan-400" /> Hostname / Kernel
                </div>
                <div className="text-cyan-300 font-bold truncate text-[11px]">{systemMetrics.hostname || "localhost"}</div>
                <div className="text-[9px] text-slate-400 truncate mt-0.5">{systemMetrics.kernel || systemMetrics.platform || "Linux"} ({systemMetrics.arch || "x64"})</div>
              </div>

              {/* CPU Model & Cores */}
              <div className="bg-[#030914]/90 p-3 rounded-xl border border-[#0d3b5e]/80 shadow-inner">
                <div className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                  <Cpu className="w-3 h-3 text-emerald-400" /> Total Cores
                </div>
                <div className="text-emerald-400 font-bold text-[13px]">{systemMetrics.coresCount || cores.length} Cores</div>
                <div className="text-[9px] text-slate-400 truncate mt-0.5" title={systemMetrics.cpuModel}>{systemMetrics.cpuModel || "x86_64 Processor"}</div>
              </div>

              {/* Total CPU Load */}
              <div className="bg-[#030914]/90 p-3 rounded-xl border border-[#0d3b5e]/80 shadow-inner">
                <div className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                  <Activity className="w-3 h-3 text-amber-400" /> Host CPU Load
                </div>
                <div className={`font-black text-[13px] ${systemMetrics.totalCpu > 75 ? "text-rose-400" : systemMetrics.totalCpu > 40 ? "text-amber-300" : "text-emerald-400"}`}>
                  {systemMetrics.totalCpu}%
                </div>
                <div className="text-[9px] text-slate-400 mt-0.5">Apps CPU: {systemMetrics.appsCpuTotal || 0}%</div>
              </div>

              {/* Free RAM (رم آزاد) */}
              <div className="bg-[#030914]/90 p-3 rounded-xl border border-[#0d3b5e]/80 shadow-inner">
                <div className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                  <HardDrive className="w-3 h-3 text-cyan-400" /> Free Memory
                </div>
                <div className="text-cyan-400 font-black text-[13px]">{formatBytesMb(mem.freeMb)}</div>
                <div className="text-[9px] text-slate-400 mt-0.5">Available: {formatBytesMb(mem.availableMb)} ({mem.availablePercent}%)</div>
              </div>

              {/* Used RAM */}
              <div className="bg-[#030914]/90 p-3 rounded-xl border border-[#0d3b5e]/80 shadow-inner">
                <div className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                  <Layers className="w-3 h-3 text-purple-400" /> Used Memory
                </div>
                <div className="text-purple-300 font-black text-[13px]">{formatBytesMb(mem.usedMb)} <span className="text-[10px] text-slate-400">({mem.usedPercent}%)</span></div>
                <div className="text-[9px] text-slate-400 mt-0.5">Total: {formatBytesMb(mem.totalMb)}</div>
              </div>

              {/* Load Avg & Uptime */}
              <div className="bg-[#030914]/90 p-3 rounded-xl border border-[#0d3b5e]/80 shadow-inner">
                <div className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                  <Clock className="w-3 h-3 text-blue-400" /> Load Avg / Uptime
                </div>
                <div className="text-blue-300 font-bold text-[11px]">
                  {systemMetrics.loadAvg ? systemMetrics.loadAvg.join(", ") : "0.00, 0.00, 0.00"}
                </div>
                <div className="text-[9px] text-slate-400 mt-0.5">Up: {formatUptime(systemMetrics.serverUptime || systemMetrics.uptime || 0)}</div>
              </div>

            </div>

            {/* HTOP Authentic Meters Box (CPU Cores & Memory Bars) */}
            <div className="bg-[#02060e] border border-[#0d3b5e] rounded-xl p-4 shadow-2xl relative overflow-hidden" dir="ltr">
              <div className="text-[10px] font-bold text-cyan-400 tracking-wider mb-3 flex items-center justify-between border-b border-[#0d3b5e]/60 pb-2">
                <span className="flex items-center gap-2">
                  <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                  HTOP HARDWARE TELEMETRY GAUGES
                </span>
                <span className="text-slate-500 text-[9px]">
                  Tasks: {apps.length} total, {runningApps.length} running, {stoppedApps.length} stopped
                </span>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-4">
                
                {/* Left Side: Per-Core CPU Gauges */}
                <div className="space-y-2">
                  <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">
                    Per-Core CPU Utilization ({cores.length} {cores.length === 1 ? "Core" : "Cores"}):
                  </div>
                  {cores.map((c) => {
                    const usage = Math.max(0, Math.min(100, c.usage));
                    const isHigh = usage >= 80;
                    const isMed = usage >= 50 && usage < 80;

                    return (
                      <div key={c.core} className="flex items-center gap-2 text-[10px] font-mono group">
                        <span className="text-slate-400 w-12 font-bold shrink-0">
                          [{c.core.toString().padStart(2, "0")}]
                        </span>
                        
                        {/* Gauge Meter Bar */}
                        <div className="flex-1 h-3 bg-[#081524] border border-[#0d3b5e] rounded px-[1px] py-[1px] flex items-center relative overflow-hidden shadow-inner">
                          <div
                            className={`h-full rounded-sm transition-all duration-300 ${
                              isHigh
                                ? "bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.7)]"
                                : isMed
                                ? "bg-gradient-to-r from-emerald-500 to-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]"
                                : "bg-gradient-to-r from-cyan-600 to-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.5)]"
                            }`}
                            style={{ width: `${Math.max(2, usage)}%` }}
                          />
                        </div>

                        {/* Usage % Value */}
                        <span className={`w-14 text-right font-bold shrink-0 ${
                          isHigh ? "text-rose-400 font-black" : isMed ? "text-amber-300" : "text-emerald-400"
                        }`}>
                          {usage.toFixed(1)}%
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Right Side: Memory, Swap & Detailed Breakdown */}
                <div className="space-y-4">
                  <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">
                    Memory & Storage Breakdown:
                  </div>

                  {/* RAM Meter Bar */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-cyan-400 font-bold">Mem (RAM)</span>
                      <span className="text-slate-300 font-mono">
                        <span className="text-cyan-300 font-bold">{formatBytesMb(mem.usedMb)}</span> / {formatBytesMb(mem.totalMb)} ({mem.usedPercent}%)
                      </span>
                    </div>
                    <div className="w-full h-3.5 bg-[#081524] border border-[#0d3b5e] rounded px-[1px] py-[1px] flex items-center relative overflow-hidden shadow-inner">
                      <div
                        className="h-full bg-gradient-to-r from-blue-600 via-cyan-500 to-emerald-400 rounded-sm transition-all duration-300 shadow-[0_0_8px_rgba(6,182,212,0.6)]"
                        style={{ width: `${Math.max(2, mem.usedPercent)}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[9px] text-slate-400">
                      <span className="text-emerald-400 font-bold">Free: {formatBytesMb(mem.freeMb)} ({mem.freePercent}%)</span>
                      <span className="text-cyan-300">Available: {formatBytesMb(mem.availableMb)}</span>
                      {mem.cachedMb ? <span>Cached: {formatBytesMb(mem.cachedMb)}</span> : null}
                    </div>
                  </div>

                  {/* Swap Meter Bar */}
                  {mem.swapTotalMb && mem.swapTotalMb > 0 ? (
                    <div className="space-y-1.5 pt-1">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-purple-400 font-bold">Swp (Swap)</span>
                        <span className="text-slate-300 font-mono">
                          <span className="text-purple-300 font-bold">{formatBytesMb(mem.swapUsedMb || 0)}</span> / {formatBytesMb(mem.swapTotalMb)}
                        </span>
                      </div>
                      <div className="w-full h-3.5 bg-[#081524] border border-[#0d3b5e] rounded px-[1px] py-[1px] flex items-center relative overflow-hidden shadow-inner">
                        <div
                          className="h-full bg-gradient-to-r from-purple-600 to-indigo-400 rounded-sm transition-all duration-300 shadow-[0_0_8px_rgba(168,85,247,0.5)]"
                          style={{ width: `${Math.min(100, Math.max(0, ((mem.swapUsedMb || 0) / mem.swapTotalMb) * 100))}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[9px] text-slate-400">
                        <span className="text-purple-400">Free Swap: {formatBytesMb(mem.swapFreeMb || mem.swapTotalMb)}</span>
                      </div>
                    </div>
                  ) : null}

                  {/* Summary Badges */}
                  <div className="grid grid-cols-2 gap-2 pt-2">
                    <div className="bg-[#050f1d] border border-[#0d3b5e] p-2 rounded-lg">
                      <div className="text-[8px] text-slate-400 uppercase font-bold">Process Uptime</div>
                      <div className="text-cyan-300 font-bold text-[11px]">{formatUptime(systemMetrics.processUptime || 0)}</div>
                    </div>
                    <div className="bg-[#050f1d] border border-[#0d3b5e] p-2 rounded-lg">
                      <div className="text-[8px] text-slate-400 uppercase font-bold">Node.js Engine</div>
                      <div className="text-emerald-400 font-bold text-[11px]">{systemMetrics.nodeVersion}</div>
                    </div>
                  </div>

                </div>

              </div>
            </div>

            {/* HTOP Interactive Process List Table */}
            <div className="bg-[#02060e] border border-[#0d3b5e] rounded-xl overflow-hidden shadow-2xl" dir="ltr">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-3.5 bg-[#030914] border-b border-[#0d3b5e] gap-2">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs font-bold text-slate-200">Process & Service Resource Allocation</span>
                  <span className="text-[10px] text-cyan-400 bg-cyan-950 px-2 py-0.5 rounded border border-cyan-800">
                    {filteredApps.length} processes
                  </span>
                </div>

                <div className="w-full sm:w-64">
                  <input
                    type="text"
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    placeholder="Filter by name or PID..."
                    className="w-full bg-[#050b14] border border-[#0d3b5e] rounded-lg px-3 py-1.5 text-xs text-cyan-300 placeholder-slate-500 focus:outline-none focus:border-cyan-400 font-mono"
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#040e1b] text-slate-400 border-b border-[#0d3b5e] text-[10px] uppercase tracking-wider select-none font-bold">
                      <th className="p-3 cursor-pointer hover:text-cyan-300" onClick={() => handleSort("pid")}>
                        PID {sortField === "pid" ? (sortOrder === "asc" ? "▲" : "▼") : ""}
                      </th>
                      <th className="p-3 cursor-pointer hover:text-cyan-300" onClick={() => handleSort("name")}>
                        SERVICE / APP {sortField === "name" ? (sortOrder === "asc" ? "▲" : "▼") : ""}
                      </th>
                      <th className="p-3">TYPE</th>
                      <th className="p-3">STATUS</th>
                      <th className="p-3 cursor-pointer hover:text-cyan-300 text-right" onClick={() => handleSort("cpu")}>
                        CPU % {sortField === "cpu" ? (sortOrder === "asc" ? "▲" : "▼") : ""}
                      </th>
                      <th className="p-3 cursor-pointer hover:text-cyan-300 text-right" onClick={() => handleSort("memory")}>
                        RAM (MB) {sortField === "memory" ? (sortOrder === "asc" ? "▲" : "▼") : ""}
                      </th>
                      <th className="p-3 text-right">% OF TOTAL RAM</th>
                      <th className="p-3 text-center">PORT</th>
                      <th className="p-3 text-right">UPTIME</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#0d3b5e]/40 font-mono text-[11px]">
                    {filteredApps.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="p-6 text-center text-slate-500">
                          No matching processes found.
                        </td>
                      </tr>
                    ) : (
                      filteredApps.map((app) => {
                        const ramPctOfTotal = mem.totalMb > 0 
                          ? ((app.memory / mem.totalMb) * 100).toFixed(2)
                          : "0.00";

                        const isRunning = app.status === "RUNNING";
                        const isCrashed = app.status === "CRASHED";

                        return (
                          <tr 
                            key={app.id}
                            className="hover:bg-[#061527]/70 transition-colors"
                          >
                            {/* PID */}
                            <td className="p-3 text-slate-400 font-bold">
                              {app.pid ? (
                                <span className="text-cyan-400">#{app.pid}</span>
                              ) : (
                                <span className="text-slate-600">-</span>
                              )}
                            </td>

                            {/* Name */}
                            <td className="p-3 font-bold text-slate-200 flex items-center gap-2">
                              <span className={`w-2 h-2 rounded-full ${isRunning ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : isCrashed ? "bg-rose-500 shadow-[0_0_6px_#f43f5e]" : "bg-slate-600"}`}></span>
                              <span>{app.name}</span>
                            </td>

                            {/* Type */}
                            <td className="p-3">
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 uppercase">
                                {app.type}
                              </span>
                            </td>

                            {/* Status */}
                            <td className="p-3">
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                isRunning 
                                  ? "bg-emerald-950/80 text-emerald-400 border border-emerald-500/30" 
                                  : isCrashed 
                                  ? "bg-rose-950/80 text-rose-400 border border-rose-500/30" 
                                  : "bg-slate-900 text-slate-400 border border-slate-700"
                              }`}>
                                {app.status}
                              </span>
                            </td>

                            {/* CPU */}
                            <td className="p-3 text-right">
                              <span className={`font-bold ${app.cpu > 5 ? "text-amber-400 font-black" : "text-emerald-400"}`}>
                                {app.cpu.toFixed(1)}%
                              </span>
                            </td>

                            {/* Memory */}
                            <td className="p-3 text-right">
                              <span className="font-bold text-cyan-300">
                                {app.memory.toFixed(1)} MB
                              </span>
                            </td>

                            {/* % of Total RAM */}
                            <td className="p-3 text-right text-slate-400">
                              {ramPctOfTotal}%
                            </td>

                            {/* Port */}
                            <td className="p-3 text-center text-slate-300">
                              :{app.port}
                            </td>

                            {/* Uptime */}
                            <td className="p-3 text-right text-slate-400 text-[10px]">
                              {isRunning ? formatUptime(app.uptime) : "-"}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

          </div>

          {/* Footer Bar */}
          <div className="px-5 py-3 bg-[#030914] border-t border-[#0d3b5e] flex items-center justify-between text-[11px] text-slate-400 font-sans" dir="rtl">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                همگام‌سازی بلادرنگ هر ۱ ثانیه
              </span>
              <span>•</span>
              <span>کل رم سرور: <strong className="text-cyan-300 font-mono" dir="ltr">{formatBytesMb(mem.totalMb)}</strong></span>
              <span>•</span>
              <span>رم آزاد: <strong className="text-emerald-400 font-mono" dir="ltr">{formatBytesMb(mem.freeMb)}</strong></span>
            </div>
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-cyan-950 hover:bg-cyan-900 text-cyan-300 border border-cyan-400/50 text-xs font-bold transition font-mono"
            >
              CLOSE [ESC]
            </button>
          </div>

        </motion.div>
      </div>
    </AnimatePresence>
  );
};
