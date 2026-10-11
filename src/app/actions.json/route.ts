import { ACTION_HEADERS } from "../../../DIALECT.BLINK/provider";

const CORS = {
  ...ACTION_HEADERS,
  "content-type": "application/json; charset=utf-8",
};

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { rules: [{ pathPattern: "/t/*", apiPath: "/api/actions/title/*" }] },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}