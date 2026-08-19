/**
 * Global teardown — disconnects the shared Prisma singleton ONCE after all
 * integration tests complete.
 *
 * Root cause of previous flaky beforeEach timeouts: each test file called
 * prisma.$disconnect() in afterAll, which reset the shared connection pool.
 * The next file's beforeEach TRUNCATE had to wait for Prisma to reconnect
 * (potentially >20s on Windows with embedded PostgreSQL), hitting hookTimeout.
 *
 * Fix: individual afterAll calls removed; single disconnect happens here.
 */
import { prisma } from "@rcs/db";

export async function teardown() {
  await prisma.$disconnect();
}
