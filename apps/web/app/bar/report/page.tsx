import { StationReportClient } from "../../../components/production/StationReportClient";
import { resolveEnvironmentLabel } from "../../../lib/environment-label";

export default function BarReportPage() {
  return <StationReportClient station="BAR" title="Šank · Izveštaj" environmentLabel={resolveEnvironmentLabel(process.env)} />;
}
