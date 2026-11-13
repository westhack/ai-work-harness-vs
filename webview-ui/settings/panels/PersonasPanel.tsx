/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { Select } from "../../shared/Select";
import { Icon } from "../../shared/icons";
import { FeatureConfig, Persona, uid } from "../features";
import { t as tr } from "../../shared/i18n";

export function PersonasPanel({
  features,
  setFeatures,
  builtinPersonas,
}: {
  features: FeatureConfig;
  setFeatures: (f: Partial<FeatureConfig>) => void;
  builtinPersonas: Persona[];
}) {
  const all = [...builtinPersonas, ...features.customPersonas];

  const updateCustom = (id: string, patch: Partial<Persona>) => {
    setFeatures({ customPersonas: features.customPersonas.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  };
  const removeCustom = (id: string) => {
    const next = features.customPersonas.filter((p) => p.id !== id);
    const patch: Partial<FeatureConfig> = { customPersonas: next };
    if (features.activePersonaId === id) {
      patch.activePersonaId = "default";
    }
    setFeatures(patch);
  };
  const addCustom = () =>
    setFeatures({
      customPersonas: [
        ...features.customPersonas,
        { id: uid("persona"), name: "My Persona", description: "Custom persona", prompt: "" },
      ],
    });

  return (
    <>
      <h1 className="page-title">{tr("Personas")}</h1>
      <div className="section-label">{tr("Default Persona")}</div>
      <p className="panel-hint">{tr("New chats use this persona's system prompt. You can override it per chat from the composer.")}</p>
      <div className="row">
        <div className="row-text">
          <div className="row-title">{tr("Active Persona")}</div>
          <div className="row-desc">{tr("Applied automatically to new conversations.")}</div>
        </div>
        <Select aria-label={tr("Active persona")} value={features.activePersonaId} onChange={(e) => setFeatures({ activePersonaId: e.target.value })}>
          {all.map((p) => (
            <option key={p.id} value={p.id} title={tr(p.description)}>
              {tr(p.name)}
            </option>
          ))}
        </Select>
      </div>
      <div className="section-label" style={{ marginTop: 24 }}>{tr("Built-in Personas")}</div>
      {builtinPersonas.map((p) => (
        <div className="list-row" key={p.id}>
          <Icon name="agent" />
          <div className="lr-text">
            <div className="lr-title">{tr(p.name)}</div>
            <div className="lr-desc">{tr(p.description)}</div>
          </div>
          {features.activePersonaId === p.id && <span className="badge-default">{tr("default")}</span>}
        </div>
      ))}

      <div className="section-label" style={{ marginTop: 24 }}>{tr("Custom Personas")}</div>
      <p className="panel-hint">{tr("Define your own personas. The prompt layers onto the base coding-agent prompt.")}</p>
      {features.customPersonas.map((p) => (
        <div className="feature-card" key={p.id}>
          <div className="fc-head">
            <input className="fc-title-input" value={p.name} onChange={(e) => updateCustom(p.id, { name: e.target.value })} placeholder="name" />
            <button className="icon-btn" onClick={() => removeCustom(p.id)} title={tr("Remove")}>
              <Icon name="trash" size={14} />
            </button>
          </div>
          <div className="fc-body">
            <label className="fc-field">
              <span>{tr("Description")}</span>
              <input value={p.description} onChange={(e) => updateCustom(p.id, { description: e.target.value })} placeholder={tr("Short description")} />
            </label>
            <label className="fc-field">
              <span>{tr("System Prompt")}</span>
              <textarea rows={4} value={p.prompt} onChange={(e) => updateCustom(p.id, { prompt: e.target.value })} placeholder={tr("You are a...")} />
            </label>
          </div>
        </div>
      ))}
      <div className="panel-actions">
        <button className="btn-ghost" onClick={addCustom}>
          <Icon name="plus" size={14} /> {tr("Add Persona")}
        </button>
      </div>
    </>
  );
}
