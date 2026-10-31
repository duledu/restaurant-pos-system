// Deliberately narrow schema: never log request bodies, headers, credentials,
// ticket content, connection strings, or user-provided error messages.
export function traceTestDelivery(stage: string, workstationId: string, requestId: string | null,
  result: string, startedAt: number) {
  console.info(JSON.stringify({ utc: new Date().toISOString(), component: "print-api",
    stage, workstationId, requestId, result, durationMs: Math.round(performance.now() - startedAt) }));
}
