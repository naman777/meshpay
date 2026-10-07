import { packetSchema } from "@/lib/protocol";
import { getEngine, storageFailure } from "@/server/engine";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const packet = packetSchema.parse(await request.json());
    const result = await (
      await getEngine()
    ).ingest(
      packet,
      (request.headers.get("X-Bridge-Node-Id") || "external-bridge").slice(
        0,
        100,
      ),
    );
    return Response.json(result, {
      status: result.outcome === "INVALID" ? 422 : 200,
    });
  } catch (error) {
    const failure = storageFailure(error);
    if (failure) return failure;
    return Response.json(
      { error: "Invalid packet or settlement unavailable; retry delivery" },
      { status: 400 },
    );
  }
}
