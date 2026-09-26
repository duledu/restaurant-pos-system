# Combined physical PREPROD QA — Inventory 2.5, Shift Handover V1, Promotions V1

Status: **PENDING. Not Production-ready.** Automated and synthetic-browser results do not complete this checklist.

Use the established PREPROD site and reliable PREPROD Print Agent installer on the actual restaurant devices. Record the tested deployment commit, restaurant timezone, device/browser, table/order IDs, receipts, and physical ticket counts. Do not point reset/integration tests at PREPROD. Do not use Production.

## Inventory Phase 2.5

- [ ] Review the guided tracking-method flow on Admin Meni at desktop/tablet widths.
- [ ] Configure and edit DIRECT_STOCK inline; verify its unit and opening/current stock display.
- [ ] Configure a RECIPE item and its normative; verify the incomplete-normative message.
- [ ] Verify an untracked item follows its intended sale flow.
- [ ] Complete normal, split, and promotion-priced sales; reconcile item/ingredient movements with sold quantities, including a payment retry.
- [ ] Verify recorded zero/negative stock does not incorrectly block an otherwise configured sale.
- [ ] Review stock and normative results after a partial item transfer and a controlled void.

## Shift Handover V1

- [ ] Transfer an active table from the outgoing waiter to the incoming waiter; verify both devices update.
- [ ] Verify only eligible active staff/locations are offered.
- [ ] Verify unauthorized and cross-location ownership changes are blocked.
- [ ] Verify the manager's forced-transfer path and reason/audit record.
- [ ] Check the handover overview and ownership audit history.
- [ ] Repeat/retry a handover; confirm no duplicate transfer or lost active order.
- [ ] Continue adding, submitting, serving, and paying after handover without changing existing prices, inventory, or dispatch history.

## Happy Hour / Promotions V1 — required 22 scenarios

1. [ ] Create `Happy Hour` in Admin (`/promotions`, within the Admin route group).
2. [ ] Percentage promotion on an item.
3. [ ] Percentage promotion on a category.
4. [ ] Fixed promotional price.
5. [ ] Activate/deactivate; verify the open waiter session refreshes its preview.
6. [ ] Edit promotion; confirm previously submitted lines retain their snapshots.
7. [ ] Verify waiter sees original and promotional price clearly.
8. [ ] Add an item while the promotion is active.
9. [ ] Submit while the promotion is active.
10. [ ] Promotion ends; the previously submitted item retains its promotional price.
11. [ ] Add the same item after the promotion ends: separate regular-price line.
12. [ ] Test `+1` across the boundary, both before add confirmation and on a confirmed draft; verify a separate current-price preview line. Submit after expiry: **all still-unsent units use the submit-time price**, while earlier submitted units remain frozen.
13. [ ] Cross-midnight promotion, including opening/reopening the waiter screen after midnight.
14. [ ] Item promotion versus category promotion overlap, including same-level priorities.
15. [ ] Verify no stacking; a fixed promotion above the regular price must not increase it.
16. [ ] Verify the physical receipt price.
17. [ ] Verify physical reprint after editing/deactivating the promotion and changing the menu price.
18. [ ] Verify the payment total and change, including a split payment where used.
19. [ ] Verify KDS receives only the intended item once and the expected physical ticket count; repeat a submit retry.
20. [ ] Verify Inventory/normative deduction quantity is unchanged by promotional pricing.
21. [ ] Mobile/tablet waiter UX: add, `+`, `-`, notes, modifiers, suspended/resumed browser, and long promotion names.
22. [ ] Admin Promotions responsive UX: item/category search, weekdays, percentage/fixed amounts, dates, priority, and active/inactive state.

## Additional acceptance checks from continuation

- [ ] Create/edit an optional date range, including an invalid range. Dates follow the restaurant's calendar; the end date includes that calendar day and cuts off at its following midnight.
- [ ] Change device timezone while retaining the restaurant timezone; confirm the same Happy Hour boundaries.
- [ ] Rename/change a promotion before submit without changing the charged amount; verify the submitted regular-price/name/type/value snapshots.
- [ ] Partially transfer a submitted promotional line to another table; verify its price and promotion metadata, payment, and receipt remain unchanged.
- [ ] Verify modifier edits show a coherent preview and the accepted base price plus undiscounted modifiers.

## Evidence and open limitations

See [Promotions continuation audit](promotions-v1-continuation-audit.md) for executed tests and PREPROD migration evidence. No authenticated PREPROD browser session was available in the continuation session; all physical scenarios above remain unchecked. Local Chromium fixtures verified real components with synthetic APIs and cannot establish live authorization, database behavior, or physical printing.

The local responsive review also observed existing sub-44px waiter controls (`Podeli račun`, `Prebaci stavke`, `KUHINJA`, `ŠANK`). They were outside the Promotions changes; assess their usability on the physical devices in scenario 21.
