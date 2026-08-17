import { NextResponse } from "next/server";
import { employees } from "@rcs/domain";
import { setEmployeeStatusSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = setEmployeeStatusSchema.parse(body);
  const employee = await employees.setEmployeeStatus(ctx, id, input.status);
  return NextResponse.json({ employee });
});
