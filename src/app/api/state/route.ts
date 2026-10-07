import { getEngine } from "@/server/engine";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(getEngine().state(), {
    headers: { "Cache-Control": "no-store" },
  });
}
