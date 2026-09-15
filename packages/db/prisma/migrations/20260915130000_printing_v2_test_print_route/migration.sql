-- Printing V2 follow-up — a Workstation can now have several different
-- printers (one per route), so an Admin "Test Print" request must record
-- WHICH route/printer the agent should test. Fully additive: one new
-- nullable column, no data migration needed (no test print has ever needed
-- this distinction before this point).
ALTER TABLE "workstations" ADD COLUMN "testPrintRouteType" "PrintJobType";
