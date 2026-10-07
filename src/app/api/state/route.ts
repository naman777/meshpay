import { getEngine, storageFailure } from "@/server/engine";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(await (await getEngine()).state(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return (
      storageFailure(error) ??
      Response.json(
        {
          error: "Simulator storage unavailable. Check server deployment logs.",
        },
        { status: 503 },
      )
    );
  }
}
