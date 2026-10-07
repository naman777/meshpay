import { PostgresEngine } from "../../web/server/postgres-engine";
import type { Packet } from "../../web/lib/types";
const engine = new PostgresEngine(process.env.POSTGRES_TEST_URL!);
process.on("message", async (packet: Packet) => {
  try {
    process.send?.({ attempting: true });
    const result = await engine.ingest(packet, `process-${process.pid}`);
    await engine.close();
    process.send?.({ result }, () => process.disconnect());
  } catch {
    process.send?.({ error: "PostgreSQL worker failed" }, () =>
      process.disconnect(),
    );
    process.exitCode = 1;
    await engine.close();
  }
});
engine
  .getPublicKey()
  .then(() => process.send?.({ ready: true }))
  .catch(async () => {
    process.send?.({ error: "PostgreSQL initialization failed" });
    await engine.close();
    process.disconnect();
    process.exitCode = 1;
  });
