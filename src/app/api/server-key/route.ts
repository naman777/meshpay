import { getEngine, storageFailure } from "@/server/engine";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json({
      publicKey: await (await getEngine()).getPublicKey(),
      algorithm: "RSA-OAEP-SHA256 + AES-256-GCM",
      signingAlgorithm: "Ed25519",
      packetVersion: 1,
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
