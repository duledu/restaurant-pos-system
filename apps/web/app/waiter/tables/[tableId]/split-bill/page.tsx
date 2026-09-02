import { SplitBillClient } from "./split-bill-client";

export default async function TableSplitBillPage({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  return <SplitBillClient tableId={tableId} />;
}
