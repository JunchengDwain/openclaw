import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createExecTool } from "./api.js";
import { initSandboxExecutor } from "./src/sandbox.js";

export default definePluginEntry({
  id: "local-exec",
  name: "Local Exec",
  description: "Execute bash commands and Python scripts.",
  register(api: OpenClawPluginApi) {
    const sandboxEnabled = (api.pluginConfig?.["sandboxEnabled"] as boolean) ?? false;
    const sandboxImage = (api.pluginConfig?.["sandboxImage"] as string) ?? "local/python-execd";

    if (sandboxEnabled) {
      initSandboxExecutor({ enabled: true, image: sandboxImage });
    }

    api.registerTool((ctx) => createExecTool({ api, context: ctx }), {
      name: "local_exec",
    });
  },
});
