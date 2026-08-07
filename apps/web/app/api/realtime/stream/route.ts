import { requireAuth, requireLocationAccess, UnauthorizedError, ForbiddenError } from "@rcs/auth";
import { subscribe } from "@rcs/domain";

/**
 * SSE stream — jedna otvorena HTTP konekcija po klijentu. Trenutno KDS
 * ekrani koriste polling (jednostavnije, dovoljno brzo za MVP — vidi
 * KdsClient.tsx); ova ruta postoji kao spreman extension point za owner
 * dashboard i za kasniju zamenu pollinga na KDS-u, bez menjanja
 * RealtimePublisher poziva u domain servisima.
 *
 * VAŽNA NAPOMENA ZA VERCEL: vidi napomenu u sse-publisher.ts o ograničenju
 * in-memory pub/sub-a na serverless platformi.
 */
export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await requireAuth(request);
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return new Response("Unauthorized", { status: 401 });
    }
    throw error;
  }

  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId") ?? undefined;
  if (locationId) {
    try {
      requireLocationAccess(ctx, locationId);
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return new Response("Forbidden", { status: 403 });
      }
      throw error;
    }
  }
  const role = ctx.roles[0] ?? "";

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: "connected" });

      const unsubscribe = subscribe(ctx.restaurantId, locationId, role, (event) => {
        send(event);
      });

      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, 20000);

      request.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
