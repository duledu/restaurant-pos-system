/**
 * P0 bug fix (physical QA: a freshly-tested Kitchen ticket showed "176 min").
 * Root cause: order-service.ts submitOrder only sets Order.submittedAt on the
 * table's FIRST round ever (VIŠE-KRUŽNO NARUČIVANJE — later rounds leave it
 * untouched); it is OrderItem.submittedAt that is refreshed on every round.
 * KdsClient.tsx's wait timer used the order-level field, so a table with an
 * old first round and a brand-new second round showed the age of the FIRST
 * round on a ticket displaying the SECOND round's (just-submitted) items.
 *
 * The correct basis for "how long has this ticket's pending work been
 * waiting" is the earliest submittedAt among the items actually shown on
 * that station's card — falling back to the order-level field only when no
 * item carries one (defensive; should not happen for an Aktivne card).
 */
export function ticketWaitBasis(orderSubmittedAt: string | null, items: readonly { submittedAt: string | null }[]): string | null {
  const itemTimes = items.map((item) => item.submittedAt).filter((value): value is string => Boolean(value));
  if (itemTimes.length === 0) return orderSubmittedAt;
  return itemTimes.reduce((earliest, current) => (current < earliest ? current : earliest));
}
