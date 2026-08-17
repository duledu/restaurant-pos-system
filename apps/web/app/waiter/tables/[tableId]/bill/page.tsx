import { BillClient } from "./bill-client";

export default async function TableBillPage({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  return <BillClient tableId={tableId} />;
}
