import type { Classification } from "../types";

/**
 * Chart colors - mirror the Tailwind theme tokens in index.css
 * (validated for colorblind-safe separation with the dataviz palette validator).
 */
export const CLASSIFICATION_CHART_COLORS: Record<Classification, string> = {
  supporter: "#10b981",
  potential: "#f59e0b",
  opponent: "#f43f5e",
  unclassified: "#94a3b8",
};

export const CHART_PRIMARY_COLOR = "#6366f1";

/** Shared Recharts tooltip box style - RTL, Heebo font. */
export const CHART_TOOLTIP_STYLE = {
  borderRadius: 12,
  border: "1px solid #e2e8f0",
  boxShadow: "0 8px 24px rgba(15,23,42,.08)",
  fontFamily: "Heebo, sans-serif",
  fontSize: 13,
  direction: "rtl" as const,
};

/** Compact tooltip variant for small charts (e.g. drawer sparklines). */
export const CHART_TOOLTIP_STYLE_COMPACT = {
  ...CHART_TOOLTIP_STYLE,
  fontSize: 12,
};

export const CHART_AXIS_TICK_STYLE = { fontSize: 11, fill: "#94a3b8" };
export const CHART_GRID_COLOR = "#f1f5f9";
export const CHART_AXIS_LINE_COLOR = "#e2e8f0";
