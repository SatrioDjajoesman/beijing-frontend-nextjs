import type { CSSProperties } from "react";

function clampChannel(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function channels(hex: string): [number, number, number] {
  const num = parseInt(hex.replace("#", ""), 16);
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

// Lightens (positive percent) or darkens (negative percent) a hex color.
export function shade(hex: string, percent: number): string {
  const [r, g, b] = channels(hex);
  const mix = (channel: number) =>
    percent >= 0
      ? clampChannel(channel + (255 - channel) * (percent / 100))
      : clampChannel(channel + channel * (percent / 100));
  const mixed = (mix(r) << 16) + (mix(g) << 8) + mix(b);
  return `#${mixed.toString(16).padStart(6, "0")}`;
}

// Average per-channel difference between two hex colors.
function contrast(a: string, b: string): number {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return (Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)) / 3;
}

// Lightening a color that's already near white leaves almost no headroom,
// so the result barely differs from the face — on screen that reads as "no
// border" on that side. When that happens, fall back to a mild darken
// instead (still lighter than the opposite, shadowed edge), so every side
// always gets a color that's actually visible against the face.
function highlight(base: string, percent: number, fallbackPercent: number): string {
  const candidate = shade(base, percent);
  return contrast(candidate, base) >= 15 ? candidate : shade(base, fallbackPercent);
}

// Mimics a single light source directly above every control using border
// color alone (no gradients): the resting "raised" state gets a bright
// top/left edge and a dark bottom/right edge; the active/pressed state
// inverts that so the element reads as pushed in.
export function bevel(base: string, pressed = false, width = 2, dashed = false): CSSProperties {
  const hi = highlight(base, 45, -22);
  const hiSoft = highlight(base, 22, -11);
  const lo = shade(base, -35);
  const loSoft = shade(base, -18);
  return {
    backgroundColor: base,
    borderStyle: dashed ? "dashed" : "solid",
    borderWidth: `${width}px`,
    borderTopColor: pressed ? lo : hi,
    borderLeftColor: pressed ? loSoft : hiSoft,
    borderRightColor: pressed ? hiSoft : loSoft,
    borderBottomColor: pressed ? hi : lo,
  };
}

// Badges are read-only, so they stay square and permanently "pressed" like
// an indicator set into a panel. (Buttons live in button-style.ts.)
export const BADGE_CLASS = "px-3 py-1 text-sm font-mono";
