import { useEffect, useState } from "react";
import { api, type Branding } from "../api.js";

const DEFAULT_BRANDING: Branding = {
  primaryColor: "#4f8cff",
  secondaryColor: "#8a5cff",
  background: { type: "solid", color: "#0e1116" },
};

/** Persona-driven starting points (#53) — mirrors domain BRANDING_PRESETS. */
const BRANDING_PRESETS: { id: string; name: string; persona: string; branding: Branding }[] = [
  { id: "broadsheet", name: "Broadsheet", persona: "Editor", branding: { primaryColor: "#8a2f24", secondaryColor: "#7c5a2c", background: { type: "solid", color: "#f7f3ea" } } },
  { id: "marquee", name: "Marquee", persona: "Ad Director", branding: { primaryColor: "#e5484d", secondaryColor: "#6d3fc4", background: { type: "gradient", from: "#ffffff", to: "#fdecec", angle: 135 } } },
  { id: "contrast", name: "Contrast", persona: "A11y", branding: { primaryColor: "#0b57d0", secondaryColor: "#5b2d9c", background: { type: "solid", color: "#ffffff" } } },
  { id: "light", name: "Light", persona: "", branding: { primaryColor: "#2f56d4", secondaryColor: "#6d3fc4", background: { type: "solid", color: "#f4f6fa" } } },
  { id: "dark", name: "Dark", persona: "", branding: { primaryColor: "#6b8bf5", secondaryColor: "#b18cf0", background: { type: "solid", color: "#0c1220" } } },
];

export function BrandingEditor({ org }: { org: string }) {
  const [b, setB] = useState<Branding>(DEFAULT_BRANDING);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api.getBranding(org).then((r) => r && setB(r)).catch(() => undefined);
  }, [org]);
  const save = async () => {
    setMsg("");
    try { await api.setBranding(org, b); setMsg("Saved"); } catch (e) { setMsg(String(e)); }
  };
  const bg = b.background;
  return (
    <div>
      <h1 className="h1">Subscriber-site branding</h1>
      <div className="card">
        <label>Start from a preset</label>
        <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {BRANDING_PRESETS.map((p) => (
            <button key={p.id} className="btn" title={p.persona || undefined}
              onClick={() => setB({ ...b, ...p.branding })}>
              {p.persona ? `${p.name} · ${p.persona}` : p.name}
            </button>
          ))}
        </div>
        <label>Logo URL</label>
        <input style={{ width: "100%" }} value={b.logoUrl ?? ""} onChange={(e) => setB({ ...b, logoUrl: e.target.value })} />
        <div className="row" style={{ marginTop: 8 }}>
          <div>
            <label>Primary</label>
            <input type="color" value={b.primaryColor} onChange={(e) => setB({ ...b, primaryColor: e.target.value })} />
          </div>
          <div>
            <label>Secondary</label>
            <input type="color" value={b.secondaryColor} onChange={(e) => setB({ ...b, secondaryColor: e.target.value })} />
          </div>
          <div>
            <label>Background</label>
            <select value={bg.type} onChange={(e) =>
              setB({ ...b, background: e.target.value === "gradient"
                ? { type: "gradient", from: "#0e1116", to: "#171b22", angle: 135 }
                : { type: "solid", color: "#0e1116" } })}>
              <option value="solid">Solid</option>
              <option value="gradient">Gradient</option>
            </select>
          </div>
        </div>
        {bg.type === "solid" ? (
          <div><label>Color</label><input type="color" value={bg.color} onChange={(e) => setB({ ...b, background: { type: "solid", color: e.target.value } })} /></div>
        ) : (
          <div className="row">
            <div><label>From</label><input type="color" value={bg.from} onChange={(e) => setB({ ...b, background: { ...bg, from: e.target.value } })} /></div>
            <div><label>To</label><input type="color" value={bg.to} onChange={(e) => setB({ ...b, background: { ...bg, to: e.target.value } })} /></div>
            <div><label>Angle</label><input type="number" value={bg.angle} onChange={(e) => setB({ ...b, background: { ...bg, angle: Number(e.target.value) } })} /></div>
          </div>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void save()}>Save branding</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
      </div>
      <div className="card" style={{
        background: bg.type === "solid" ? bg.color : `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})`,
      }}>
        <div className="muted">Preview</div>
        {b.logoUrl && <img src={b.logoUrl} alt="logo" style={{ maxHeight: 40 }} />}
        <div style={{ color: b.primaryColor, fontWeight: 700, fontSize: 20 }}>Primary heading</div>
        <div style={{ color: b.secondaryColor }}>Secondary accent</div>
      </div>
    </div>
  );
}
