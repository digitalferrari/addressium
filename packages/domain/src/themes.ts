/**
 * Named branding/theme presets (#53).
 *
 * "Light or dark" isn't how a publisher thinks about their brand, so we ship a
 * small set of persona-driven presets an operator can apply as a starting point
 * and then fine-tune with the branding controls (#31). Each preset is just a
 * {@link Branding} value, so applying one pre-fills the same CSS variables the
 * subscriber site already reads (`--brand-primary/secondary/bg`).
 */
import type { Branding } from "@addressium/core";

export interface ThemePreset {
  id: string;
  name: string;
  /** Who this preset is aimed at — the reason it looks the way it does. */
  persona: string;
  description: string;
  branding: Branding;
}

export const BRANDING_PRESETS: ThemePreset[] = [
  {
    id: "light",
    name: "Light",
    persona: "Default",
    description: "Clean, neutral light UI.",
    branding: { primaryColor: "#2f56d4", secondaryColor: "#6d3fc4", background: { type: "solid", color: "#f4f6fa" } },
  },
  {
    id: "dark",
    name: "Dark",
    persona: "Default",
    description: "Low-light neutral dark UI.",
    branding: { primaryColor: "#6b8bf5", secondaryColor: "#b18cf0", background: { type: "solid", color: "#0c1220" } },
  },
  {
    id: "broadsheet",
    name: "Broadsheet",
    persona: "Editor",
    description: "Warm newsprint with an oxblood accent — reads as an established paper.",
    branding: { primaryColor: "#8a2f24", secondaryColor: "#7c5a2c", background: { type: "solid", color: "#f7f3ea" } },
  },
  {
    id: "marquee",
    name: "Marquee",
    persona: "Advertising Director",
    description: "Bright, brand-forward, high-energy — built to convert signups.",
    branding: {
      primaryColor: "#e5484d",
      secondaryColor: "#6d3fc4",
      background: { type: "gradient", from: "#ffffff", to: "#fdecec", angle: 135 },
    },
  },
  {
    id: "contrast",
    name: "Contrast",
    persona: "Accessibility",
    description: "Maximum legibility — black on white with a strong blue accent (WCAG-AAA body text).",
    branding: { primaryColor: "#0b57d0", secondaryColor: "#5b2d9c", background: { type: "solid", color: "#ffffff" } },
  },
];

/** Look up a preset's Branding by id (e.g. to pre-fill the branding editor). */
export function brandingPreset(id: string): Branding | undefined {
  return BRANDING_PRESETS.find((p) => p.id === id)?.branding;
}
