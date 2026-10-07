import { z } from "zod";
import { getEngine } from "@/server/engine";
export const runtime = "nodejs";
const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    sender: z.string(),
    receiver: z.string(),
    amount: z
      .string()
      .regex(
        /^\d{1,6}(\.\d{1,2})?$/,
        "Enter an amount with at most two decimal places",
      ),
  }),
  z.object({ action: z.enum(["gossip", "flush", "reset", "demo"]) }),
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
    const engine = getEngine();
    switch (action.action) {
      case "send": {
        const [whole, fraction = ""] = action.amount.split(".");
        engine.send(
          action.sender,
          action.receiver,
          Number(whole) * 100 + Number(fraction.padEnd(2, "0")),
        );
        break;
      }
      case "gossip":
        engine.gossip();
        break;
      case "flush":
        engine.flush();
        break;
      case "reset":
        engine.resetMesh();
        break;
      case "demo":
        engine.resetMesh();
        engine.send("alice@demo", "bob@demo", 50000);
        engine.gossip();
        engine.gossip();
        engine.flush();
        break;
    }
    return Response.json(engine.state());
  } catch (error) {
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
