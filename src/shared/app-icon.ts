import type { AppIconStyle, Preferences } from "./model";

export const appIconStyles: AppIconStyle[] = ["default", "light", "color"];

/** Icon appearance is independent of the application's light/dark mode. */
export function appIconAsset(
  preferences: Pick<Preferences, "palette" | "appIconStyle">,
) {
  const style = preferences.appIconStyle || "default";
  return style === "default"
    ? "app-icons/default.png"
    : `app-icons/${style}-${preferences.palette}.png`;
}
