import { NextResponse } from "next/server";
import { employees } from "@rcs/domain";
import { createEmployeeSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const list = await employees.listEmployees(ctx);
  return NextResponse.json({ employees: list });
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = createEmployeeSchema.parse(body);
  const employee = await employees.createEmployee(ctx, input);
  return NextResponse.json({ employee }, { status: 201 });
});
