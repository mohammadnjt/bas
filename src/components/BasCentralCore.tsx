import React, { useState, useEffect, useRef } from "react";

export type CoreStatus = "online" | "warning" | "error" | "offline";

interface BasCentralCoreProps {
  onClick?: () => void;
  paginationText?: string;
  status?: CoreStatus;
  totalApps?: number;
  activeApps?: number;
  crashedApps?: number;
  className?: string;
  onStateChange?: (hoverSeconds: number, isStabilized: boolean) => void;
}

export const BasCentralCore: React.FC<BasCentralCoreProps> = ({
  status = "online",
  totalApps = 0,
  activeApps = 0,
  crashedApps = 0,
  className = "",
  onClick,
  paginationText,
  onStateChange
}) => {
  const [hoverSeconds, setHoverSeconds] = useState(0);
  const [isStabilized, setIsStabilized] = useState(false);
  const hoverIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (onStateChange) {
      onStateChange(hoverSeconds, isStabilized);
    }
  }, [hoverSeconds, isStabilized, onStateChange]);

  const handleMouseEnter = () => {
    // If already stabilized, hover doesn't reset it, but we can still reset hoverSeconds if needed,
    // though the prompt says "until reload".
    if (!isStabilized) {
      setHoverSeconds(0);
      hoverIntervalRef.current = setInterval(() => {
        setHoverSeconds((prev) => {
          const next = prev + 1;
          if (next >= 60) {
            setIsStabilized(true);
            if (hoverIntervalRef.current) clearInterval(hoverIntervalRef.current);
          }
          return next;
        });
      }, 1000);
    }
  };

  const handleMouseLeave = () => {
    if (hoverIntervalRef.current) {
      clearInterval(hoverIntervalRef.current);
      hoverIntervalRef.current = null;
    }
    if (!isStabilized) {
      setHoverSeconds(0);
    }
  };

  const isRgbMode = hoverSeconds >= 10 && !isStabilized;
  const speedMultiplier = isRgbMode ? Math.floor((hoverSeconds - 10) / 10) + 2 : 1;
  const animDurNumber = (base: number) => base / speedMultiplier;
  const animDur = (base: number) => `${animDurNumber(base)}s`;

  // Theme styling based on system status
  const getStatusConfig = () => {
    if (isRgbMode) {
      return {
        glowColor: "rgba(217, 70, 239, 0.45)",
        haloFrom: "rgba(217, 70, 239, 0.25)",
        haloTo: "rgba(217, 70, 239, 0.0)",
        primaryText: "text-fuchsia-400 drop-shadow-[0_0_20px_rgba(217,70,239,0.95)] animate-pulse",
        subText: "text-pink-400",
        ringColor: "#d946ef",
        ringSecondary: "#a855f7",
        radarColor: "rgba(217, 70, 239, 0.35)",
        borderGlow: "shadow-[0_0_50px_rgba(217,70,239,0.5)]"
      };
    }
    switch (status) {
      case "error":
        return {
          glowColor: "rgba(244, 63, 94, 0.45)",
          haloFrom: "rgba(244, 63, 94, 0.25)",
          haloTo: "rgba(244, 63, 94, 0.0)",
          primaryText: "text-rose-400 drop-shadow-[0_0_18px_rgba(244,63,94,0.9)]",
          subText: "text-rose-300",
          ringColor: "#f43f5e",
          ringSecondary: "#e11d48",
          radarColor: "rgba(244, 63, 94, 0.35)",
          borderGlow: "shadow-[0_0_40px_rgba(244,63,94,0.4)]"
        };
      case "warning":
        return {
          glowColor: "rgba(245, 158, 11, 0.45)",
          haloFrom: "rgba(245, 158, 11, 0.25)",
          haloTo: "rgba(245, 158, 11, 0.0)",
          primaryText: "text-amber-400 drop-shadow-[0_0_18px_rgba(245,158,11,0.9)]",
          subText: "text-amber-300",
          ringColor: "#f59e0b",
          ringSecondary: "#d97706",
          radarColor: "rgba(245, 158, 11, 0.35)",
          borderGlow: "shadow-[0_0_40px_rgba(245,158,11,0.4)]"
        };
      case "offline":
        return {
          glowColor: "rgba(100, 116, 139, 0.2)",
          haloFrom: "rgba(100, 116, 139, 0.1)",
          haloTo: "rgba(100, 116, 139, 0.0)",
          primaryText: "text-slate-400",
          subText: "text-slate-500",
          ringColor: "#475569",
          ringSecondary: "#334155",
          radarColor: "rgba(100, 116, 139, 0.15)",
          borderGlow: "shadow-[0_0_20px_rgba(71,85,105,0.2)]"
        };
      case "online":
      default:
        return {
          glowColor: "rgba(6, 182, 212, 0.45)",
          haloFrom: "rgba(6, 182, 212, 0.25)",
          haloTo: "rgba(6, 182, 212, 0.0)",
          primaryText: "text-cyan-300 drop-shadow-[0_0_20px_rgba(6,182,212,0.95)]",
          subText: "text-cyan-400",
          ringColor: "#06b6d4",
          ringSecondary: "#0284c7",
          radarColor: "rgba(6, 182, 212, 0.35)",
          borderGlow: "shadow-[0_0_50px_rgba(6,182,212,0.4)]"
        };
    }
  };

  const cfg = getStatusConfig();

  const traceColor = isRgbMode ? "#d946ef" : "#22d3ee";
  const renderTrace = (cx: number, cy: number, cornerX: number, cornerY: number, lineX: number, grad: string) => {
    return isStabilized ? (
      <>
        <path d={`M ${cx} ${cy} L ${cornerX} ${cornerY} L ${lineX} ${cornerY}`} stroke={`url(#${grad})`} />
        <path d={`M ${cx} ${cy - 10} L ${cornerX} ${cornerY - 10} L ${lineX} ${cornerY - 10}`} stroke={`url(#${grad})`} opacity="0.6" strokeWidth="1.5" />
        <path d={`M ${cx} ${cy + 10} L ${cornerX} ${cornerY + 10} L ${lineX} ${cornerY + 10}`} stroke={`url(#${grad})`} opacity="0.6" strokeWidth="1.5" />
        <circle cx={cx} cy={cy} r="4" fill={traceColor} />
        <circle cx={cx} cy={cy - 10} r="2.5" fill={traceColor} opacity="0.8" />
        <circle cx={cx} cy={cy + 10} r="2.5" fill={traceColor} opacity="0.8" />
      </>
    ) : (
      <>
        <path d={`M ${cx} ${cy} L ${cornerX} ${cornerY} L ${lineX} ${cornerY}`} stroke={`url(#${grad})`} />
        <circle cx={cx} cy={cy} r="4" fill={traceColor} />
      </>
    );
  };

  return (
    <div
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`relative flex items-center justify-center select-none active:scale-[0.97] transition-transform duration-150 ${onClick ? "cursor-pointer" : ""} ${isRgbMode ? "animate-rgb-disco" : ""} ${className}`}
      style={{ width: "300px", height: "300px", animationDuration: isRgbMode ? animDur(4.5 * 4) : undefined }}
    >
      {/* Background radial ambient halo glow (Pulsing) */}
      <div
        className={`absolute inset-2 rounded-full pointer-events-none ${status !== "offline" ? "animate-core-pulse" : ""}`}
        style={{
          background: `radial-gradient(circle, ${cfg.haloFrom} 0%, rgba(3, 15, 30, 0.85) 65%, ${cfg.haloTo} 100%)`,
          animationDuration: status !== "offline" ? animDur(4) : undefined
        }}
      />

      {/* SVG Interactive Animated Rings & Orbiting Nodes */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
        viewBox="0 0 300 300"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Circuit Trace Gradient Left */}
          <linearGradient id="traceLeft" x1="150" y1="150" x2="-300" y2="150" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={traceColor} stopOpacity="1" />
            <stop offset="100%" stopColor={traceColor} stopOpacity="0" />
          </linearGradient>

          {/* Circuit Trace Gradient Right */}
          <linearGradient id="traceRight" x1="150" y1="150" x2="600" y2="150" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={traceColor} stopOpacity="1" />
            <stop offset="100%" stopColor={traceColor} stopOpacity="0" />
          </linearGradient>

          {/* Radar Sweep Gradient */}
          <linearGradient id="radarSweepGrad" x1="150" y1="150" x2="300" y2="150" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={cfg.ringColor} stopOpacity="0.0" />
            <stop offset="60%" stopColor={cfg.ringColor} stopOpacity="0.12" />
            <stop offset="100%" stopColor={cfg.ringColor} stopOpacity="0.45" />
          </linearGradient>

          {/* Glow filter */}
          <filter id="coreGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* 0. Circuit Traces extending outwards */}
        {status !== "offline" && (
          <g className="opacity-80 z-[-10]" strokeWidth="2.5" fill="none" filter="url(#coreGlow)">
            {/* Top Left */}
            {renderTrace(25, 75, -10, 40, -500, "traceLeft")}
            
            {/* Bottom Left */}
            {renderTrace(25, 225, -10, 260, -500, "traceLeft")}

            {/* Top Right */}
            {renderTrace(275, 75, 310, 40, 800, "traceRight")}

            {/* Bottom Right */}
            {renderTrace(275, 225, 310, 260, 800, "traceRight")}
          </g>
        )}

        {/* 1. Radar Scanner Sweep Cone (Smooth Rotation) */}
        <g className={`origin-center ${status !== "offline" ? "animate-radar-sweep" : ""}`} style={status !== "offline" ? { animationDuration: animDur(4.5) } : {}}>
          <path
            d="M 150 150 L 285 150 A 135 135 0 0 1 245 245 Z"
            fill="url(#radarSweepGrad)"
            opacity="0.75"
          />
          <line
            x1="150"
            y1="150"
            x2="285"
            y2="150"
            stroke={cfg.ringColor}
            strokeWidth="1.5"
            strokeOpacity="0.85"
            filter="url(#coreGlow)"
          />
        </g>

        {/* 2. Outermost static subtle boundary ring */}
        <circle
          cx="150"
          cy="150"
          r="142"
          stroke={cfg.ringSecondary}
          strokeWidth="1"
          strokeOpacity="0.3"
        />

        {/* 3. Outermost rotating dashed calibrated ring (Clockwise) */}
        <g className={`origin-center ${status !== "offline" ? "animate-spin-cw" : ""}`} style={status !== "offline" ? { animationDuration: animDur(20) } : {}}>
          <circle
            cx="150"
            cy="150"
            r="134"
            stroke={cfg.ringColor}
            strokeWidth="1.5"
            strokeDasharray="4 8"
            strokeOpacity="0.65"
          />
          {/* Degree Ticks */}
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
            const rad = (deg * Math.PI) / 180;
            const x1 = 150 + 130 * Math.cos(rad);
            const y1 = 150 + 130 * Math.sin(rad);
            const x2 = 150 + 138 * Math.cos(rad);
            const y2 = 150 + 138 * Math.sin(rad);
            return (
              <line
                key={`tick-${deg}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={cfg.ringColor}
                strokeWidth="2"
                strokeOpacity="0.9"
                filter="url(#coreGlow)"
              />
            );
          })}
        </g>

        {/* 4. Middle counter-rotating segmented ring (Counter-Clockwise) */}
        <g className={`origin-center ${status !== "offline" ? "animate-spin-ccw" : ""}`} style={status !== "offline" ? { animationDuration: animDur(26) } : {}}>
          <circle
            cx="150"
            cy="150"
            r="116"
            stroke={cfg.ringColor}
            strokeWidth="2.5"
            strokeDasharray="24 16 8 16"
            strokeOpacity="0.75"
            filter="url(#coreGlow)"
          />
          {/* Segment nodes */}
          <circle cx="150" cy="34" r="3" fill={cfg.ringColor} filter="url(#coreGlow)" />
          <circle cx="150" cy="266" r="3" fill={cfg.ringColor} filter="url(#coreGlow)" />
          <circle cx="34" cy="150" r="3" fill={cfg.ringColor} filter="url(#coreGlow)" />
          <circle cx="266" cy="150" r="3" fill={cfg.ringColor} filter="url(#coreGlow)" />
        </g>

        {/* 5. Inner Fast-spinning dotted ring */}
        <g className={`origin-center ${status !== "offline" ? "animate-spin-cw-fast" : ""}`} style={status !== "offline" ? { animationDuration: animDur(10) } : {}}>
          <circle
            cx="150"
            cy="150"
            r="98"
            stroke={cfg.ringSecondary}
            strokeWidth="1.2"
            strokeDasharray="3 6"
            strokeOpacity="0.8"
          />
          <circle cx="248" cy="150" r="2.5" fill="#38bdf8" filter="url(#coreGlow)" />
        </g>

        {/* 6. Solid Core Inner Boundary Circle */}
        <circle
          cx="150"
          cy="150"
          r="86"
          stroke={cfg.ringColor}
          strokeWidth="2"
          strokeOpacity="0.9"
          fill="#040d1a"
          fillOpacity="0.85"
          filter="url(#coreGlow)"
        />

        {/* 7. Inner Core Concentric Accent Circles */}
        <circle
          cx="150"
          cy="150"
          r="78"
          stroke={cfg.ringSecondary}
          strokeWidth="1"
          strokeOpacity="0.4"
          strokeDasharray="6 4"
        />

        {/* Subtle Decorative Bracket Arcs */}
        <path
          d="M 85 130 A 75 75 0 0 1 85 170"
          stroke={cfg.ringColor}
          strokeWidth="2.5"
          strokeLinecap="round"
          opacity="0.8"
        />
        <path
          d="M 215 130 A 75 75 0 0 0 215 170"
          stroke={cfg.ringColor}
          strokeWidth="2.5"
          strokeLinecap="round"
          opacity="0.8"
        />
      </svg>

      {/* Orbiting light nodes via CSS keyframes */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        {status !== "offline" && <div className="w-2 h-2 rounded-full bg-cyan-300 shadow-[0_0_10px_#22d3ee] animate-orbit-1" style={{ animationDuration: animDur(14) }} />}
        {status !== "offline" && <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399] animate-orbit-2" style={{ animationDuration: animDur(18) }} />}
      </div>

      {/* Central Fixed Text - Crisp, Readable & Elegant Typography */}
      <div className="relative z-10 flex flex-col items-center justify-center text-center select-none pointer-events-none px-4">
        {/* Main BAS Title */}
        <h1 className={`text-4xl sm:text-5xl font-black font-mono tracking-wider ${cfg.primaryText} leading-none mb-1.5 transition-colors duration-500`}>
          BAS
        </h1>

        {/* Subtitle 1: BUS SYSTEM */}
        <div className={`text-[10px] sm:text-[11px] font-extrabold font-mono uppercase tracking-[0.25em] ${cfg.subText} opacity-95 mb-0.5 whitespace-nowrap transition-colors duration-500`}>
          BUS SYSTEM
        </div>

        {/* Subtitle 2: CONTROL CENTER */}
        <div className="text-[8px] sm:text-[9px] font-bold font-mono uppercase tracking-[0.2em] text-cyan-200/80 whitespace-nowrap">
          CONTROL CENTER
        </div>

        {/* Subtitle 3: Pagination Indicator */}
        {paginationText && (
          <div className="mt-1.5 text-[10px] sm:text-[11px] font-bold font-mono text-cyan-400 bg-cyan-950/50 px-2 py-0.5 rounded-md border border-cyan-800/50 shadow-[0_0_8px_rgba(6,182,212,0.3)]">
            {paginationText}
          </div>
        )}
      </div>
    </div>
  );
};
