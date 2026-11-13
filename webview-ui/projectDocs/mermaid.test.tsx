/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness, AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { measure, parseFlowchart } from "./mermaid";

describe("parseFlowchart", () => {
  it("parses nodes, shapes and labelled edges", () => {
    const chart = parseFlowchart(`graph TD
      A["Client"] -->|"HTTP"| B(API)
      B --> C{"Authenticated?"}
      C -->|"Yes"| D[("Cache")]
      C -->|"No"| E((Reject))`);
    expect(chart?.direction).toBe("UD");
    expect(chart?.nodes.map((node) => [node.id, node.label, node.shape])).toEqual([
      ["A", "Client", "box"],
      ["B", "API", "box"],
      ["C", "Authenticated?", "diamond"],
      ["D", "Cache", "database"],
      ["E", "Reject", "ellipse"],
    ]);
    expect(chart?.edges).toHaveLength(4);
    expect(chart?.edges[0]).toMatchObject({ from: "A", to: "B", label: "HTTP", arrow: true });
    expect(chart?.edges[1]).toMatchObject({ from: "B", to: "C", label: undefined });
  });

  it("keeps the first explicit label and ignores subgraphs", () => {
    const chart = parseFlowchart(`flowchart LR
      subgraph sg_Core["Core"]
        A[Service] --> B[Store]
      end
      A --> C[Cache]`);
    expect(chart?.direction).toBe("LR");
    expect(chart?.nodes.find((node) => node.id === "A")?.label).toBe("Service");
    expect(chart?.nodes).toHaveLength(3);
    expect(chart?.edges).toHaveLength(2);
  });

  it("does not split on arrows inside quoted labels", () => {
    const chart = parseFlowchart(`graph LR
      A["a --> b"] --> B["b"]`);
    expect(chart?.nodes[0].label).toBe("a --> b");
    expect(chart?.edges).toHaveLength(1);
  });

  it("marks dashed and open links", () => {
    const chart = parseFlowchart(`graph TD
      A -.-> B
      B --- C`);
    expect(chart?.edges[0]).toMatchObject({ dashed: true, arrow: true });
    expect(chart?.edges[1]).toMatchObject({ dashed: false, arrow: false });
  });

  it("rejects unsupported diagrams and empty graphs", () => {
    expect(parseFlowchart("sequenceDiagram\n  A->>B: hello")).toBeUndefined();
    expect(parseFlowchart("graph TD\n  A")).toBeUndefined();
    expect(parseFlowchart("")).toBeUndefined();
  });
});

describe("measure", () => {
  it("layers a chain and a branch", () => {
    const chart = parseFlowchart(`graph TD
      A --> B
      B --> C
      A --> D`)!;
    expect(measure(chart)).toEqual({ levels: 3, widest: 2 });
  });
});
