import { KdsClient } from "../../components/kds/KdsClient";
import { resolveEnvironmentLabel } from "../../lib/environment-label";

export default function KitchenPage() {
  return <KdsClient station="KITCHEN" title="Kuhinja" environmentLabel={resolveEnvironmentLabel(process.env)} />;
}
