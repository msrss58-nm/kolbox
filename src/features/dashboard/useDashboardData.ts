import { useCallback } from "react";
import { APP_CONFIG } from "../../constants/config";
import { useAsyncData } from "../../hooks/useAsyncData";
import { api } from "../../services/api";

/**
 * Loads the four independent dashboard data sources. Each keeps its own
 * loading state so sections render (and skeleton) as soon as their data
 * arrives, rather than all waiting for the slowest fetch.
 */
export function useDashboardData() {
  const fetchStats = useCallback(() => api.getStats(), []);
  const fetchTrend = useCallback(() => api.getTrend(APP_CONFIG.dashboardTrendDays), []);
  const fetchCities = useCallback(() => api.getCityBreakdown(), []);
  const fetchActivists = useCallback(() => api.listActivists(), []);

  const stats = useAsyncData(fetchStats);
  const trend = useAsyncData(fetchTrend);
  const cities = useAsyncData(fetchCities);
  const activists = useAsyncData(fetchActivists);

  return {
    stats: stats.data,
    trend: trend.data,
    cities: cities.data,
    activists: activists.data,
  };
}
