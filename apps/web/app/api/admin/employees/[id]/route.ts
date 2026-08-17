import { NextResponse } from "next/server";
import { employees } from "@rcs/domain";
import { updateEmployeeSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = updateEmployeeSchema.parse(body);
  const employee = await employees.updateEmployee(ctx, id, input);
  return NextResponse.json({ employee });
});
