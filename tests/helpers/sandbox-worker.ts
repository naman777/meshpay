import { SandboxStore } from "../../web/server/sandbox-store";
const store = new SandboxStore(process.env.POSTGRES_TEST_URL!);
const session = process.env.POSTGRES_SANDBOX_SESSION!;
process.on("message", async () => {
  process.send?.({ attempting: true });
  try {
    const state = await store.run(session, (engine) => {
      engine.flush();
      return engine.state();
    });
    await store.close();
    process.send?.(
      {
        result: {
          transactions: state.transactions.length,
          duplicates: state.duplicates,
        },
      },
      () => process.disconnect(),
    );
  } catch {
    await store.close();
    process.send?.({ error: "Sandbox worker failed" }, () =>
      process.disconnect(),
    );
    process.exitCode = 1;
  }
});
store
  .run(session, (engine) => engine.state())
  .then(() => process.send?.({ ready: true }))
  .catch(async () => {
    await store.close();
    process.send?.({ error: "Sandbox initialization failed" }, () =>
      process.disconnect(),
    );
    process.exitCode = 1;
  });
