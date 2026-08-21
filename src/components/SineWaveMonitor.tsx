import React, { useEffect, useRef } from "react";

interface SineWaveMonitorProps {
  status?: "normal" | "warning" | "error" | "offline";
  tension?: number;
  className?: string;
}

export const SineWaveMonitor: React.FC<SineWaveMonitorProps> = ({
  status = "normal",
  tension = 0,
  className = ""
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let phase = 0;

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;
      const centerY = height / 2;

      ctx.clearRect(0, 0, width, height);

      // Grid background lines (oscilloscope effect)
      ctx.strokeStyle = "rgba(6, 182, 212, 0.08)";
      ctx.lineWidth = 1;

      // Horizontal center line
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.stroke();
      ctx.setLineDash([]);

      if (status === "offline") {
        ctx.beginPath();
        ctx.strokeStyle = "#475569"; // slate-600
        ctx.lineWidth = 2.2;
        ctx.moveTo(0, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();
        
        // No glowing dot, no fill gradient for offline
        animationFrameId = requestAnimationFrame(render);
        return;
      }

      // Wave configuration based on system status and tension
      const tensionFactor = Math.max(0, Math.min(100, tension)) / 100;
      
      const waveSpeed = (status === "error" ? 0.09 : 0.045) + (0.25 * tensionFactor);
      const amplitude = (status === "error" ? 14 : 11) + (10 * tensionFactor);
      const frequency = (status === "error" ? 0.035 : 0.028) + (0.05 * tensionFactor);

      phase += waveSpeed;

      // 1. Fill gradient below main wave
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      if (status === "error") {
        grad.addColorStop(0, "rgba(244, 63, 94, 0.35)");
        grad.addColorStop(1, "rgba(244, 63, 94, 0.0)");
      } else if (status === "warning") {
        grad.addColorStop(0, "rgba(245, 158, 11, 0.35)");
        grad.addColorStop(1, "rgba(245, 158, 11, 0.0)");
      } else {
        grad.addColorStop(0, "rgba(6, 182, 212, 0.35)");
        grad.addColorStop(0.5, "rgba(16, 185, 129, 0.2)");
        grad.addColorStop(1, "rgba(6, 182, 212, 0.0)");
      }

      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let x = 0; x <= width; x += 2) {
        // Compound sine wave for rich natural motion
        // Include an extra jitter component if tension is high
        const jitter = tensionFactor > 0.4 ? (Math.random() - 0.5) * (tensionFactor * 4) : 0;
        
        const y =
          centerY +
          Math.sin(x * frequency - phase) * amplitude +
          Math.sin(x * frequency * 0.5 - phase * 0.7) * (amplitude * 0.35) + jitter;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // 2. Secondary subtle background harmonic wave (Sky Blue / Purple)
      ctx.beginPath();
      ctx.strokeStyle =
        status === "error"
          ? "rgba(251, 113, 133, 0.35)"
          : status === "warning"
          ? "rgba(252, 211, 77, 0.35)"
          : "rgba(56, 189, 248, 0.4)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 4]);
      for (let x = 0; x <= width; x += 2) {
        const jitter = tensionFactor > 0.4 ? (Math.random() - 0.5) * (tensionFactor * 3) : 0;
        const y =
          centerY +
          Math.sin(x * (frequency * 0.8) + phase * 0.6) * (amplitude * 0.75) + jitter;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // 3. Primary Glowing Foreground Sine Wave
      ctx.beginPath();
      ctx.strokeStyle =
        status === "error"
          ? "#f43f5e"
          : status === "warning"
          ? "#f59e0b"
          : "#10b981";
      ctx.shadowColor =
        status === "error"
          ? "rgba(244, 63, 94, 0.9)"
          : status === "warning"
          ? "rgba(245, 158, 11, 0.9)"
          : "rgba(16, 185, 129, 0.9)";
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2.2;
      for (let x = 0; x <= width; x += 2) {
        const jitter = tensionFactor > 0.4 ? (Math.random() - 0.5) * (tensionFactor * 4) : 0;
        const y =
          centerY +
          Math.sin(x * frequency - phase) * amplitude +
          Math.sin(x * frequency * 0.5 - phase * 0.7) * (amplitude * 0.35) + jitter;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      
      // Reset shadow for performance
      ctx.shadowBlur = 0;

      // 4. Moving Pulse Glow Node along the wave
      const markerX = (width * 0.7 + Math.sin(phase * 0.5) * (width * 0.2)) % width;
      const markerY =
        centerY +
        Math.sin(markerX * frequency - phase) * amplitude +
        Math.sin(markerX * frequency * 0.5 - phase * 0.7) * (amplitude * 0.35);
      
      ctx.beginPath();
      ctx.arc(markerX, markerY, 3, 0, Math.PI * 2);
      ctx.fillStyle = status === "error" ? "#fda4af" : "#6ee7b7";
      ctx.shadowColor = status === "error" ? "#f43f5e" : "#34d399";
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [status, tension]);

  return (
    <div className={`relative w-full h-full flex items-center justify-center overflow-hidden ${className}`}>
      <canvas
        ref={canvasRef}
        width={220}
        height={48}
        className="w-full h-full object-contain pointer-events-none"
      />
    </div>
  );
};
