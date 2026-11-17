import type { Preferences } from "../shared/model";
import { resolvedTheme } from "../shared/theme";

export function applyTheme(p: Preferences) {
  const { mode, colors } = resolvedTheme(
    p,
    matchMedia("(prefers-color-scheme: dark)").matches,
  );
  document.documentElement.dataset.mode = mode;
  document.documentElement.dataset.palette = p.palette;
  document.documentElement.lang = p.language === "zh" ? "zh-CN" : "en";
  for (const [key, value] of Object.entries(colors))
    document.documentElement.style.setProperty(`--${key}`, value);
}
