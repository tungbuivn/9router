import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import http from "node:http";
import {
  setW2AutoProxyConfig,
  resetW2AutoProxyConfigForTests,
  isLocalTargetUrl,
  isTcpPortOpen,
  resolveActiveW2ProxyUrl,
  buildAcpProcessEnv,
  probeW2ProxyStatus,
} from "../../open-sse/utils/w2Proxy.js";
import { proxyAwareFetch, resetDirectDispatchersForTests } from "../../open-sse/utils/proxyFetch.js";

function startTcpListener() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end());
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function getUnusedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

describe("w2 auto-capture proxy (app-wide + ACP)", () => {
  let prevEnvEnabled;
  let prevEnvUrl;

  beforeEach(() => {
    prevEnvEnabled = process.env.W2_AUTO_PROXY_ENABLED;
    prevEnvUrl = process.env.W2_AUTO_PROXY_URL;
    delete process.env.W2_AUTO_PROXY_ENABLED;
    delete process.env.W2_AUTO_PROXY_URL;
    resetW2AutoProxyConfigForTests();
    resetDirectDispatchersForTests();
  });

  afterEach(() => {
    if (prevEnvEnabled === undefined) delete process.env.W2_AUTO_PROXY_ENABLED;
    else process.env.W2_AUTO_PROXY_ENABLED = prevEnvEnabled;
    if (prevEnvUrl === undefined) delete process.env.W2_AUTO_PROXY_URL;
    else process.env.W2_AUTO_PROXY_URL = prevEnvUrl;
    resetW2AutoProxyConfigForTests();
    resetDirectDispatchersForTests();
  });

  it("identifies all local/loopback URLs so they are NEVER captured", () => {
    expect(isLocalTargetUrl("http://localhost:20127/v1/chat/completions")).toBe(true);
    expect(isLocalTargetUrl("http://127.0.0.1:8899/")).toBe(true);
    expect(isLocalTargetUrl("http://127.0.0.5:11434/api/chat")).toBe(true);
    expect(isLocalTargetUrl("http://[::1]:3000/api")).toBe(true);
    expect(isLocalTargetUrl("http://0.0.0.0:8080/test")).toBe(true);
    expect(isLocalTargetUrl("http://ollama.local:11434/v1/chat")).toBe(true);
    expect(isLocalTargetUrl("http://sub.localhost/test")).toBe(true);

    expect(isLocalTargetUrl("https://api.openai.com/v1/chat/completions")).toBe(false);
    expect(isLocalTargetUrl("https://api.anthropic.com/v1/messages")).toBe(false);
    expect(isLocalTargetUrl("https://cloudcode-pa.googleapis.com/v1internal:generateContent")).toBe(false);
  });

  it("probes per request: returns proxy URL when active, null when stopped, null when disabled, and null for local URLs", async () => {
    const { server, port, url } = await startTcpListener();
    setW2AutoProxyConfig({ w2AutoProxyEnabled: true, w2AutoProxyUrl: url });

    // Active for remote URL
    expect(await isTcpPortOpen("127.0.0.1", port)).toBe(true);
    expect(await resolveActiveW2ProxyUrl("https://api.openai.com/v1/chat/completions")).toBe(url);

    // Local URL NEVER captured even when proxy is active
    expect(await resolveActiveW2ProxyUrl("http://127.0.0.1:11434/v1/chat/completions")).toBeNull();
    expect(await resolveActiveW2ProxyUrl("http://localhost:20127/api/health")).toBeNull();

    // Setting toggled OFF -> immediately returns null
    setW2AutoProxyConfig({ w2AutoProxyEnabled: false, w2AutoProxyUrl: url });
    expect(await resolveActiveW2ProxyUrl("https://api.openai.com/v1/chat/completions")).toBeNull();

    // Setting toggled ON again -> active again
    setW2AutoProxyConfig({ w2AutoProxyEnabled: true, w2AutoProxyUrl: url });
    expect(await resolveActiveW2ProxyUrl("https://api.openai.com/v1/chat/completions")).toBe(url);

    // Stop server -> next request immediately detects inactive (no stale cache)
    await closeServer(server);
    expect(await resolveActiveW2ProxyUrl("https://api.openai.com/v1/chat/completions")).toBeNull();

    const probe = await probeW2ProxyStatus(url);
    expect(probe.active).toBe(false);
    expect(probe.port).toBe(port);
  });

  it("buildAcpProcessEnv injects proxy + NO_PROXY + CA bundle when active, and strips stale w2 proxy when inactive/disabled", async () => {
    const { server, url } = await startTcpListener();
    setW2AutoProxyConfig({ w2AutoProxyEnabled: true, w2AutoProxyUrl: url });

    // Active w2 -> proxy & NO_PROXY & CA vars injected
    const activeRes = await buildAcpProcessEnv({ PATH: "/usr/bin" }, {});
    expect(activeRes.w2Proxy.active).toBe(true);
    expect(activeRes.w2Proxy.url).toBe(url);
    expect(activeRes.env.HTTP_PROXY).toBe(url);
    expect(activeRes.env.HTTPS_PROXY).toBe(url);
    expect(activeRes.env.ALL_PROXY).toBe(url);
    expect(activeRes.env.http_proxy).toBe(url);
    expect(activeRes.env.https_proxy).toBe(url);
    expect(activeRes.env.NO_PROXY).toContain("localhost");
    expect(activeRes.env.NO_PROXY).toContain("127.0.0.1");
    expect(activeRes.env.NO_PROXY).toContain("::1");
    if (activeRes.w2Proxy.caCertPath) {
      expect(activeRes.env.SSL_CERT_FILE).toBe(activeRes.w2Proxy.caCertPath);
      expect(activeRes.env.AWS_CA_BUNDLE).toBe(activeRes.w2Proxy.caCertPath);
      expect(activeRes.env.NODE_EXTRA_CA_CERTS).toBe(activeRes.w2Proxy.caCertPath);
    }

    // Custom proxy on ACP node overrides w2 auto-proxy
    const customRes = await buildAcpProcessEnv({ PATH: "/usr/bin" }, { HTTPS_PROXY: "http://10.0.0.1:3128" });
    expect(customRes.w2Proxy.active).toBe(false);
    expect(customRes.w2Proxy.skippedReason).toBe("custom_env_override");
    expect(customRes.env.HTTPS_PROXY).toBe("http://10.0.0.1:3128");

    // Disabled in settings -> strips stale w2 proxy inherited from parent env
    setW2AutoProxyConfig({ w2AutoProxyEnabled: false, w2AutoProxyUrl: url });
    const disabledRes = await buildAcpProcessEnv({ PATH: "/usr/bin", HTTP_PROXY: url, HTTPS_PROXY: url }, {});
    expect(disabledRes.w2Proxy.active).toBe(false);
    expect(disabledRes.w2Proxy.enabled).toBe(false);
    expect(disabledRes.env.HTTP_PROXY).toBeUndefined();
    expect(disabledRes.env.HTTPS_PROXY).toBeUndefined();

    // Re-enable, then stop w2 -> strips stale w2 proxy inherited from parent env
    setW2AutoProxyConfig({ w2AutoProxyEnabled: true, w2AutoProxyUrl: url });
    await closeServer(server);
    const inactiveRes = await buildAcpProcessEnv({ PATH: "/usr/bin", HTTP_PROXY: url, HTTPS_PROXY: url }, {});
    expect(inactiveRes.w2Proxy.active).toBe(false);
    expect(inactiveRes.env.HTTP_PROXY).toBeUndefined();
    expect(inactiveRes.env.HTTPS_PROXY).toBeUndefined();
  });

  it("proxyAwareFetch routes non-local HTTP requests through active w2 capture proxy and bypasses local requests", async () => {
    const capturedTargets = [];
    const fakeProxy = http.createServer((req, res) => {
      capturedTargets.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ capturedBy: "w2-test-proxy", url: req.url }));
    });
    // Undici ProxyAgent uses HTTP CONNECT tunneling (just like Whistle w2)
    fakeProxy.on("connect", (req, clientSocket) => {
      capturedTargets.push(req.url);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      clientSocket.once("data", () => {
        const body = JSON.stringify({ capturedBy: "w2-test-proxy", connectTarget: req.url });
        clientSocket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
        );
      });
    });
    await new Promise((resolve) => fakeProxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = fakeProxy.address().port;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    // Direct local target server (must NOT be captured by w2)
    const localTarget = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ directLocal: true, path: req.url }));
    });
    await new Promise((resolve) => localTarget.listen(0, "127.0.0.1", resolve));
    const localPort = localTarget.address().port;

    try {
      setW2AutoProxyConfig({ w2AutoProxyEnabled: true, w2AutoProxyUrl: proxyUrl });

      // 1. Non-local request goes through w2 proxy and gets captured
      const remoteRes = await proxyAwareFetch("http://example.invalid/v1/chat/completions", { method: "GET" });
      const remoteJson = await remoteRes.json();
      expect(remoteJson.capturedBy).toBe("w2-test-proxy");
      expect(capturedTargets).toContain("example.invalid:80");

      // 2. Local request bypasses w2 proxy completely
      const beforeCount = capturedTargets.length;
      const localRes = await proxyAwareFetch(`http://127.0.0.1:${localPort}/health`, { method: "GET" });
      const localJson = await localRes.json();
      expect(localJson.directLocal).toBe(true);
      expect(capturedTargets.length).toBe(beforeCount);
    } finally {
      await closeServer(fakeProxy);
      await closeServer(localTarget);
    }
  });

  it("returns false cleanly for an unused port", async () => {
    const deadPort = await getUnusedPort();
    expect(await isTcpPortOpen("127.0.0.1", deadPort, 150)).toBe(false);
  });
});
