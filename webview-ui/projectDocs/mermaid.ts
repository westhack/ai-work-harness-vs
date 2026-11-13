/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

export interface ChartNode { id: string; label: string; shape: string; rounded?: boolean }
export interface ChartEdge { from: string; to: string; label?: string; arrow: boolean; dashed: boolean }
export interface Chart { direction: "UD" | "DU" | "LR" | "RL"; nodes: ChartNode[]; edges: ChartEdge[] }

const DIRECTIONS: Record<string, Chart["direction"]> = { TD: "UD", TB: "UD", BT: "DU", LR: "LR", RL: "RL" };
const SKIP_LINE = /^(?:subgraph|end|classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/i;
/** Mermaid arrows we understand; quoted text is masked before splitting. */
const ARROW = /(<-->|-->|<--|-\.+->|={2,}>|---|--[xo])/g;
const SHAPES: readonly [string, string, string][] = [
  ["[[", "]]", "box"],
  ["[(", ")]", "database"],
  ["((", "))", "ellipse"],
  ["{{", "}}", "hexagon"],
  ["[", "]", "box"],
  ["(", ")", "box"],
  ["{", "}", "diamond"],
  [">", "]", "box"],
];

function unquote(value: string): string {
  const text = value.trim();
  return /^".*"$/s.test(text) ? text.slice(1, -1) : text;
}

function parseNode(segment: string): ChartNode | undefined {
  const text = segment.trim();
  const id = /^[A-Za-z0-9_]+/.exec(text)?.[0];
  if (!id) return undefined;
  const rest = text.slice(id.length).trim();
  if (!rest) return { id, label: id, shape: "box" };
  for (const [open, close, shape] of SHAPES) {
    if (!rest.startsWith(open) || !rest.endsWith(close) || rest.length < open.length + close.length) continue;
    const label = unquote(rest.slice(open.length, rest.length - close.length)) || id;
    return { id, label, shape, rounded: open === "(" };
  }
  return { id, label: id, shape: "box" };
}

/** Parse the Mermaid flowchart subset the page writer is instructed to emit. */
export function parseFlowchart(source: string): Chart | undefined {
  const nodes = new Map<string, ChartNode>();
  const edges: ChartEdge[] = [];
  let direction: Chart["direction"] | undefined;
  const register = (node: ChartNode): void => {
    const current = nodes.get(node.id);
    if (!current || (current.label === current.id && node.label !== node.id)) nodes.set(node.id, node);
  };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim().replace(/;$/, "");
    if (!line || line.startsWith("%%")) continue;
    if (!direction) {
      const head = /^(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)\b/i.exec(line);
      if (!head) return undefined;
      direction = DIRECTIONS[head[1].toUpperCase()];
      continue;
    }
    if (SKIP_LINE.test(line)) continue;
    const masked = line.replace(/"[^"]*"/g, (text) => "\u0000".repeat(text.length));
    const segments: string[] = [];
    const arrows: { label?: string; dashed: boolean; arrow: boolean }[] = [];
    const re = new RegExp(ARROW.source, "g");
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(masked))) {
      segments.push(line.slice(last, match.index));
      const after = masked.slice(re.lastIndex);
      const labelMatch = /^\s*\|([^|]*)\|/.exec(after);
      let label: string | undefined;
      if (labelMatch) {
        label = unquote(line.slice(re.lastIndex + labelMatch[0].indexOf("|") + 1, re.lastIndex + labelMatch[0].lastIndexOf("|"))) || undefined;
        re.lastIndex += labelMatch[0].length;
      }
      const arrow = match[1];
      arrows.push({ label, dashed: arrow.includes("."), arrow: arrow.includes(">") });
      last = re.lastIndex;
    }
    segments.push(line.slice(last));
    const parsed = segments.map(parseNode);
    for (const node of parsed) if (node) register(node);
    for (let index = 0; index < arrows.length; index++) {
      const from = parsed[index];
      const to = parsed[index + 1];
      if (!from || !to || from.id === to.id) continue;
      register(from);
      register(to);
      edges.push({ from: from.id, to: to.id, ...arrows[index] });
    }
  }
  if (!direction || !nodes.size || !edges.length) return undefined;
  return { direction, nodes: [...nodes.values()], edges };
}

/** Longest-path layering, bounded so a cyclic diagram still terminates. */
export function measure(chart: Chart): { levels: number; widest: number } {
  const level = new Map<string, number>(chart.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < chart.nodes.length; pass++) {
    let changed = false;
    for (const edge of chart.edges) {
      const next = (level.get(edge.from) ?? 0) + 1;
      if (next < chart.nodes.length && next > (level.get(edge.to) ?? 0)) {
        level.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const perLevel = new Map<number, number>();
  for (const value of level.values()) perLevel.set(value, (perLevel.get(value) ?? 0) + 1);
  return { levels: Math.max(1, ...perLevel.keys()) + 1, widest: Math.max(1, ...perLevel.values()) };
}
