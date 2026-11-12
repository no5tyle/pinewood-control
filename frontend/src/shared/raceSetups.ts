import type { RaceSetup, ThemeName } from "./types";

export const THEME_NAMES: Record<ThemeName, string> = {
  system: "System",
  "scouts-au-cubs": "Cubs Australia",
  "scouts-america": "BSA",
};

/** e.g. "4 lanes · out at 3 points · Cubs Australia · grams" */
export function describeSetup(setup: Pick<RaceSetup, "lanes" | "pointLimit" | "theme" | "weightUnit">): string {
  return [
    `${setup.lanes} lanes`,
    `out at ${setup.pointLimit} point${setup.pointLimit === 1 ? "" : "s"}`,
    THEME_NAMES[setup.theme] ?? setup.theme,
    setup.weightUnit === "oz" ? "ounces" : "grams",
  ].join(" · ");
}
