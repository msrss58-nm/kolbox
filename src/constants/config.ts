/**
 * App-wide configuration values - timings, thresholds, and sizes.
 * Centralized so tuning behavior never means hunting for a magic number.
 */
export const APP_CONFIG = {
  /** Matches Tailwind's `md:` breakpoint - see lib/useIsDesktop.ts */
  desktopBreakpointPx: 768,

  /** Debounce delay before a search input triggers a fetch. */
  searchDebounceMs: 250,

  /** How long a toast stays on screen before auto-dismissing. */
  toastDurationMs: 4000,

  /** Simulated MockApi network latency range - keeps skeletons/loaders visible. */
  mockApiLatencyMinMs: 120,
  mockApiLatencyMaxMs: 350,

  /** MockApi batches localStorage writes at most this often. */
  persistDebounceMs: 500,

  /** Demo dataset size + seed (deterministic - see data/generator.ts). */
  demoVoterCount: 5000,
  demoSeed: 1948,

  /** Campaign goal = this fraction of total voters, rounded up to the nearest 100. */
  campaignGoalRatio: 0.3,
  campaignGoalMinimum: 1000,

  /** An activist counts as "active" if they tagged someone within this window. */
  activeActivistWindowDays: 7,

  /** KPI count-up animation duration. */
  countUpDurationMs: 900,

  /** Voter registry pagination - page-size choices and the default selection. */
  voterPageSizeOptions: [10, 25, 50, 100] as number[],
  defaultVoterPageSize: 10,

  /** Import wizard preview + skipped-row report limits. */
  importPreviewRowCount: 5,
  importSkippedListLimit: 50,

  /** Activist detail drawer - weekly activity chart span. */
  weeklyActivityWeeks: 8,

  /** Days shown on the dashboard classification trend chart. */
  dashboardTrendDays: 30,

  /** Dashboard "supporters by city" bar chart - top N cities shown. */
  dashboardTopCitiesCount: 8,

  /** Election day countdown clock refresh interval. */
  electionDayCountdownTickMs: 1000,

  /** Election day ride-list pagination - page-size choices and the default selection. */
  electionDayPageSizeOptions: [10, 25, 50, 100] as number[],
  defaultElectionDayPageSize: 10,
} as const;
