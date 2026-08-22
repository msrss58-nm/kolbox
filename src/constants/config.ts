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

  /** Election day contact-modal notes textarea autosave debounce. */
  electionDayNotesAutosaveMs: 800,

  /** Dashboard "מוקדי תשומת לב" - a contact counts as "no answer" once its
   * call-attempts counter reaches this many dials. */
  electionDayAttentionCallAttemptsThreshold: 2,

  /** Dashboard "מוקדי תשומת לב" coordinator-overload alert - the most-loaded
   * coordinator's open (remaining) count must be at least this high before
   * it's worth flagging. */
  electionDayAttentionCoordinatorOverloadFloor: 10,

  /** Dashboard turnout-pace chart - bucket size for the cumulative votes
   * curve and for the "last hour" / "previous hour" pace stats. */
  electionDayPaceBucketMinutes: 60,

  /** `OverdueReminderStack` re-evaluates which reminders are DUE on this
   * interval, so a reminder that crosses into "due" while the tab stays
   * open appears without needing a data refetch. */
  electionDayReminderPopupTickMs: 15_000,

  /** `OverdueReminderStack` shows at most this many popup cards at once;
   * the rest collapse into a single "עוד N תזכורות" summary line. */
  electionDayReminderPopupVisibleCount: 5,

  /** `CoordinatorReminderSupervisionCard` (manager Dashboard "תזכורות
   * לטיפול") shows at most this many coordinator rows before collapsing
   * the rest behind "הצג את כל האחראים (N)" - keeps the card usable at
   * 50+ coordinators without becoming a full-page list. */
  electionDayReminderSupervisionVisibleCount: 6,
} as const;
