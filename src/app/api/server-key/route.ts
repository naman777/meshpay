import { getEngine } from "@/server/engine";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json({
    publicKey: getEngine().getPublicKey(),
    algorithm: "RSA-OAEP-SHA256 + AES-256-GCM",
    signingAlgorithm: "Ed25519",
    packetVersion: 1,
  });
}
