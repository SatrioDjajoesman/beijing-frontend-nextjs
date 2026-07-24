// Glass-pill button styling, modeled directly on the CoolButton reference —
// plain Tailwind classes (no bevel.ts color math). Toggled/active controls
// turn blue; everything else stays the neutral zinc/white glass look.
const BUTTON_BASE =
  "relative overflow-hidden backdrop-blur-sm border border-l-0 border-r-0 " +
  "font-light" +
  "before:absolute before:inset-0 before:translate-x-[-100%] hover:before:translate-x-[100%] " +
  "before:transition-transform before:duration-1000 before:ease-in-out cursor-pointer";

export function buttonToneClass(active: boolean): string {
  return active
    ? "bg-gradient-to-t from-blue-600/80 to-blue-800/60 border border-b-blue-800/70 border-t-blue-300/80 border-x-0 text-white hover:from-blue-500/70 hover:to-blue-800/70 hover:border-b-blue-900/50 hover:border-t-blue-200/80 hover:border-x-0 transition-colors duration-300 ease-in-out"
    : "bg-gradient-to-t from-zinc-600/90 to-zinc-800/50 border border-b-zinc-800/70 border-t-zinc-300/80 border-x-0 text-white hover:from-zinc-600/60 hover:to-zinc-700/80 hover:border-b-zinc-900/50 hover:border-t-zinc-400/80 hover:border-x-0 transition-colors duration-300 ease-in-out";
}

export function buttonClass(active: boolean, extra = ""): string {
  return `${BUTTON_BASE} ${buttonToneClass(active)} ${extra}`.trim();
}
