import {
  BlAgent,
  BlaxelMcpServerTransport,
  BlJob,
  McpTool,
  startSpan,
} from "@blaxel/core";

/**
 * Monkey-patches BlAgent.prototype.run to wrap with telemetry spans.
 */
function patchBlAgent() {
  const origRun = BlAgent.prototype.run;

  BlAgent.prototype.run = async function (
    input: Record<string, unknown> | string | undefined,
    headers: Record<string, string> = {},
    params: Record<string, string> = {}
  ): Promise<string> {
    const span = startSpan(this.agentName, {
      attributes: {
        "agent.name": this.agentName,
        "agent.args": JSON.stringify(input),
        "span.type": "agent.run",
      },
      isRoot: false,
    });

    try {
      const result = await origRun.call(this, input, headers, params);
      span.setAttribute("agent.run.result", result);
      return result;
    } catch (err: unknown) {
      if (err instanceof Error) {
        span.setAttribute("agent.run.error", err.stack as string);
      }
      throw err;
    } finally {
      span.end();
    }
  };
}

/**
 * Monkey-patches BlJob.prototype.run to wrap with telemetry spans.
 */
function patchBlJob() {
  const origRun = BlJob.prototype.run;

  BlJob.prototype.run = async function (
    tasks: Record<string, unknown>[],
    options?: {
      env?: Record<string, string>;
      memory?: number;
      executionId?: string;
    }
  ): Promise<string> {
    const span = startSpan(this.jobName, {
      attributes: {
        "job.name": this.jobName,
        "span.type": "job.run",
      },
      isRoot: false,
    });

    try {
      const result = await origRun.call(this, tasks, options);
      return result;
    } catch (err: unknown) {
      if (err instanceof Error) {
        span.setAttribute("job.run.error", err.stack as string);
      }
      throw err;
    } finally {
      span.end();
    }
  };
}

/**
 * Monkey-patches McpTool.prototype.listTools and McpTool.prototype.call
 * to wrap with telemetry spans.
 */
function patchMcpTool() {
  const origListTools = McpTool.prototype.listTools;
  const origCall = McpTool.prototype.call;

  McpTool.prototype.listTools = async function () {
    const span = startSpan((this as any).name, {
      attributes: {
        "span.type": "tool.list",
      },
    });
    try {
      const result = await origListTools.call(this);
      span.setAttribute("tool.list.result", JSON.stringify(result));
      return result;
    } catch (err) {
      span.setStatus("error");
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  };

  McpTool.prototype.call = async function (
    toolName: string,
    args: Record<string, unknown> | undefined
  ) {
    const span = startSpan((this as any).name + "." + toolName, {
      attributes: {
        "span.type": "tool.call",
        "tool.name": toolName,
        "tool.args": JSON.stringify(args),
      },
    });
    try {
      const result = await origCall.call(this, toolName, args);
      span.setAttribute("tool.call.result", JSON.stringify(result));
      return result;
    } catch (err: unknown) {
      span.setStatus("error");
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  };
}

/**
 * Monkey-patches BlaxelMcpServerTransport to add telemetry spans
 * for incoming messages (via onmessage setter) and outgoing messages (via send).
 */
function patchMcpServer() {
  // Patch the onmessage setter to wrap the handler with span tracking
  const origDescriptor = Object.getOwnPropertyDescriptor(
    BlaxelMcpServerTransport.prototype,
    "onmessage"
  );

  if (origDescriptor?.set) {
    const origSetter = origDescriptor.set;

    Object.defineProperty(BlaxelMcpServerTransport.prototype, "onmessage", {
      ...origDescriptor,
      set(
        handler: ((message: any) => void) | undefined
      ) {
        if (handler) {
          const tracedHandler = async (message: any) => {
            const messageId = message.id ? String(message.id) : "";
            const [clientId] = messageId.includes(":")
              ? messageId.split(":")
              : [undefined];

            const span = startSpan("mcp.message", {
              attributes: {
                "span.type": "mcp.message",
                ...(clientId ? { "mcp.client.id": clientId } : {}),
                ...((message.method as string)
                  ? { "mcp.method": message.method as string }
                  : {}),
                ...((message.params as Record<string, unknown>)?.name
                  ? {
                      "mcp.toolName": (
                        message.params as Record<string, unknown>
                      ).name as string,
                    }
                  : {}),
              },
              isRoot: false,
            });

            try {
              await Promise.resolve(handler(message));
            } catch (err) {
              span.setStatus("error");
              span.recordException(err as Error);
            } finally {
              span.end();
            }
          };
          origSetter.call(this, tracedHandler);
        } else {
          origSetter.call(this, handler);
        }
      },
    });
  }

  // Patch the send method to wrap with span tracking
  const origSend = BlaxelMcpServerTransport.prototype.send;

  BlaxelMcpServerTransport.prototype.send = async function (
    msg: any
  ): Promise<void> {
    const span = startSpan("mcp.send", {
      attributes: {
        "span.type": "mcp.send",
      },
      isRoot: false,
    });

    try {
      await origSend.call(this, msg as never);
      span.setAttributes({
        "mcp.message.response_sent": true,
      });
    } catch (err) {
      span.setStatus("error");
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  };
}

/**
 * Instruments all @blaxel/core classes with telemetry via monkey patching.
 * This should be called during telemetry initialization.
 */
export function instrumentBlaxelCore() {
  patchBlAgent();
  patchBlJob();
  patchMcpTool();
  patchMcpServer();
}
