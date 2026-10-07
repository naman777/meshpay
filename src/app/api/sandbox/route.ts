import { z } from "zod";
import { signedSendSchema, failureSchema } from "@/lib/protocol";
import { normalizeSigningKey } from "@/server/crypto";
import { getSandboxStore, SandboxExpired } from "@/server/sandbox-store";
import { storageFailure } from "@/server/engine";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const keySchema = z
  .string()
  .min(16)
  .max(2000)
  .transform((value, ctx) => {
    try {
      return normalizeSigningKey(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "A valid Ed25519 public key is required",
      });
      return z.NEVER;
    }
  });
const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start"),
    publicKeys: z.strictObject({
      "alice@demo": keySchema,
      "bob@demo": keySchema,
      "carol@demo": keySchema,
      "dave@demo": keySchema,
    }),
  }),
  z.strictObject({ action: z.literal("send"), ...signedSendSchema.shape }),
  z.strictObject({ action: z.literal("demo"), ...signedSendSchema.shape }),
  z.strictObject({ action: z.literal("configure"), failures: failureSchema }),
  z.strictObject({ action: z.enum(["gossip", "flush", "reset"]) }),
]);
function failure(error: unknown) {
  if (error instanceof SandboxExpired)
    return Response.json({ error: error.message }, { status: 410 });
  return (
    storageFailure(error) ??
    Response.json(
      {
        error:
          error instanceof z.ZodError
            ? error.issues[0].message
            : error instanceof Error
              ? error.message
              : "Could not start the demo",
      },
      { status: 400 },
    )
  );
}
export async function GET(request: Request) {
  try {
    return Response.json(
      await getSandboxStore().run(
        request.headers.get("X-MeshPay-Session") || "",
        (engine) => engine.state(),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
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
    if (Number(request.headers.get("content-length") || 0) > 32000)
      return Response.json({ error: "Request is too large" }, { status: 413 });
    const body = await request.text();
    if (body.length > 32000)
      return Response.json({ error: "Request is too large" }, { status: 413 });
    const action = requestSchema.parse(JSON.parse(body));
    const store = getSandboxStore();
    if (action.action === "start")
      return Response.json(await store.create(action.publicKeys), {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      });
    return Response.json(
      await store.run(
        request.headers.get("X-MeshPay-Session") || "",
        (engine) => {
          switch (action.action) {
            case "send":
              engine.send({
                authorization: action.authorization,
                hopProof: action.hopProof,
              });
              break;
            case "configure":
              engine.configureFailures(action.failures);
              break;
            case "gossip":
              engine.gossip();
              break;
            case "flush":
              engine.flush();
              break;
            case "reset":
              engine.resetSandbox();
              break;
            case "demo": {
              const payment = {
                authorization: action.authorization,
                hopProof: action.hopProof,
              };
              const i = action.authorization.instruction;
              engine.createPacket(payment);
              if (
                i.sender !== "alice@demo" ||
                i.receiver !== "bob@demo" ||
                i.amount !== 50000
              )
                throw new Error(
                  "Demo requires a signed ₹500 Alice to Bob instruction",
                );
              engine.resetSandbox();
              engine.send(payment);
              engine.gossip();
              engine.gossip();
              engine.flush();
              break;
            }
          }
          return engine.state();
        },
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
