import { APP_CONFIG } from "../../constants/config";

export const DASHBOARD_TEXT = {
  title: "דשבורד",
  subtitle: "תמונת מצב הקמפיין בזמן אמת",
  empty: {
    title: "אין עדיין נתונים בקמפיין",
    hint: "טענו פנקס בוחרים מקובץ Excel או התחילו מנתוני הדגמה",
    action: "לטעינת נתונים",
  },
  kpi: {
    totalVoters: "סה״כ בוחרים",
    supporters: "תומכים",
    potentials: "מתלבטים",
    opponents: "מתנגדים",
    coverage: "כיסוי הפנקס",
    activeActivists: "פעילים פעילים",
    activeActivistsSub: "בשבוע האחרון",
    weeklyDelta: (n: number) => `+${n} בשבוע`,
  },
  goal: {
    prefix: "יעד הקמפיין:",
    suffix: "תומכים",
    ariaLabel: "התקדמות ליעד",
  },
  charts: {
    trendTitle: `התקדמות הסיווגים · ${APP_CONFIG.dashboardTrendDays} יום`,
    donutTitle: "פילוח הפנקס",
    donutCenterHint: "מהפנקס מסווג",
    cityBarTitle: `תומכים לפי עיר · טופ ${APP_CONFIG.dashboardTopCitiesCount}`,
    citySeriesLabel: "תומכים",
  },
  leaderboard: {
    title: "מובילי הסיווגים",
    seeAll: "כל הפעילים",
  },
} as const;
