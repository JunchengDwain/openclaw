const OPEN_SANDBOX_URL = "http://localhost:21889";
const SANDBOX_CREATE_TIMEOUT_MS = 30000;
const SANDBOX_READY_TIMEOUT_MS = 10000;

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxOptions {
  enabled?: boolean;
  image?: string;
}

interface SandboxInfo {
  id: string;
  proxyPort: number;
  httpPort: number;
}

export class SandboxExecutor {
  private enabled: boolean;
  private image: string;

  constructor(options: SandboxOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.image = options.image ?? "local/python-execd";
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private async waitForExecdReady(proxyPort: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    const url = `http://localhost:${proxyPort}/command`;

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "echo ready" }),
        });
        if (res.ok) {
          return;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`execd not ready on port ${proxyPort} after ${timeoutMs}ms`);
  }

  private async getSandboxDetails(id: string): Promise<SandboxInfo> {
    const res = await fetch(`${OPEN_SANDBOX_URL}/v1/sandboxes/${id}`);
    if (!res.ok) {
      throw new Error(`Failed to get sandbox: ${res.status}`);
    }
    const sb = (await res.json()) as {
      id: string;
      metadata: Record<string, string>;
    };
    const proxyPort = parseInt(sb.metadata["opensandbox.io/embedding-proxy-port"] ?? "0", 10);
    const httpPort = parseInt(sb.metadata["opensandbox.io/http-port"] ?? "0", 10);
    if (!proxyPort) {
      throw new Error("No proxy port in sandbox metadata");
    }
    return { id: sb.id, proxyPort, httpPort };
  }

  private async createSandbox(): Promise<SandboxInfo> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SANDBOX_CREATE_TIMEOUT_MS);

    let sandboxId: string;
    try {
      const res = await fetch(`${OPEN_SANDBOX_URL}/v1/sandboxes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: { uri: this.image },
          entrypoint: ["/usr/local/bin/execd"],
          timeout: 300,
          resourceLimits: {},
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Failed to create sandbox: ${res.status} ${await res.text()}`);
      }

      const sb = (await res.json()) as { id: string };
      sandboxId = sb.id;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }

    const sandbox = await this.getSandboxDetails(sandboxId);
    await this.waitForExecdReady(sandbox.proxyPort, SANDBOX_READY_TIMEOUT_MS);

    return sandbox;
  }

  private async deleteSandbox(sandbox: SandboxInfo): Promise<void> {
    try {
      await fetch(`${OPEN_SANDBOX_URL}/v1/sandboxes/${sandbox.id}`, {
        method: "DELETE",
      });
    } catch (err) {
      console.error(`[sandbox] Failed to delete sandbox: ${err}`);
    }
  }

  async exec(command: string): Promise<ExecResult> {
    if (!this.enabled) {
      throw new Error("Sandbox not enabled");
    }

    const sandbox = await this.createSandbox();

    try {
      const url = `http://localhost:${sandbox.proxyPort}/command`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });

      if (!res.ok) {
        throw new Error(`exec failed: ${res.status} ${await res.text()}`);
      }

      if (!res.body) {
        throw new Error("No response body");
      }

      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim() || !line.startsWith("{")) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "stdout") stdout += event.text;
            if (event.type === "stderr") stderr += event.text;
            if (event.type === "execution_complete") {
              exitCode = event.exit_code ?? 0;
            }
          } catch {
            // ignore parse errors
          }
        }
      }

      return { exitCode, stdout, stderr };
    } finally {
      await this.deleteSandbox(sandbox);
    }
  }

  async runPython(code: string): Promise<ExecResult> {
    const quoted = code.replace(/'/g, "'\\''");
    return this.exec(`python3 -c '${quoted}'`);
  }
}

let sandboxExecutor: SandboxExecutor | null = null;

export function getSandboxExecutor(): SandboxExecutor | null {
  return sandboxExecutor;
}

export function initSandboxExecutor(options: SandboxOptions = {}): void {
  sandboxExecutor = new SandboxExecutor(options);
}
