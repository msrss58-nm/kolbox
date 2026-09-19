export const APP_SHELL_TEXT = {
  logout: "התנתקות",
  // ORIGIN SEPARATION cutover - shown by PlatformOriginRedirect on the
  // election surface while it bounces an old Platform Owner URL to the
  // canonical Platform origin.
  platformMovedTitle: "מסך בעל הפלטפורמה עבר לכתובת חדשה",
  platformMovedBody: "מעבירים אתכם לכתובת החדשה…",
  platformMovedLink: "מעבר לכתובת החדשה",
  // Shown by VoterManagementGuard when the signed-in workspace is not
  // entitled to the Voter Management module.
  voterManagementUnavailableTitle: "ניהול בוחרים אינו זמין",
  voterManagementUnavailableHint:
    "המודול אינו מופעל עבור סביבת העבודה הזו. פנו למנהל המערכת.",
} as const;

/** Copy for the unified application entry (`EntryScreen`). The worker form's
 * own field labels stay in `ELECTION_DAY_TEXT.session` - only the entry-level
 * framing and the realm options live here. */
export const ENTRY_TEXT = {
  title: "כניסה לקולבוקס",
  subtitle: "הזינו את קוד המערכת ואת פרטי המשתמש שלכם",
  /** Heading of the secondary block. The worker form above is the primary,
   * far more common path; these are the owner realms. */
  ownersLabel: "כניסת בעלים",
  electionOwner: "בעלי מערכת בחירות",
  platformOwner: "בעלי הפלטפורמה",
  multiEntityOwner: "בעלי מספר מערכות",
  /** Said once, for the two realms served from their own address. */
  otherOriginHint: "נפתח בכתובת נפרדת",
} as const;
