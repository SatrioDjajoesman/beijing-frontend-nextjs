// Glass-pill button styling, modeled directly on the CoolButton reference —
// plain Tailwind classes (no bevel.ts color math). Toggled/active controls
// turn blue; everything else stays the neutral zinc/white glass look.
const BUTTON_BASE =
  "overflow-hidden backdrop-blur-sm border-1 border-l-0 border-r-0" +
  "font-light cursor-pointer font-mono"
  "before:absolute before:inset-0 before:translate-x-[-100%] hover:before:translate-x-[100%] " +
  "before:transition-transform before:duration-1000 before:ease-in-out cursor-pointer";

// Tailwind's position utilities (.absolute/.fixed/.relative/.static) are all
// equal-specificity, so whichever one is later in Tailwind's generated
// stylesheet wins — regardless of class order in the string. "relative"
// happens to come after "absolute", so appending it unconditionally would
// silently override any "absolute" a caller passes in `extra` (this bit the
// ModelViewer wireframe button: it stayed "relative" and never actually
// moved to its absolute top-right position). Only default to "relative"
// when the caller isn't already supplying its own position utility.
const POSITION_UTILS = /\b(?:static|fixed|absolute|sticky)\b/;

// Tailwind's gradient stops are CSS custom properties, so swapping
// from-*/to-* classes on :hover can't be interpolated by transition-colors —
// the browser just snaps. To get an actual fade, the hover gradient lives on
// an ::after overlay (sitting behind the text, above the base gradient) whose
// opacity 0->1 is what transitions; the base gradient never moves.
export function buttonToneClass(active: boolean): string {
  return active
    ? "bg-gradient-to-t from-blue-600/80 to-blue-800/60 border border-b-blue-800/90 border-t-blue-300/80 border-x-0 text-white " +
        "ring-1 ring-blue-800 " +
        "after:content-[''] after:absolute after:inset-0 after:-z-10 after:bg-gradient-to-t after:from-blue-500/70 after:to-blue-800/70 " +
        "after:opacity-0 hover:after:opacity-100 after:transition-opacity after:duration-150 after:ease-in-out " +
        "hover:border-b-blue-900/50 hover:border-t-blue-300/100 transition-colors duration-150 ease-in-out"
    : "bg-gradient-to-t from-zinc-600/90 to-zinc-800/50 border border-b-zinc-800/90 border-t-zinc-300/80 border-x-0 text-white " +
        "ring-1 ring-zinc-700 " +
        "after:content-[''] after:absolute after:inset-0 after:-z-10 after:bg-gradient-to-t after:from-zinc-600/60 after:to-zinc-300/20 " +
        "after:opacity-0 hover:after:opacity-100 after:transition-opacity after:duration-150 after:ease-in-out " +
        "hover:border-b-zinc-900/50 hover:border-t-zinc-200/80 transition-colors duration-150 ease-in-out";
}

export function buttonClass(active: boolean, extra = ""): string {
  const position = POSITION_UTILS.test(extra) ? "" : "relative";
  return `${BUTTON_BASE} ${position} ${buttonToneClass(active)} ${extra}`.trim();
}
