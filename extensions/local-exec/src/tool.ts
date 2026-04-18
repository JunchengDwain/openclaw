import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Static, Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "./api.js";
import { getSandboxExecutor } from "./sandbox.js";

const execAsync = promisify(exec);

const ExecToolSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("bash"), Type.Literal("python")], {
      description: "Execution kind: 'bash' runs a shell command, 'python' runs a Python script.",
    }),
    command: Type.Optional(
      Type.String({ description: "Shell command to execute (used when kind is 'bash')." }),
    ),
    script: Type.Optional(
      Type.String({ description: "Python script content to execute (used when kind is 'python')." }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Optional working directory for the execution." }),
    ),
  },
  { additionalProperties: false },
);

type ExecToolParams = Static<typeof ExecToolSchema>;

export function createExecTool(params: {
  api: OpenClawPluginApi;
  context?: OpenClawPluginToolContext;
}): AnyAgentTool {
  return {
    name: "local-exec",
    label: "Local Exec",
    description:
      "Execute a bash command or run a Python script via sandbox. Use kind='python' with script parameter for Python execution. Use kind='bash' with command parameter for shell commands.",
    parameters: ExecToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const { kind, command, script, cwd } = rawParams as ExecToolParams;

      if (kind === "bash" && !command) {
        throw new PluginToolInputError("command is required when kind is 'bash'.");
      }
      if (kind === "python" && !script) {
        throw new PluginToolInputError("script is required when kind is 'python'.");
      }

      const sandbox = getSandboxExecutor();
      const sandboxEnabled = sandbox?.isEnabled() ?? false;

      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      if (kind === "python" && sandboxEnabled) {
        try {
          const result = await sandbox!.runPython(script!);
          stdout = result.stdout;
          stderr = result.stderr;
          exitCode = result.exitCode;
        } catch (err: unknown) {
          exitCode = 1;
          stderr = String(err);
        }
      } else {
        const execCmd =
          kind === "bash" ? command! : `python3 -c "${script!.replace(/"/g, '\\"')}"`;

        try {
          const result = await execAsync(execCmd, { cwd: cwd || undefined });
          stdout = result.stdout;
          stderr = result.stderr;
        } catch (err: unknown) {
          const execErr = err as { code?: number; stdout?: string; stderr?: string };
          exitCode = execErr.code ?? 1;
          stdout = execErr.stdout ?? "";
          stderr = execErr.stderr ?? String(err);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { success: exitCode === 0, stdout, stderr, exitCode, sandbox: sandboxEnabled },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}

class PluginToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}
