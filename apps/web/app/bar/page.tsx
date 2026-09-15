import { KdsClient } from "../../components/kds/KdsClient";
import { resolveEnvironmentLabel } from "../../lib/environment-label";

export default function BarPage() {
  return <KdsClient station="BAR" title="Šank" environmentLabel={resolveEnvironmentLabel(process.env)} />;
}
