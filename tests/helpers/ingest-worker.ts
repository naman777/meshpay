import { MeshEngine } from "../../web/server/sqlite-engine";
import type { Packet } from "../../web/lib/types";

const engine = new MeshEngine(process.argv[2]);
process.on("message", (packet: Packet) => {
  process.send?.({ attempting: true });
  try {
    const result = engine.ingest(packet, `process-${process.pid}`);
    engine.close();
    process.send?.({ result }, () => process.disconnect());
  } catch (error) {
    engine.close();
    process.send?.(
      { error: error instanceof Error ? error.message : String(error) },
      () => process.disconnect(),
    );
    process.exitCode = 1;
  }
});
process.send?.({ ready: true });
