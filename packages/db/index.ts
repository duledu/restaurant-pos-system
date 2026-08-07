import { PrismaClient } from "@prisma/client";

// Singleton pattern da se izbegne otvaranje previše konekcija u dev modu
// (Next.js hot-reload inače kreira novi PrismaClient na svaki reload).

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "@prisma/client";
