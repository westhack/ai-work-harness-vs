/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { vscode } from "../../shared/vscode";
import { fmtSize } from "./localShared";
import { t as tr } from "../../shared/i18n";

interface Hardware {
  sampledAt: string; totalMemoryBytes: number; freeMemoryBytes: number; logicalCpus: number; cpuModel: string;
  diskFreeBytes?: number; gpuProbe: string; gpus: { name: string; totalBytes: number; freeBytes: number }[];
}
export interface Fit { level: string; estimatedMemoryBytes?: number; recommendedContext: number; recommendedThreads: number; reason: string }
export function useLocalHardware() {
  const [hardware, setHardware] = React.useState<Hardware>();
  const [fits, setFits] = React.useState<Record<string, Fit>>({});
  React.useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type === "localHardware") { setHardware(event.data.hardware); setFits(event.data.fits || {}); }
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "localHardwareGet" });
    return () => window.removeEventListener("message", listener);
  }, []);
  return { hardware, fits };
}
export function HardwareSummary({ hardware }: { hardware?: Hardware }) {
  return <details className="feature-card" style={{ padding: 12, marginTop: 12 }}>
    <summary>{tr("AiWorkHarness host · hardware and memory")} {hardware ? `· ${fmtSize(hardware.freeMemoryBytes)} RAM available` : "· measuring…"}</summary>
    {hardware && <div className="row-desc" style={{ marginTop: 10 }}>
      <p>{hardware.cpuModel} · {hardware.logicalCpus} {tr("logical CPUs")}</p>
      <p>{tr("RAM:")} {fmtSize(hardware.freeMemoryBytes)} {tr("available /")} {fmtSize(hardware.totalMemoryBytes)} total{hardware.diskFreeBytes != null ? ` · Disk: ${fmtSize(hardware.diskFreeBytes)} free` : ""}</p>
      {hardware.gpus.map(gpu => <p key={gpu.name}>{gpu.name}: {fmtSize(gpu.freeBytes)} {tr("available /")} {fmtSize(gpu.totalBytes)} {tr("VRAM")}</p>)}
      {!hardware.gpus.length && <p>{tr("GPU memory was not detected. RAM measurements do not establish GPU compatibility.")}</p>}
      <p>{tr("Measured")} {new Date(hardware.sampledAt).toLocaleTimeString()} {tr("on the machine running AiWorkHarness. These measurements do not describe a remote Ollama server. Fit estimates include a memory reserve; model architecture and context can change actual usage.")}</p>
      <button className="btn-ghost sm" onClick={() => vscode.postMessage({ type: "localHardwareGet" })}>{tr("Refresh measurements")}</button>
    </div>}
  </details>;
}
