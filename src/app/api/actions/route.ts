import { z } from "zod";
import { getEngine, storageFailure } from "@/server/engine";
import { signedSendSchema, failureSchema } from "@/lib/protocol";
export const runtime = "nodejs";
const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("send"),
    ...signedSendSchema.shape,
  }),
  z.strictObject({ action: z.literal("demo"), ...signedSendSchema.shape }),
  z.strictObject({ action: z.literal("configure"), failures: failureSchema }),
  z.strictObject({ action: z.enum(["gossip", "flush", "reset"]) }),
]);
export async function POST(request: Request) {
  // Simulator controls are same-origin and intentionally local/demo-only.
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const source = new URL(origin);
      if (
        !["http:", "https:"].includes(source.protocol) ||
        source.host !== request.headers.get("host")
      )
        return Response.json(
          { error: "Cross-origin action blocked" },
          { status: 403 },
        );
    } catch {
      return Response.json(
        { error: "Invalid request origin" },
        { status: 403 },
      );
    }
  }
  try {
    const action = actionSchema.parse(await request.json());
    const engine = await getEngine();
    switch (action.action) {
      case "send": {
        await engine.send({
          authorization: action.authorization,
          hopProof: action.hopProof,
        });
        break;
      }
      case "configure":
        await engine.configureFailures(action.failures);
        break;
      case "gossip":
        await engine.gossip();
        break;
      case "flush":
        await engine.flush();
        break;
      case "reset":
        await engine.resetMesh();
        break;
      case "demo":
        if ("demo" in engine) {
          await engine.demo({
            authorization: action.authorization,
            hopProof: action.hopProof,
          });
          break;
        }
        // Verify before resetting so invalid demo requests cannot discard queues.
        await engine.createPacket({
          authorization: action.authorization,
          hopProof: action.hopProof,
        });
        if (
          action.authorization.instruction.sender !== "alice@demo" ||
          action.authorization.instruction.receiver !== "bob@demo" ||
          action.authorization.instruction.amount !== 50000
        )
          throw new Error(
            "Demo requires a signed ₹500 Alice to Bob instruction",
          );
        await engine.resetMesh();
        await engine.send({
          authorization: action.authorization,
          hopProof: action.hopProof,
        });
        await engine.gossip();
        await engine.gossip();
        await engine.flush();
        break;
    }
    return Response.json(await engine.state());
  } catch (error) {
    const failure = storageFailure(error);
    if (failure) return failure;
    return Response.json(
      {
        error:
          error instanceof z.ZodError
            ? error.issues[0].message
            : error instanceof Error
              ? error.message
              : "Action failed",
      },
      { status: 400 },
    );
  }
}
