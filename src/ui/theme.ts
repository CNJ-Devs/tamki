import type { Preferences } from "../shared/model";
import themes from "./themes.json";

export function applyTheme(p: Preferences) {
  const mode =
    p.mode === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : p.mode;
  document.documentElement.dataset.mode = mode;
  document.documentElement.dataset.palette = p.palette;
  document.documentElement.lang = p.language === "zh" ? "zh-CN" : "en";
  for (const [key, value] of Object.entries(themes.palettes[p.palette][mode]))
    document.documentElement.style.setProperty(`--${key}`, value);
}
