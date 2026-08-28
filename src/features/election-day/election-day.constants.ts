import { fmtVotedPct } from "../../lib/utils";
import type { Permission, RoleScopeType } from "../../permissions/types";

export const REMINDER_MINUTES_OPTIONS = [15, 30, 60] as const;
export type ReminderMinutes = (typeof REMINDER_MINUTES_OPTIONS)[number];

/** Dynamic Roles & Permissions Phase 2: Hebrew label for every entry in
 * `ALL_PERMISSIONS` (src/permissions/permissionsMap.ts) - the role editor's
 * permission checkbox list reads through this so a new permission added to
 * the code catalog fails to compile here (an exhaustive `Record`) rather
 * than silently rendering as a raw camelCase key. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "voter.markVoted": "סימון הצבעה",
  "voter.manageReminder": "ניהול תזכורות",
  "voter.manageRide": "ניהול הסעות",
  "voter.editPhone": "עריכת טלפון",
  "voter.editNotes": "עריכת הערות",
  "electionDay.import": "ייבוא קובץ בוחרים",
  "electionDay.clearData": "מחיקת נתונים",
  "electionDay.export": "ייצוא דוחות",
  "electionDay.manageSettings": "ניהול הגדרות (יעד זמן)",
  "electionDay.manageUsers": "ניהול הרשאות משתמשים",
  "electionDay.manageRideCoordinators": "ניהול אחראי הסעות",
  "electionDay.manageRolesAndPermissions": "ניהול תפקידים והרשאות",
  "electionDay.manageNonVotingReasons": "ניהול סיבות אי-הצבעה",
  "electionDay.manageCoordinatorAllocation": "ניהול הקצאות ביום הבחירות",
  "app.accessFullNavigation": "גישה לתפריט הראשי המלא",
  "voter.viewName": "צפייה בשם",
  "voter.viewAddress": "צפייה בכתובת",
  "voter.viewPhone": "צפייה בטלפון",
  "voter.viewMasad": "צפייה במסד",
  "voter.viewCoordinator": "צפייה באחראי",
  "voter.viewNotes": "צפייה בהערות",
  "voter.viewReminderStatus": "צפייה בסטטוס תזכורת",
  "voter.viewReminderHistory": "צפייה בהיסטוריית תזכורות",
  "voter.viewRideStatus": "צפייה בסטטוס הסעה",
  "voter.viewVotedStatus": "צפייה בסטטוס הצבעה",
};

export const ROLE_SCOPE_LABELS: Record<RoleScopeType, string> = {
  all: "כל אנשי הקשר",
  assigned_to_me: "רק המוקצים לי",
};

export const ELECTION_DAY_TEXT = {
  title: '📊 חמ"ל בחירות - מערכת שליטה',
  subtitle: "ניהול, סינון וחיוג ישיר לבוחרים בלחיצת כפתור",
  loadingSubtitle: "טוען…",

  /** Election Day Navigation Redesign: the action-area accordion's 5
   * top-level categories. Every sub-action inside them keeps its own
   * existing label (exportReport/snapshotReport/coordinatorsManager/etc.
   * below) unchanged - only these category headers are new. */
  nav: {
    files: { icon: "📁", label: "ניהול קבצים" },
    permissions: { icon: "👥", label: "ניהול הרשאות ומשתמשים" },
    rides: { icon: "🚗", label: "ניהול אחראי הסעות" },
    reasons: { icon: "📋", label: "סיבות אי הצבעה" },
    reports: { icon: "📑", label: "דוחות" },
  },

  /** Navigation Refactor: tab labels for the two-tab pages the old
   * accordion's "permissions"/"rides" categories became - the content
   * itself is unchanged (`PermissionUsersPanel`/`RoleManagementPanel`,
   * `RideCoordinatorsPanel`/`RideCoordinationTable`), only the container. */
  permissionsPage: {
    usersTab: "משתמשים",
    rolesTab: "תפקידים",
  },

  ridesPage: {
    coordinatorsTab: "אחראי הסעות",
    tableTab: "טבלת ההיסעים",
  },

  searchPlaceholder: "🔍 חיפוש לפי שם או טלפון…",
  searchAriaLabel: "חיפוש אנשי קשר",
  clearSearchAriaLabel: "ניקוי חיפוש",

  /** Voters screen's collapsible filter area (Shell navigation refactor) -
   * collapsed by default, see `ElectionDayVotersPage.tsx`. */
  filters: {
    sectionLabel: "סינון",
  },

  permissionDenied: "אין לך הרשאה לבצע פעולה זו",

  countdown: {
    label: "יעד",
    noDeadline: "לא נקבע יעד",
    expired: "הזמן הגיע!",
    setDeadline: "קביעת יעד",
    deadlineFieldLabel: "תאריך ושעה יעד",
    days: "ימים",
    hours: "שעות",
    minutes: "דקות",
    seconds: "שניות",
    toast: {
      saved: "היעד נשמר",
    },
  },

  import: {
    button: "טען קובץ בוחרים",
    columnsHint:
      "עמודות נדרשות: שם פרטי, שם משפחה (אחראי/טלפון/רחוב/מס' בית/עיר אופציונליים)",
    confirmTitle: "החלפת רשימת הבוחרים",
    confirmMessage:
      "הייבוא יחליף לחלוטין את רשימת אנשי הקשר הקיימת - כולל כל סימוני ההצבעה וסטטוס ההסעות שכבר נרשמו היום. פעולה זו אינה הפיכה.",
    confirmButton: "טענו את הקובץ",
    toast: {
      loaded: (imported: number, total: number, rejected: number) =>
        rejected === 0
          ? `נטענו ${imported} אנשי קשר`
          : `נטענו ${imported} מתוך ${total} אנשי קשר - ${rejected} נדחו, ראו פירוט למטה`,
      missingColumns: "לא זוהו כל העמודות הנדרשות (שם פרטי / שם משפחה) בקובץ",
      empty: "הקובץ ריק",
    },
    summary: {
      title: "סיכום הייבוא האחרון",
      imported: (n: number) => `נקלטו: ${n}`,
      rejected: (n: number) => `נדחו: ${n}`,
      reasons: {
        missingName: "חסר שם פרטי/משפחה",
        duplicate: "כפילות (זהה לרשומה קודמת בקובץ)",
      },
      downloadButton: "⬇️ הורדת רשומות שנדחו",
      dismiss: "סגירה",
    },
  },

  clearAll: {
    button: "מחק קובץ בוחרים",
    confirmTitle: "מחיקת קובץ הבוחרים",
    confirmMessage: "כל אנשי הקשר וסטטוס ההסעות יימחקו לצמיתות. פעולה זו אינה הפיכה.",
    confirmButton: "מחקו",
    toast: {
      cleared: "קובץ הבוחרים נמחק",
    },
  },

  exportReport: {
    button: "ייצא דוח הצבעות",
    toast: {
      empty: "אין נתונים לייצוא",
    },
  },

  snapshotReport: {
    button: "שלח דוח תמונת מצב",
    message: (opts: {
      time: string;
      total: number;
      voted: number;
      votedPct: number;
      coordinators: { name: string; total: number; voted: number }[];
    }) =>
      [
        `דוח תמונת מצב הצבעות לשעה ${opts.time}`,
        "",
        `סה"כ בוחרים: ${opts.total}`,
        `כמה הצביעו: ${opts.voted}`,
        `אחוז הצבעה: ${fmtVotedPct(opts.votedPct)}`,
        "",
        ...opts.coordinators.map(
          (c) => `${c.name}: ${c.total} בוחרים, ${c.voted} הצביעו`,
        ),
        "",
        "יש להגביר את הקצב - כל קול קובע!",
      ].join("\n"),
  },

  coordinatorFilter: {
    label: "אחראי",
    all: "כל האחראים",
  },

  cityFilter: {
    label: "עיר",
    all: "כל הערים",
  },

  /** Voter's own voted/not-voted state - reuses the same `voted` field as
   * every other voted-status UI, not a new concept. Replaces the old
   * standalone `showUnvotedOnly` toggle button. */
  voteStatusFilter: {
    label: "סטטוס הצבעה",
    all: "סטטוס הצבעה",
    options: {
      notVoted: "לא הצביע",
      voted: "הצביע",
    },
  },

  statusFilter: {
    label: "סטטוס הסעה",
    all: "סטטוס הסעה",
  },

  reasonFilter: {
    label: "סיבת אי-הצבעה",
    all: "כל הסיבות",
  },

  /** Coordinator worklist filter ("מצב טיפול") - built on top of
   * `followUpStatus.ts`'s `FollowUpStatus`. */
  followUpFilter: {
    label: "מצב טיפול",
    all: "כל המצבים",
    options: {
      remaining: "נותרו לטיפול",
      closed: "נסגרו",
      voted: "הצביעו",
    },
  },

  dashboard: {
    totalContacts: 'סה"כ אנשי קשר',
    arranged: "הסעות תואמו",
    remaining: "נותרו לתיאום",
    coveragePct: "אחוז השלמה",
    byCoordinator: "התקדמות לפי אחראי",
    byCoordinatorEmpty: "אין נתונים עדיין",
    /** Coordinator worklist stat cards (see `ElectionDayStats.remaining`/
     * `.closed`) - `assigned` reuses the existing `stats.total`, no new
     * field needed for it. */
    worklist: {
      assigned: "הוקצו",
      closed: "נסגרו",
      remaining: "נותרו לטיפול",
      /** Row 2's leading tile - the coordinator-worklist "closed" total,
       * unconditionally shown even when no reason breakdown tile qualifies
       * (see `closedReasonBreakdown.ts`). */
      totalClosed: 'סה"כ נסגרו',
    },
    recentActivity: {
      title: "פעילות אחרונה",
      empty: "אין עדיין הסעות שתואמו",
    },
    votingProgress: {
      title: "קצב התקדמות ההצבעות",
      progressLabel: (voted: number, total: number) => `${voted} מתוך ${total} הצביעו`,
      pieTitle: "יחס הצבעה",
      voted: "הצביעו",
      notVoted: "טרם הצביעו",
      totalVoters: 'סה"כ בוחרים',
      totalVoted: 'סה"כ הצביעו',
      votingPct: "אחוז הצבעה",
    },
    rideCoordination: {
      title: "תיאום הסעה",
      empty: "אין הסעות הממתינות כרגע",
      statusRequested: "דרישה להסעה",
      statusPending: "תואם הסעה",
      statusDone: "בוצע הסעה",
      toast: {
        done: "ההסעה סומנה כבוצעה",
        undone: "הסימון בוטל",
      },
    },
    refresh: {
      label: "רענון",
      lastUpdated: (time: string) => `עודכן לאחרונה: ${time}`,
    },
    /** Row 3 - "מה דורש טיפול עכשיו": a mutually-exclusive partition of the
     * coordinator worklist's "remaining" bucket (see `followUpBreakdown.ts`). */
    followUp: {
      title: "מה דורש טיפול עכשיו",
      callAttempts2Plus: "ניסיונות חיוג 2+",
      reminderDue: "תזכורות לטיפול עכשיו",
      reminderWaiting: "תזכורות עתידיות",
      notYetHandled: "לא טופלו עדיין",
      /** Reminder Lifecycle v1 - replaces the `notYetHandled` tile in
       * `ElectionDayDashboard.tsx`'s row 3 (see `useElectionDay.ts`'s
       * `closedRemindersToday`). */
      closedToday: "תזכורות שנסגרו",
    },
    /** Drill-down list for `followUp.callAttempts2Plus` - same underlying
     * data (`buildCallAttemptsWatchlist`), never a different set/count. */
    callAttemptsWatchlist: {
      title: "בוחרים עם 2+ ניסיונות חיוג",
      empty: "אין כרגע בוחרים עם 2+ ניסיונות חיוג",
      noCoordinator: "ללא אחראי",
      /** "ניסיון אחרון" placeholder when lastCallAttemptAt is null. */
      noLastAttempt: "—",
    },
    /** Row 4 - ride pipeline counts (see `rideStatusBreakdown.ts`). */
    rideStatus: {
      title: "הסעות",
      needsRide: "צריכים הסעה",
      arranged: "הסעה תואמת",
      completed: "הסעה הושלמה",
    },
    performance: {
      title: "ביצועי אחראים",
      empty: "אין נתונים עדיין",
      columns: {
        coordinator: "אחראי",
        votedPct: "אחוז הצבעה",
        open: "פתוחים",
        closed: "נסגרו",
        voted: "הצביעו",
        assigned: "הוקצו",
      },
      totalsRow: 'סה"כ',
    },
    /** Manager Dashboard Reminders ("תזכורות לטיפול") - supervisory view,
     * one tile per coordinator with at least one DUE reminder (see
     * `coordinatorReminderSupervision.ts`). Manager-only (`role.scopeType
     * === "all"`) - distinct from, and does not replace, the personal
     * popup stack (`OverdueReminderStack.tsx`) a scoped coordinator sees. */
    reminderSupervision: {
      title: "תזכורות לטיפול",
      empty: "אין תזכורות שממתינות לטיפול",
      dueCount: (count: number) =>
        count === 1 ? "תזכורת אחת ממתינה" : `${count} תזכורות ממתינות`,
      oldestWaiting: (duration: string) => `הוותיקה ממתינה ${duration}`,
      showAll: (count: number) => `הצג את כל האחראים (${count})`,
      showFewer: "הצג פחות",
      modal: {
        header: (coordinator: string) => `אחראי: ${coordinator}`,
        voterColumn: "בוחר",
        reminderTimeColumn: "מועד התזכורת",
        waitingColumn: "ממתינה כבר",
        phoneLabel: (phone: string) => `טלפון: ${phone}`,
        callButton: (name: string) => `📞 התקשר ל${name}`,
      },
    },
    /** "קצב הצבעה" - cumulative turnout-over-time chart (see `turnoutPace.ts`). */
    pace: {
      title: "קצב הצבעה",
      chartTitle: "הצבעות מצטברות לאורך היום",
      now: "עכשיו",
      changeFromPrevHour: "שינוי מהשעה הקודמת",
      currentPace: "קצב נוכחי",
      currentPaceUnit: "לשעה",
      lastHour: "בשעה האחרונה",
      votedSeries: "הצביעו",
    },
    /** "מוקדי תשומת לב" - see `attentionAlerts.ts`. */
    attention: {
      title: "מוקדי תשומת לב",
      empty: "אין כרגע מוקדי תשומת לב",
      callAttempts: (count: number) => `${count} ניסיונות 2+ ללא מענה`,
      callAttemptsHint: "דחוף להתקשר שוב",
      ridesUnmatched: (count: number) => `${count} הסעות עדיין לא תואמו`,
      ridesUnmatchedHint: "דורש תיאום מיידי",
      coordinatorOverload: (count: number, coordinator: string) =>
        `${count} נותרו לטיפול ל${coordinator}`,
      coordinatorOverloadHint: "מומלץ לחלק מחדש",
      remindersOverdue: (count: number) => `${count} תזכורות שהגיע זמנן טרם טופלו`,
      remindersOverdueHint: "יש לבצע כעת",
    },
  },

  list: {
    columns: {
      masad: "מסד",
      name: "שם מלא",
      street: "רחוב",
      houseNumber: "מס' בית",
      city: "עיר",
      address: "כתובת",
      phone: "טלפון",
      coordinator: "אחראי",
      notes: "הערות",
      status: "סטטוס",
    },
    empty: {
      title: "אין עדיין אנשי קשר",
      hint: "טענו קובץ אקסל כדי להתחיל לתאם הסעות",
    },
    noMatches: {
      title: "לא נמצאו התאמות",
      hint: "נסו לשנות את הסינון",
    },
  },

  status: {
    arranged: "הסעה תואמה",
    notArranged: "טרם תואמה",
    toast: {
      arranged: "הסעה סומנה כתואמה",
      notArranged: "הסימון בוטל",
    },
  },

  voted: {
    voted: "הצביע",
    notVoted: "לא הצביע",
    markButton: "סימון כהצביע",
    unmarkButton: "בטל סימון הצבעה",
    toast: {
      voted: "סומן כהצביע",
      notVoted: "הסימון בוטל",
      reasonSet: "סיבת אי-ההצבעה נשמרה",
    },
    /** Shown only while voted = false - the reason is never cleared when
     * voted flips to true (kept for history/reports), it just stops being
     * offered for editing (see useElectionDay.ts's setNonVotingReason). */
    reasonLabel: "סיבת אי-הצבעה",
    reasonPlaceholder: "בחרו סיבה (אופציונלי)",
    reasonNoneOption: "בחר סיבה",
  },

  reminder: {
    badge: "תזכורת",
    button: "תזכורת",
    cancelButton: "ביטול תזכורת",
    /** Opens the same shared `DateTimePicker` used elsewhere in the app for
     * an arbitrary date+time - see `ReminderMenu.tsx`. */
    customOption: "קביעת שעה",
    customConfirm: "אישור",
    /** `formatted` is `formatReminderDisplay(reminderAt)`'s output (e.g.
     * "בשעה 22:00" or "ב-17/08/2026 בשעה 22:00"). */
    activeLabel: (formatted: string) => `תזכורת ${formatted}`,
    /** Reminder Lifecycle v1: shown instead of `activeLabel` once the
     * reminder's time has passed (state === "due") - see
     * `reminderLifecycle.ts`. */
    dueLabel: "הגיע מועד התזכורת",
    /** Reminder Lifecycle v1: closes an outstanding (future or due)
     * reminder via `onCloseReminder` - only offered while due. */
    closeButton: "סמן כטופל",
    /** Reminder Lifecycle v1: relabels the reschedule action once a
     * reminder is already outstanding (future or due) - wired to the same
     * `ReminderMenu` as a fresh reminder, unchanged. Deliberately NOT
     * phrased as "set a new reminder" - at most one reminder is ever active
     * per voter, so this changes the EXISTING one's time, never adds a
     * second. */
    rescheduleButton: "שנה מועד",
    options: {
      15: "15 דקות",
      30: "30 דקות",
      60: "שעה",
    },
    toast: {
      set: (label: string) => `התזכורת נקבעה - בעוד ${label}`,
      /** For the custom-time path - `formatted` is the same
       * `formatReminderDisplay` output `activeLabel` uses. */
      setAt: (formatted: string) => `התזכורת נקבעה ${formatted}`,
      cancelled: "התזכורת בוטלה",
      /** Reminder Lifecycle v1 - fired by `onCloseReminder`'s success
       * handler in `useElectionDay.ts`. */
      closed: "התזכורת סומנה כטופלה",
    },
    /** Reminder Lifecycle v1: the collapsible per-contact audit trail in
     * `ElectionDayContactModal.tsx`, gated by `voter.viewReminderHistory`. */
    history: {
      sectionTitle: "היסטוריית תזכורות",
      empty: "אין היסטוריית תזכורות",
      eventLabel: {
        created: "תזכורת נקבעה",
        closed: "תזכורת נסגרה",
        cancelled: "תזכורת בוטלה",
        rescheduled: "תזכורת נדחתה",
        no_answer: "לא ענה",
        answered: "ענה",
        streak_extended: "הוארכו הניסיונות (+3)",
      },
      reasonLabel: {
        handled: "טופל ידנית",
        voted: "הבוחר הצביע",
        case_closed: "התיק נסגר",
        no_answer: "נסגרה עקב ניסיון חיוג ללא מענה",
        answered: "נסגרה עקב מענה בשיחה",
      },
      /** `name` is `ReminderEvent.actorName` - denormalized, audit-only
       * informational text, NOT a verified/authenticated identity (mirrors
       * this app's existing security model for `PermissionUser`, which has
       * no real backing identity - see CLAUDE.md). Only rendered when
       * `actorName` is non-null; never shown as a fallback "unknown" line. */
      actorPrefix: (name: string) => `על ידי ${name}`,
    },
    /** Persistent Reminders: `OverdueReminderStack`'s left-side popup cards -
     * replaces the old auto-dismissing toast (`toast.due`, removed). Stays
     * on screen until the existing call action or a reschedule (via
     * `postponeButton`, which reuses `ReminderMenu` as-is) removes it. */
    popup: {
      /** The compact collapsed bar's label (multi-reminder case only) -
       * clicking it toggles the expanded list open/closed. */
      barLabel: (n: number) => `יש לך ${n} תזכורות לטיפול`,
      moreCount: (n: number) => `עוד ${n} תזכורות`,
      /** Concise status label on each card/row - single-reminder card and
       * every row in the expanded multi-reminder list. */
      cardLabel: "תזכורת לטיפול",
      /** The single-reminder card's explicit call-to-action (opens the full
       * contact modal - same `onOpen` the card itself, and every row in the
       * multi-reminder list, already responds to on click). */
      openButton: "פתח בוחר",
      /** The single-reminder card's due-time line - `time` is just the
       * "HH:MM" portion (not the full `formatReminderDisplay` sentence,
       * which this card doesn't reuse - it's always showing a reminder
       * that's already due "now," so the generic "on <date> at <time>"
       * phrasing that function is built for doesn't fit here). */
      dueTimeLabel: (time: string) => `המועד הגיע ב־${time}`,
    },
  },

  modal: {
    call: "חיוג מהיר",
    noPhone: "לא צוין טלפון",
    addPhoneButton: "הוסף מספר",
    editPhoneAriaLabel: "עריכת מספר טלפון",
    rideRequestButton: "דרישה להסעה",
    rideRequestActiveLabel: "יש דרישה להסעה",
    cancelCoordinationButton: "בטל תיאום",
    coordinatedLabel: "תואם",
    /** Final 6/6 State-Safety Fix: replaces the call button/outcome buttons
     * once `resolveFollowUpStatus(contact, reasonsById) === "closed"` (a
     * non-voting reason with `requiresFollowUp: false`) - reopening is an
     * explicit future action, never an accidental consequence of dialing,
     * so no call affordance is offered here at all while closed. */
    caseClosedLabel: "הבוחר נסגר כ״לא עונה״ - לא נדרש חיוג נוסף",
  },

  /** Call Outcome Tracking - a "streak/threshold" badge shown once the
   * no-answer streak's outcome buttons resolve back to nothing pending.
   * Reaching the threshold (3, then capped at 6) auto-opens a non-dismissible
   * decision dialog. */
  callAttempts: {
    /** noAnswerStreak/noAnswerStreakThreshold - NOT the total dial count. */
    count: (streak: number, threshold: number) => `${streak}/${threshold}`,
    /** Always-visible label near the call controls (unlike `totalCount`
     * below, which only shows once no outcome is pending) - same "X/Y" shape
     * as `count` above, just with the Hebrew label prefixed. */
    streakLabel: (streak: number, threshold: number) =>
      `ללא מענה: ${streak}/${threshold}`,
    /** Total raw dial-button clicks (`callAttempts`), shown only while no
     * outcome is pending - distinct from `count`/`streakLabel` above. */
    totalCount: (totalDials: number) => `סה"כ חיוגים: ${totalDials}`,
    noAnswerButton: "לא ענה",
    answeredButton: "ענה",
    /** The pre-existing non-voting reason "close as לא עונה" resolves to -
     * matched by `name` against the loaded `nonVotingReasons` catalog, since
     * that catalog is data (no stable id constant to key off). */
    noAnswerReasonName: "לא עונה",
    /** `isFinal` = the capped 6th checkpoint (no further extension offered)
     * vs. the first, 3rd checkpoint (extend is still an option). */
    dialogTitle: (isFinal: boolean) =>
      isFinal ? "בוצעו 6 ניסיונות חיוג ללא מענה" : "בוצעו 3 ניסיונות חיוג ללא מענה",
    /** `voterName` is the full name (first + last), same as everywhere else
     * in this modal. */
    dialogBody: (voterName: string, isFinal: boolean) =>
      isFinal
        ? `בוצעו שישה ניסיונות חיוג לבוחר:\n${voterName}\nללא מענה, ולא ניתן להאריך יותר.\n\nהבוחר ייסגר כ"לא ענה".`
        : `בוצעו שלושה ניסיונות חיוג לבוחר:\n${voterName}\nולא התקבל מענה.\n\nמה תרצה לעשות?`,
    /** The one combination with no action button (see CallAttemptsDialog's
     * own doc comment: capped checkpoint + a role without voter.markVoted) -
     * an informational, dismissible message instead of a forced choice. */
    dialogBodyNoPermission: (voterName: string) =>
      `בוצעו שישה ניסיונות חיוג לבוחר:\n${voterName}\nללא מענה.\n\nנדרש משתמש עם הרשאת סימון הצבעה כדי לסגור אותו כ"לא ענה".`,
    closeAsNoAnswerButton: 'סגור את הבוחר כ"לא עונה"',
    continueButton: "המשך ניסיונות (+3)",
  },

  phoneEditor: {
    addTitle: "הוספת מספר טלפון",
    editTitle: "עדכון מספר טלפון",
    phoneLabel: "מספר טלפון",
    phonePlaceholder: "050-1234567",
    invalidPhone: "מספר טלפון לא תקין",
    saveButton: "שמירה",
    toast: {
      saved: "מספר הטלפון נשמר",
    },
  },

  notes: {
    /** Collapsed-state trigger label - the field itself opens only once
     * requested; an already-saved note is still shown as read-only text
     * beneath this trigger even while collapsed. */
    addButton: "הוסף הערה",
    /** The expanded editor's own heading, once open. */
    label: "הערות ועדכוני סטטוס",
    placeholder: "לדוגמה: הבטיח לצאת ב-18:00, לא עונה, צריך לברר לגבי המשפחה...",
    saving: "שומר...",
    saved: "נשמר בהצלחה",
  },

  /** Short tags appended to the free-text notes field (see `notesTags.ts`) -
   * additive, never overwrite whatever the activist already typed there. */
  noteTags: {
    rideRequested: "נדרש הסעה",
    rideArranged: "תואם",
  },

  driver: {
    sendButton: "תיאום הסעה",
    message: (voter: { name: string; address: string; phone: string | null }) =>
      `שלום, עליך לתאם עם הבוחר הר"מ שעת איסוף שלו להצבעה ובסיום ההצבעה עליך להחזירו לביתו.\n\nשם ומשפחה: ${voter.name}\nכתובת מלאה: ${voter.address || "לא צוינה כתובת"}\nטלפון: ${voter.phone || "לא צוין טלפון"}\n\nבסיום יש לסמנו כבוצע הסעה.\nתודה, צוות החמ"ל`,
    cancelMessage: (voter: { name: string; address: string; phone: string | null }) =>
      `שלום, נא לבטל את ההסעה שתואמה עבור הבוחר הר"מ.\n\nשם ומשפחה: ${voter.name}\nכתובת מלאה: ${voter.address || "לא צוינה כתובת"}\nטלפון: ${voter.phone || "לא צוין טלפון"}\n\nתודה, צוות החמ"ל`,
    toast: {
      sent: "וואטסאפ נפתח - בחרו את הנהג ושלחו",
    },
  },

  coordinatorsManager: {
    button: "ניהול אחראי הסעות",
    modalTitle: "ניהול אחראי הסעות",
    nameLabel: "שם",
    namePlaceholder: "שם האחראי",
    phoneLabel: "טלפון",
    phonePlaceholder: "05X-XXXXXXX",
    addButton: "הוספה",
    deleteAriaLabel: "מחיקת אחראי הסעות",
    empty: "לא נוספו אחראי הסעות עדיין",
    toast: {
      added: "אחראי ההסעות נוסף",
      deleted: "אחראי ההסעות הוסר",
      invalid: "יש להזין שם וטלפון",
    },
  },

  /** Security Hardening (Reauth): shared copy for the 8 admin/import
   * mutations gated by a short-lived server-verified re-auth proof
   * (`election_day_reauth`) - reuses `AllocationPasswordDialog`'s existing
   * visual pattern (mirrors `coordinatorAllocation.confirmDialog` above)
   * rather than inventing new dialog chrome per surface. */
  reauth: {
    passwordLabel: "הסיסמה שלך",
    showPasswordAriaLabel: "הצג סיסמה",
    hidePasswordAriaLabel: "הסתר סיסמה",
    cancelButton: "ביטול",
    confirmButton: "אישור",
    dialogTitle: "אימות מחדש נדרש",
    dialogs: {
      addPermissionUser: (name: string) =>
        `כדי להוסיף את המשתמש "${name}" יש לאמת מחדש את הסיסמה שלך.`,
      deletePermissionUser: (name: string) =>
        `כדי למחוק את המשתמש "${name}" יש לאמת מחדש את הסיסמה שלך.`,
      resetPermissionUserPassword: (name: string) =>
        `כדי לאפס את הסיסמה של "${name}" יש לאמת מחדש את הסיסמה שלך.`,
      createRole: "כדי ליצור תפקיד חדש יש לאמת מחדש את הסיסמה שלך.",
      updateRole: (name: string) =>
        `כדי לעדכן את התפקיד "${name}" יש לאמת מחדש את הסיסמה שלך.`,
      deleteRole: (name: string) =>
        `כדי למחוק את התפקיד "${name}" יש לאמת מחדש את הסיסמה שלך.`,
      cloneRole: (name: string) =>
        `כדי לשכפל את התפקיד "${name}" יש לאמת מחדש את הסיסמה שלך.`,
      importVoters: "כדי לטעון את קובץ הבוחרים יש לאמת מחדש את הסיסמה שלך.",
    },
    /** Phase 3C frontend cutover: error copy for the trusted v3
     * create_permission_user flow (POST /api/election-day/reauth then POST
     * /api/election-day/permission-users) - a separate, session-derived
     * path from the legacy proof flow above, so it gets its own small copy
     * block rather than reusing `dialogs`/legacy RPC error text verbatim. */
    trustedCreateErrors: {
      wrongPassword: "הסיסמה שהזנת אינה נכונה",
      rateLimited: "יותר מדי ניסיונות. נסו שוב בעוד כמה דקות",
      sessionExpired: "פג תוקף האימות. נסו שוב",
      forbidden: "אין לך הרשאה לבצע פעולה זו",
      roleNotFound: "התפקיד שנבחר אינו זמין עוד. רעננו את העמוד ונסו שוב",
      duplicateName: "שם המשתמש אינו זמין. בחר שם אחר.",
      generic: "אירעה שגיאה, נסו שוב",
    },
    /** Phase 3C Users (EXPAND, not yet wired to the frontend): error copy for
     * the trusted, one-time-consumed-proof v3 delete/reset-password flows
     * (useDeletePermissionUserTrusted.ts / useResetPermissionUserPasswordTrusted.ts).
     * Shares wrongPassword/rateLimited/sessionExpired/forbidden/generic
     * wording with trustedCreateErrors above (identical failure meaning),
     * adds the two error shapes specific to these two RPCs. */
    trustedUserErrors: {
      wrongPassword: "הסיסמה שהזנת אינה נכונה",
      rateLimited: "יותר מדי ניסיונות. נסו שוב בעוד כמה דקות",
      sessionExpired: "פג תוקף האימות. נסו שוב",
      forbidden: "אין לך הרשאה לבצע פעולה זו",
      cannotDeleteSelf: "לא ניתן למחוק את המשתמש שלך",
      userNotFound: "המשתמש אינו קיים",
      invalidPassword: "יש להזין סיסמה חדשה",
      generic: "אירעה שגיאה, נסו שוב",
    },
  },

  permissionsManager: {
    button: "ניהול הרשאות משתמשים",
    modalTitle: "הוסף משתמש",
    nameLabel: "שם",
    namePlaceholder: "שם המשתמש",
    passwordLabel: "סיסמה",
    passwordPlaceholder: "סיסמה",
    showPasswordAriaLabel: "הצג סיסמה",
    hidePasswordAriaLabel: "הסתר סיסמה",
    roleLabel: "הרשאה",
    /** Dynamic Roles & Permissions Phase 2: shown when a user's role can't be
     * resolved from the live catalog (should not normally happen given the
     * DB's FK guarantee). */
    unknownRole: "תפקיד לא ידוע",
    addButton: "הוספה",
    columns: {
      name: "שם",
      role: "הרשאה",
      actions: "פעולות",
    },
    deleteAriaLabel: "מחיקת משתמש",
    empty: "לא נוספו משתמשים עדיין",
    toast: {
      added: "המשתמש נוסף",
      deleted: "המשתמש הוסר",
      invalid: "יש להזין שם וסיסמה",
    },
    confirmDelete: {
      title: "מחיקת משתמש",
      message: (userName: string) =>
        `האם אתה בטוח שברצונך למחוק את המשתמש "${userName}"? פעולה זו תמחק את המשתמש ממערכת יום הבחירות.`,
      confirmButton: "מחק משתמש",
    },
    /** Self-delete protection: the currently signed-in PermissionUser can
     * never delete their own account, neither via the row button (disabled,
     * see `PermissionUsersPanel`) nor via the client handler itself (see
     * `useElectionDay.ts`'s `deletePermissionUserRaw`) - defense in depth,
     * since a hidden/disabled button alone wouldn't stop a direct call. */
    selfDelete: {
      disabledLabel: "לא ניתן למחוק את המשתמש המחובר",
      blockedError: "לא ניתן למחוק את המשתמש המחובר",
    },
    resetPassword: {
      ariaLabel: "איפוס סיסמה",
      dialogTitle: "איפוס סיסמה",
      dialogBody: (userName: string) =>
        `אתה עומד לאפס את הסיסמה עבור המשתמש:\n${userName}`,
      newPasswordLabel: "סיסמה חדשה",
      confirmPasswordLabel: "אימות סיסמה חדשה",
      showPasswordAriaLabel: "הצג סיסמה",
      hidePasswordAriaLabel: "הסתר סיסמה",
      cancelButton: "ביטול",
      submitButton: "אפס סיסמה",
      validation: {
        required: "יש להזין סיסמה חדשה",
        mismatch: "הסיסמאות אינן זהות",
      },
      toast: {
        success: (userName: string) => `הסיסמה של ${userName} אופסה בהצלחה`,
      },
    },
  },

  /** Dynamic Roles & Permissions Phase 2: real role management ("תפקידים"). */
  rolesManager: {
    button: "ניהול תפקידים והרשאות",
    modalTitle: "ניהול תפקידים",
    newRoleButton: "תפקיד חדש",
    editTitle: "עריכת תפקיד",
    createTitle: "תפקיד חדש",
    nameLabel: "שם התפקיד",
    namePlaceholder: "לדוגמה: רכז אזור",
    descriptionLabel: "תיאור",
    descriptionPlaceholder: "תיאור קצר של התפקיד",
    scopeLabel: "תחום עבודה",
    permissionsLabel: "הרשאות",
    saveButton: "שמירה",
    cancelButton: "ביטול",
    cloneButton: "שכפול",
    cloneSuffix: (name: string) => `${name} (עותק)`,
    deleteAriaLabel: "מחיקת תפקיד",
    editAriaLabel: "עריכת תפקיד",
    usersCount: (n: number) => `${n} משתמשים`,
    empty: "לא נוספו תפקידים עדיין",
    confirmDeleteTitle: "מחיקת תפקיד",
    confirmDeleteMessage:
      "פעולה זו אינה הפיכה. תפקידים עם משתמשים משויכים לא ניתנים למחיקה.",
    confirmDeleteButton: "מחיקת התפקיד",
    toast: {
      created: "התפקיד נוצר",
      updated: "התפקיד עודכן",
      deleted: "התפקיד נמחק",
      cloned: "התפקיד שוכפל",
      invalid: "יש להזין שם לתפקיד",
    },
  },

  /** Dynamic Non-Voting Reasons: catalog management ("ניהול סיבות
   * אי-הצבעה") - mirrors `rolesManager` above exactly. */
  nonVotingReasonsManager: {
    button: "ניהול סיבות אי-הצבעה",
    modalTitle: "ניהול סיבות אי-הצבעה",
    newButton: "סיבה חדשה",
    createTitle: "סיבה חדשה",
    editTitle: "עריכת סיבה",
    nameLabel: "שם הסיבה",
    namePlaceholder: "לדוגמה: לא עונה",
    descriptionLabel: "תיאור",
    descriptionPlaceholder: "תיאור קצר (אופציונלי)",
    /** The "דורש המשך טיפול" toggle in the create/edit form - drives the
     * coordinator worklist (see `followUpStatus.ts`). */
    requiresFollowUpLabel: "דורש המשך טיפול",
    saveButton: "שמירה",
    cancelButton: "ביטול",
    activeLabel: "פעילה",
    inactiveBadge: "מושבתת",
    /** Shown next to a reason whose `requiresFollowUp === false` - mirrors
     * `inactiveBadge`'s placement/style, distinct concept (an inactive
     * reason can still require follow-up, and vice versa). */
    closedBadge: "לא דורש טיפול",
    moveUpAriaLabel: "הזזה למעלה",
    moveDownAriaLabel: "הזזה למטה",
    editAriaLabel: "עריכת סיבה",
    deleteAriaLabel: "מחיקת סיבה",
    activateAriaLabel: "הפעלת סיבה",
    deactivateAriaLabel: "השבתת סיבה",
    usageCount: (n: number) => `${n} בוחרים`,
    empty: "לא הוגדרו סיבות אי-הצבעה עדיין",
    confirmDeleteTitle: "מחיקת סיבה",
    confirmDeleteMessage: "פעולה זו אינה הפיכה. סיבות המשויכות לבוחרים לא ניתנות למחיקה.",
    confirmDeleteButton: "מחיקת הסיבה",
    toast: {
      created: "הסיבה נוצרה",
      updated: "הסיבה עודכנה",
      deleted: "הסיבה נמחקה",
      activated: "הסיבה הופעלה",
      deactivated: "הסיבה הושבתה",
      reordered: "הסדר נשמר",
      invalid: "יש להזין שם לסיבה",
    },
  },

  /** Coordinator Allocation Management ("ניהול הקצאות") - Phase 5 UI. */
  coordinatorAllocation: {
    entryButton: "ניהול הקצאות",
    entryHint: "הגדרת אחראים, חלוקת בוחרים וניהול העברות",
    title: "ניהול הקצאות",
    subtitle: "הגדרת אחראים, חלוקת בוחרים וניהול העברות במהלך היום",
    backToFiles: "חזרה לניהול קבצים",

    summary: {
      total: "סך הבוחרים",
      assigned: "כבר עם אחראי",
      unassigned: "ללא אחראי",
      activeCoordinators: "אחראים פעילים",
      noCoordinatorsYet: "0 אחראים הוגדרו",
    },

    toast: {
      coordinatorsSaved: "הרכזים עודכנו",
      initialAllocationApplied: "ההקצאה הראשונית בוצעה",
      rebalanced: "האיזון מחדש בוצע",
      coordinatorEnded: "פעילות הרכז הסתיימה",
    },

    steps: {
      coordinators: "אחראים",
      method: "שיטת חלוקה",
      preview: "תצוגה מקדימה",
      confirm: "אישור",
    },

    roster: {
      nameLabel: "שם האחראי",
      namePlaceholder: "שם האחראי",
      addButton: "הוספת אחראי",
      editAriaLabel: "עריכת שם האחראי",
      removeButton: "הסר אחראי",
      removeAriaLabel: "הסרת אחראי",
      saveAriaLabel: "שמירת שם",
      cancelEditAriaLabel: "ביטול עריכה",
      /** Phone is CONTACT METADATA, not identity (2026-08-22) - shown/edited
       * as its own separate affordance from the name pencil/trash icons
       * above, deliberately available regardless of `isEligibleForEditOrRemove`
       * (it stays editable even when rename/remove are blocked). */
      phoneLabel: "טלפון (לא חובה)",
      phonePlaceholder: "050-1234567",
      addPhoneLink: "הוסף טלפון",
      editPhoneAriaLabel: "עריכת טלפון",
      savePhoneAriaLabel: "שמירת טלפון",
      cancelPhoneEditAriaLabel: "ביטול עריכת טלפון",
      invalidPhone: "מספר טלפון לא תקין",
      empty: "טרם נוספו אחראים",
      emptyHint: "הוסיפו לפחות אחראי אחד כדי להתחיל בחלוקה.",
      duplicateActiveName: "כבר קיים אחראי פעיל בשם זה",
      emptyNameBlocked: "יש להזין שם אחראי",
      endedBadge: "סיים פעילות",
      linkedBadge: (name: string) => `מקושר ל-"${name}"`,
      unlinkButton: "בטל קישור",
      /** Coordinator Delete safety guard (2026-08-21): client-side proxy for
       * "this coordinator currently has assigned voters" (via
       * `countVotersWithRawCoordinatorName`, the same raw display_name match
       * the RPC's own guard uses) - a certain, provable ineligibility shown
       * proactively next to the row, no RPC round trip needed. The
       * complementary "has real participation/history" reason is NOT
       * computable client-side without a per-coordinator RPC call, so that
       * case surfaces only after an attempted rename/remove is rejected by
       * the RPC (via the shared toast, `mapCoordinatorAllocationRpcErrorMessage`) -
       * this is the RPC's own authoritative check, the client merely reflects it. */
      assignedVotersReason:
        "לרכז זה יש בוחרים משויכים כרגע - יש להעביר את ההקצאות תחילה (העבר הקצאות)",
      removeAriaLabelBlocked: "לא ניתן להסיר - יש לרכז זה בוחרים משויכים",
      editAriaLabelBlocked: "לא ניתן לשנות שם - יש לרכז זה בוחרים משויכים",
      confirm: {
        addTitle: "הוספת אחראי",
        addSummary: (name: string) => `הוספת אחראי חדש: ${name}`,
        editTitle: "עדכון שם אחראי",
        editSummary: (from: string, to: string) => `שינוי שם מ-"${from}" ל-"${to}"`,
        editPhoneTitle: "עדכון טלפון אחראי",
        editPhoneSummary: (name: string) => `עדכון מספר הטלפון של "${name}"`,
        removeTitle: "הסרת אחראי",
        removeSummary: (name: string) => `הסרת האחראי "${name}"`,
        unlinkTitle: "ביטול קישור",
        unlinkSummary: (name: string) => `ביטול קישור האחראי "${name}" לרשומת האקסל`,
        confirmButton: "אישור",
      },
      /** Coordinator Allocation auto-preload (revised, 2026-08-20): names
       * already present in the raw `voter.coordinator` column but not yet a
       * persisted `election_day_coordinators` row - shown read-only, never
       * persisted just by viewing them (see `resolveMissingCoordinatorNames`'s
       * own comment). Each carries its own explicit, single-item "add" button
       * - clicking it runs the exact same `onManage([{action:"add",...}])`
       * flow as typing the name manually, just without retyping it. */
      detected: {
        sectionLabel: "אחראים שזוהו בנתוני הבוחרים",
        hint: "השמות הבאים כבר מופיעים בעמודת ה'אחראי' של הבוחרים אך טרם נוספו לרשימת האחראים.",
        addButton: "הוסף",
        addAriaLabel: (name: string) => `הוסף את "${name}" כאחראי`,
      },
    },

    method: {
      title: "בחרו שיטת חלוקה",
      equalTitle: "חלוקה שווה",
      equalDescription: "נחלק את כל הבוחרים ללא אחראי בצורה מאוזנת בין האחראים הפעילים.",
      manualTitle: "חלוקה ידנית",
      manualDescription: "בחר כמה בוחרים יקבל כל אחראי.",
      manualAssignedOf: (assigned: number, total: number) =>
        `הוקצו: ${assigned.toLocaleString("he-IL")} מתוך ${total.toLocaleString("he-IL")}`,
      manualRemaining: (remaining: number) =>
        `נותרו: ${remaining.toLocaleString("he-IL")}`,
      manualUnder: (missing: number) =>
        `חסרים עוד ${missing.toLocaleString("he-IL")} בוחרים לחלוקה`,
      manualOver: (extra: number) =>
        `הוקצו ${extra.toLocaleString("he-IL")} בוחרים יותר מהכמות הזמינה`,
      backButton: "חזרה",
      continueButton: "המשך",
      noActiveCoordinators: "הוסיפו לפחות אחראי אחד כדי להתחיל בחלוקה.",
      allAlreadyAssigned: "כל הבוחרים כבר משויכים לאחראים.",
      goToManagement: "מעבר לניהול היום",
    },

    preview: {
      title: "חלוקה מתוכננת",
      totalLine: (n: number) => `סה"כ ${n.toLocaleString("he-IL")} בוחרים`,
      alreadyAssignedNote: (n: number) =>
        `${n.toLocaleString("he-IL")} בוחרים כבר היו משויכים ולא ישתנו`,
      backButton: "חזרה",
      confirmButton: "אישור החלוקה",
    },

    confirmDialog: {
      applyTitle: "אישור חלוקת בוחרים",
      passwordLabel: "הסיסמה שלך",
      showPasswordAriaLabel: "הצג סיסמה",
      hidePasswordAriaLabel: "הסתר סיסמה",
      applyButton: "בצע חלוקה",
      cancelButton: "ביטול",
    },

    live: {
      stats: {
        total: 'סה"כ בוחרים',
        unassigned: "ללא אחראי",
        activeCoordinators: "אחראים פעילים",
        remaining: "נשארו לטיפול",
      },
      addCoordinatorButton: "הוסף אחראי",
      columns: {
        coordinator: "אחראי",
        totalAssigned: 'סה"כ מוקצים',
        remaining: "נשארו לטיפול",
        status: "סטטוס",
        actions: "פעולות",
      },
      remainingLabel: (n: number) => `נשארו לטיפול: ${n.toLocaleString("he-IL")}`,
      rebalanceButton: "העבר הקצאות",
      endButton: "סיום פעילות",
      statusActive: "פעיל",
      statusEnded: "סיים פעילות",
    },

    rebalance: {
      title: "העברת הקצאות",
      formHint: "ניתן להעביר חלק מהבוחרים בין אחראים פעילים, ללא סיום פעילות האחראי.",
      sourcesTitle: "ממי להעביר",
      destinationsTitle: "למי להעביר",
      quantityAriaLabel: "כמות",
      sourceExceedsRemaining: "הכמות חורגת מהנותר לטיפול אצל אחראי זה",
      transferringTotal: (n: number) => `מעבירים: ${n.toLocaleString("he-IL")}`,
      receivingTotal: (n: number) => `מחלקים: ${n.toLocaleString("he-IL")}`,
      mismatch: "הכמות שיוצאת חייבת להיות שווה לכמות שנכנסת.",
      noSource: "יש לבחור לפחות אחראי מקור אחד עם כמות",
      noDestination: "יש לבחור לפחות אחראי יעד אחד עם כמות",
      sameCoordinatorBothSides: "לא ניתן לבחור אותו אחראי גם כמקור וגם כיעד",
      backButton: "חזרה",
      previewTitle: "תצוגה מקדימה",
      previewFromLabel: "מעבירים",
      previewToLabel: "מקבלים",
      previewTotal: (n: number) => `סה"כ ${n.toLocaleString("he-IL")} בוחרים`,
      confirmButton: "בצע העברה",
      cancelButton: "ביטול",
    },

    end: {
      title: "סיום פעילות אחראי",
      remainingLabel: (n: number) => `נשארו לטיפול: ${n.toLocaleString("he-IL")}`,
      optionTransferTitle: "העבר לאחראי אחד",
      optionTransferDescription: "כל הבוחרים שנשארו יעברו לאחראי שתבחרו.",
      targetLabel: "העבר אל",
      noValidTarget: "אין אחראי פעיל אחר להעביר אליו",
      optionEqualTitle: "חלק שווה בין האחראים הפעילים",
      optionEqualDescription:
        "כל הבוחרים שנשארו יחולקו באופן שווה בין שאר האחראים הפעילים.",
      lastActiveBlocked:
        "לא ניתן לסיים את פעילות האחראי האחרון כל עוד נשארו בוחרים לטיפול.",
      zeroRemainingNote: "לא נשארו בוחרים להעברה. האחראי יסומן כמי שסיים פעילות.",
      confirmTransferSummary: (count: number, from: string, to: string) =>
        `${count.toLocaleString("he-IL")} בוחרים יועברו מ${from} ל${to}.`,
      confirmEqualSummary: (count: number, coordinatorCount: number) =>
        `${count.toLocaleString("he-IL")} בוחרים יחולקו בין ${coordinatorCount.toLocaleString("he-IL")} אחראים פעילים.`,
      confirmButton: "סיים פעילות",
      cancelButton: "ביטול",
    },
  },

  /** Dashboard report card + drill-down: "סיבות אי-הצבעה" - groups
   * non-voting contacts by reason, then by coordinator (see
   * `nonVotingReasonReport.ts`). */
  nonVotingReasonsReport: {
    cardTitle: "סיבות אי-הצבעה",
    empty: "אין עדיין סיבות אי-הצבעה בשימוש",
    rowCount: (n: number) => `${n} בוחרים`,
    drillDownTitle: (reasonName: string) => `${reasonName} - פירוט`,
    byCoordinatorTitle: "לפי אחראי",
    noCoordinator: "ללא אחראי",
    backToAllCoordinators: "חזרה לכל האחראים",
    voterListEmpty: "אין בוחרים להצגה",
    /** Election Day Navigation Redesign: the same report card, reachable a
     * second way - from the "סיבות אי הצבעה" nav category, opened inside
     * `NonVotingReasonsReportModal` (a thin wrapper around the identical
     * `NonVotingReasonsReportCard`, not a second implementation). The
     * dashboard's own inline copy (`cardTitle` above) is unchanged. */
    navButton: "דוח סיבות אי-הצבעה",
    modalTitle: "דוח סיבות אי-הצבעה",
  },

  /** Election Day Navigation Redesign: the existing `RideCoordinationTable`
   * (today inline-only on the dashboard), reachable a second way - from the
   * "ניהול אחראי הסעות" nav category, opened inside `RideTableModal` (a thin
   * wrapper around the identical table component). The dashboard's own
   * inline copy is unchanged. */
  rideTableModal: {
    navButton: "טבלת ההיסעים",
    modalTitle: "טבלת ההיסעים",
  },

  /** Local, non-server login gate for this screen only - checks against the
   * same roster managed in "ניהול הרשאות משתמשים" (see `electionDaySession.ts`). */
  session: {
    title: 'התחברות - חמ"ל בחירות',
    subtitle: "מסך יום הבחירות דורש התחברות נפרדת משאר המערכת",
    nameLabel: "שם משתמש",
    passwordLabel: "סיסמה",
    submit: "התחברות",
    signOut: "התנתקות",
    errors: {
      invalidCredentials: "שם משתמש או סיסמה שגויים",
      /** Phase 3B: no legacy equivalent existed - the pre-cutover login had
       * no rate limiting at all. */
      rateLimited: "יותר מדי ניסיונות התחברות. נסו שוב בעוד כמה דקות",
    },
  },
} as const;
