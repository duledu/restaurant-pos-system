import { TransferClient } from "./transfer-client";

export default async function TableTransferPage({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  return <TransferClient tableId={tableId} />;
}
