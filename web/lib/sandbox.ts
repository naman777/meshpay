import { createDemoWallets } from "./wallet";
import type { State } from "./types";
export async function startSandbox() {
  const wallets = await createDemoWallets();
  const response = await fetch("/api/sandbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "start",
      publicKeys: Object.fromEntries(
        Object.values(wallets).map((wallet) => [
          wallet.sender,
          wallet.publicKey,
        ]),
      ),
    }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Could not prepare your demo. Try again.");
  return {
    wallets,
    session: data.session as string,
    state: data.state as State,
  };
}
