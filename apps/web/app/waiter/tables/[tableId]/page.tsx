import { OrderClient } from "./order-client";

export default async function TableOrderPage({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  return <OrderClient tableId={tableId} />;
}
