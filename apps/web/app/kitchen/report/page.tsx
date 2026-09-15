import { StationReportClient } from "../../../components/production/StationReportClient";
import { resolveEnvironmentLabel } from "../../../lib/environment-label";

export default function KitchenReportPage() {
  return <StationReportClient station="KITCHEN" title="Kuhinja · Izveštaj" environmentLabel={resolveEnvironmentLabel(process.env)} />;
}
