import { getSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { setW2AutoProxyConfig } from "open-sse/utils/w2Proxy.js";
import { syncBuiltinProxyState } from "open-sse/utils/builtinProxy.js";

let initialized = false;

export async function ensureOutboundProxyInitialized() {
  if (initialized) return true;

  try {
    const settings = await getSettings();
    applyOutboundProxyEnv(settings);
    setW2AutoProxyConfig(settings);
    await syncBuiltinProxyState(settings);
    initialized = true;
  } catch (error) {
    console.error("[ServerInit] Error initializing outbound proxy:", error);
  }

  return initialized;
}

// Defer init so HTTP server accepts connections first
setImmediate(() => {
  ensureOutboundProxyInitialized().catch(console.log);
});

export default ensureOutboundProxyInitialized;
