import type { Preferences } from "./model";
import themes from "../ui/themes.json";

/** The native window and trusted renderers must use the same resolved palette. */
export function resolvedTheme(
  preferences: Pick<Preferences, "mode" | "palette">,
  systemDark: boolean,
) {
  const mode =
    preferences.mode === "system"
      ? systemDark
        ? "dark"
        : "light"
      : preferences.mode;
  return { mode, colors: themes.palettes[preferences.palette][mode] };
}
