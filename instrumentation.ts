// Next compiles this file for BOTH runtimes because middleware.ts exists, and the Edge bundle
// rejects `process.on`/`process.listeners`. So the Node-only work lives behind a runtime-guarded
// dynamic import: the edge bundle keeps the check and never pulls the module in.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "development") return;
  await import("./instrumentation-node");
}
