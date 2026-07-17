import { Upload } from "lucide-react";
import { Link } from "react-router";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ROUTES } from "../../constants/routes";
import { CityBarChart } from "./CityBarChart";
import { ClassificationDonut } from "./ClassificationDonut";
import { DASHBOARD_TEXT } from "./dashboard.constants";
import { GoalProgress } from "./GoalProgress";
import { KpiSection } from "./KpiSection";
import { LeaderboardCard } from "./LeaderboardCard";
import { TrendChart } from "./TrendChart";
import { useDashboardData } from "./useDashboardData";

export function DashboardPage() {
  const { stats, trend, cities, activists } = useDashboardData();
  const isEmptyCampaign = stats !== null && stats.totalVoters === 0;

  if (isEmptyCampaign) {
    return (
      <>
        <PageHeader title={DASHBOARD_TEXT.title} subtitle={DASHBOARD_TEXT.subtitle} />
        <EmptyState
          icon={Upload}
          title={DASHBOARD_TEXT.empty.title}
          hint={DASHBOARD_TEXT.empty.hint}
          action={
            <Link to={ROUTES.import}>
              <Button>{DASHBOARD_TEXT.empty.action}</Button>
            </Link>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title={DASHBOARD_TEXT.title} subtitle={DASHBOARD_TEXT.subtitle} />
      <KpiSection stats={stats} />
      <GoalProgress stats={stats} />
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <TrendChart trend={trend} />
        <ClassificationDonut stats={stats} />
        <CityBarChart cities={cities} />
        <LeaderboardCard activists={activists} />
      </div>
    </>
  );
}
