import { printing } from "@rcs/domain";
import type { AuthContext } from "@rcs/auth";

/** Existing integration scenarios now use the required claim/start/result protocol. */
export async function confirmPrint(ctx: AuthContext, orderId: string, jobId: string, result: { success: boolean; errorMessage?: string }) {
  const claimed = await printing.beginPrintAttempt(ctx, orderId, jobId)
    ?? (await printing.listPrintJobs(ctx, orderId)).find(j => j.id === jobId)!;
  if (result.success) await printing.startPrintSubmission(ctx, orderId, jobId, claimed.attemptId!);
  return printing.confirmPrintResult(ctx, orderId, jobId, { attemptId: claimed.attemptId!,
    outcome: result.success ? "SUBMITTED_TO_SPOOLER" : "FAILED_BEFORE_SUBMISSION", errorMessage: result.errorMessage });
}
