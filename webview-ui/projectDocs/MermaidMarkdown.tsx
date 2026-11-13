/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { DataSet, Network } from "vis-network/standalone";
import type { Edge, Node } from "vis-network/standalone";
import { MarkdownView } from "../shared/MarkdownView";
import { measure, parseFlowchart, type Chart } from "./mermaid";

const networks = new Map<Network, HTMLElement>();

function draw(pre: Element, chart: Chart): void {
  const css = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const raised = color("--pd-raised", "#252526");
  const border = color("--pd-border", "#3c3c3c");
  const fg = color("--pd-fg", "#cccccc");
  const dim = color("--pd-dim", "#9d9d9d");
  const accent = color("--pd-accent", "#0e639c");
  const background = color("--pd-bg", "#1e1e1e");

  const wrapper = document.createElement("div");
  wrapper.className = "pd-mermaid";
  const canvas = document.createElement("div");
  const { levels, widest } = measure(chart);
  const vertical = chart.direction === "UD" || chart.direction === "DU";
  canvas.style.width = `${Math.min(1800, vertical ? Math.max(420, widest * 190) : Math.max(480, levels * 230))}px`;
  canvas.style.height = `${Math.min(900, vertical ? Math.max(220, levels * 130) : Math.max(240, widest * 110))}px`;
  canvas.style.margin = "0 auto";
  wrapper.appendChild(canvas);
  pre.replaceWith(wrapper);

  const network = new Network(canvas, {
    nodes: new DataSet<Node>(chart.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      shape: node.shape as Node["shape"],
      ...(node.rounded ? { shapeProperties: { borderRadius: 8 } } : {}),
    }))),
    edges: new DataSet<Edge>(chart.edges.map((edge, index) => ({
      id: index,
      from: edge.from,
      to: edge.to,
      ...(edge.label ? { label: edge.label } : {}),
      ...(edge.dashed ? { dashes: true } : {}),
      arrows: { to: { enabled: edge.arrow, scaleFactor: 0.55 } },
    }))),
  }, {
    autoResize: false,
    layout: {
      hierarchical: {
        enabled: true,
        direction: chart.direction,
        sortMethod: "directed",
        levelSeparation: vertical ? 110 : 190,
        nodeSpacing: vertical ? 150 : 90,
        treeSpacing: 160,
        blockShifting: true,
        edgeMinimization: true,
        parentCentralization: true,
      },
    },
    physics: false,
    nodes: {
      shape: "box",
      borderWidth: 1,
      borderWidthSelected: 1,
      color: { background: raised, border, highlight: { background: raised, border: accent } },
      font: { color: fg, size: 12, face: color("--pd-ui", "system-ui") },
      margin: { top: 8, right: 12, bottom: 8, left: 12 },
      widthConstraint: { maximum: 220 },
    },
    edges: {
      color: { color: dim, highlight: accent },
      font: { color: fg, size: 11, strokeWidth: 3, strokeColor: background, align: "middle" },
      smooth: { enabled: true, type: "cubicBezier", roundness: 0.5 },
    },
    interaction: { dragNodes: false, dragView: false, zoomView: false, hover: true, tooltipDelay: 200 },
  });
  network.fit({ animation: false });
  networks.set(network, wrapper);
}

function enhance(root: HTMLElement): void {
  for (const [network, wrapper] of networks) {
    if (wrapper.isConnected) continue;
    network.destroy();
    networks.delete(network);
  }
  for (const code of Array.from(root.querySelectorAll<HTMLElement>("pre > code.language-mermaid"))) {
    const pre = code.parentElement;
    if (!pre || pre.dataset.rendered) continue;
    const chart = parseFlowchart(code.textContent ?? "");
    if (!chart) {
      // Other diagram types stay as readable source instead of disappearing.
      pre.dataset.rendered = "unsupported";
      continue;
    }
    pre.dataset.rendered = "true";
    draw(pre, chart);
  }
}

/** Markdown that renders Mermaid flowcharts with the bundled vis-network layout. */
export const MermaidMarkdown = React.memo(function MermaidMarkdown({ text }: { text: string }) {
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => () => {
    for (const network of networks.keys()) network.destroy();
    networks.clear();
  }, []);
  React.useEffect(() => {
    if (host.current) enhance(host.current);
  }, [text]);
  return (
    <div ref={host}>
      <MarkdownView text={text} />
    </div>
  );
});
