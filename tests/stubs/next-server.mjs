// Minimal `next/server` stand-in for route-glue tests (local mode only).
// The real route code runs; only the Response factory is substituted.
export class NextRequest extends Request {}

export const NextResponse = {
  json(body, init) {
    return Response.json(body, init);
  },
};
