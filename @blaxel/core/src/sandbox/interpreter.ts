import { Sandbox, SandboxLifecycle, Port } from "../client/types.gen.js";
import { logger } from "../common/logger.js";
import { settings } from "../common/settings.js";
import { SandboxInstance } from "./sandbox.js";
import { SandboxConfiguration, SandboxCreateConfiguration } from "./types.js";

export class CodeInterpreter extends SandboxInstance {
  static readonly DEFAULT_IMAGE = "blaxel/jupyter-server";
  static readonly DEFAULT_PORTS: Port[] = [
    { name: "jupyter", target: 8888, protocol: "HTTP" },
  ];
  static readonly DEFAULT_LIFECYCLE: SandboxLifecycle = {
    expirationPolicies: [{ type: "ttl-idle", value: "30m", action: "delete" }],
  };

  private _sandboxConfig: SandboxConfiguration;

  constructor(sandbox: SandboxConfiguration) {
    super(sandbox);
    this._sandboxConfig = sandbox;
  }

  static async get(sandboxName: string): Promise<CodeInterpreter> {
    const base = await SandboxInstance.get(sandboxName);
    // Create a minimal config - the base instance already has the sandbox data
    // We'll rely on the process property for URL/headers access
    const config: SandboxConfiguration = {
      metadata: base.metadata,
      spec: base.spec,
      status: base.status,
      events: base.events,
    };
    return new CodeInterpreter(config);
  }

  static async create(
    sandbox?: Sandbox | SandboxCreateConfiguration | Record<string, any> | null,
    { safe = true }: { safe?: boolean } = {}
  ): Promise<CodeInterpreter> {
    const payload: Record<string, any> = {
      image: CodeInterpreter.DEFAULT_IMAGE,
      ports: CodeInterpreter.DEFAULT_PORTS,
      lifecycle: CodeInterpreter.DEFAULT_LIFECYCLE,
    };

    const allowedCopyKeys = new Set(["name", "envs", "memory", "region", "headers", "labels"]);

    if (sandbox && typeof sandbox === "object") {
      if (Array.isArray(sandbox)) {
        // Skip arrays
      } else if ("metadata" in sandbox || "spec" in sandbox) {
        // It's a Sandbox object
        const sandboxObj = sandbox as Sandbox;
        if (sandboxObj.metadata.name) {
          payload["name"] = sandboxObj.metadata.name;
        }
        if (sandboxObj.metadata.labels) {
          payload["labels"] = sandboxObj.metadata.labels;
        }
        if (sandboxObj.spec.runtime) {
          if (sandboxObj.spec.runtime.envs) {
            payload["envs"] = sandboxObj.spec.runtime.envs;
          }
          if (sandboxObj.spec.runtime.memory) {
            payload["memory"] = sandboxObj.spec.runtime.memory;
          }
        }
        if (sandboxObj.spec.region) {
          payload["region"] = sandboxObj.spec.region;
        }
      } else if ("name" in sandbox || "image" in sandbox || "memory" in sandbox) {
        // It's a SandboxCreateConfiguration or dict-like object
        const sandboxDict = sandbox as Record<string, unknown>;
        for (const k of allowedCopyKeys) {
          const value = sandboxDict[k];
          if (value !== null && value !== undefined) {
            payload[k] = value;
          }
        }
      }
    }

    const baseInstance = await SandboxInstance.create(payload, { safe });
    // Create config from the instance - preserve any forceUrl/headers if provided in input
    const config: SandboxConfiguration = {
      metadata: baseInstance.metadata,
      spec: baseInstance.spec,
      status: baseInstance.status,
      events: baseInstance.events,
    };
    // Preserve forceUrl and headers from input if it was a dict-like object
    if (sandbox && typeof sandbox === "object" && !Array.isArray(sandbox)) {
      if ("forceUrl" in sandbox && typeof sandbox.forceUrl === "string") {
        config.forceUrl = sandbox.forceUrl;
      }
      if ("headers" in sandbox && typeof sandbox.headers === "object") {
        config.headers = sandbox.headers as Record<string, string>;
      }
      if ("params" in sandbox && typeof sandbox.params === "object") {
        config.params = sandbox.params as Record<string, string>;
      }
    }
    return new CodeInterpreter(config);
  }

  get _jupyterUrl(): string {
    return this.process.url;
  }

  static OutputMessage = class {
    constructor(
      public text: string,
      public timestamp: number | null,
      public isStderr: boolean
    ) {}
  };

  static Result = class {
    [key: string]: unknown;

    constructor(kwargs: Record<string, unknown> = {}) {
      for (const [k, v] of Object.entries(kwargs)) {
        (this as Record<string, unknown>)[k] = v;
      }
    }
  };

  static ExecutionError = class {
    constructor(
      public name: string,
      public value: any,
      public traceback: any
    ) {}
  };

  static Logs = class {
    stdout: string[] = [];
    stderr: string[] = [];
  };

  static Execution = class {
    results: InstanceType<typeof CodeInterpreter.Result>[] = [];
    logs: InstanceType<typeof CodeInterpreter.Logs> = new CodeInterpreter.Logs();
    error: InstanceType<typeof CodeInterpreter.ExecutionError> | null = null;
    executionCount: number | null = null;
  };

  static Context = class {
    constructor(public id: string) {}

    static fromJson(
      data: Record<string, any>
    ): InstanceType<typeof CodeInterpreter.Context> {
      return new CodeInterpreter.Context(
        String(data.id || data.context_id || "")
      );
    }
  };

  private _parseOutput(
    execution: InstanceType<typeof CodeInterpreter.Execution>,
    output: string,
    onStdout?: (
      msg: InstanceType<typeof CodeInterpreter.OutputMessage>
    ) => any,
    onStderr?: (
      msg: InstanceType<typeof CodeInterpreter.OutputMessage>
    ) => any,
    onResult?: (result: InstanceType<typeof CodeInterpreter.Result>) => any,
    onError?: (
      error: InstanceType<typeof CodeInterpreter.ExecutionError>
    ) => any
  ): unknown {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(output) as Record<string, unknown>;
    } catch {
      // Fallback: treat as stdout text-only message
      execution.logs.stdout.push(output);
      if (onStdout) {
        return onStdout(new CodeInterpreter.OutputMessage(output, null, false));
      }
      return null;
    }

    let dataType = "";
    if (typeof data.type === "string") {
      dataType = data.type;
    } else if (
      data.type !== null &&
      data.type !== undefined &&
      typeof data.type !== "object"
    ) {
      const typeValue = data.type as string | number | boolean;
      dataType = String(typeValue);
    }
    const restData = { ...data };
    delete restData.type;

    if (dataType === "result") {
      const result = new CodeInterpreter.Result(restData);
      execution.results.push(result);
      if (onResult) {
        return onResult(result);
      }
    } else if (dataType === "stdout") {
      let text = "";
      if (typeof data.text === "string") {
        text = data.text;
      } else if (
        data.text !== null &&
        data.text !== undefined &&
        typeof data.text !== "object"
      ) {
        const textValue = data.text as string | number | boolean;
        text = String(textValue);
      }
      execution.logs.stdout.push(text);
      if (onStdout) {
        return onStdout(
          new CodeInterpreter.OutputMessage(
            text,
            typeof data.timestamp === "number" ? data.timestamp : null,
            false
          )
        );
      }
    } else if (dataType === "stderr") {
      let text = "";
      if (typeof data.text === "string") {
        text = data.text;
      } else if (
        data.text !== null &&
        data.text !== undefined &&
        typeof data.text !== "object"
      ) {
        const textValue = data.text as string | number | boolean;
        text = String(textValue);
      }
      execution.logs.stderr.push(text);
      if (onStderr) {
        return onStderr(
          new CodeInterpreter.OutputMessage(
            text,
            typeof data.timestamp === "number" ? data.timestamp : null,
            true
          )
        );
      }
    } else if (dataType === "error") {
      let errorName = "";
      if (typeof data.name === "string") {
        errorName = data.name;
      } else if (
        data.name !== null &&
        data.name !== undefined &&
        typeof data.name !== "object"
      ) {
        const nameValue = data.name as string | number | boolean;
        errorName = String(nameValue);
      }
      execution.error = new CodeInterpreter.ExecutionError(
        errorName,
        data.value,
        data.traceback
      );
      if (onError) {
        return onError(execution.error);
      }
    } else if (dataType === "number_of_executions") {
      execution.executionCount =
        typeof data.execution_count === "number" ? data.execution_count : null;
    }

    return null;
  }

  async runCode(
    code: string,
    options: {
      language?: string | null;
      context?: InstanceType<typeof CodeInterpreter.Context> | null;
      onStdout?: (
        msg: InstanceType<typeof CodeInterpreter.OutputMessage>
      ) => void;
      onStderr?: (
        msg: InstanceType<typeof CodeInterpreter.OutputMessage>
      ) => void;
      onResult?: (result: InstanceType<typeof CodeInterpreter.Result>) => void;
      onError?: (
        error: InstanceType<typeof CodeInterpreter.ExecutionError>
      ) => void;
      envs?: Record<string, string> | null;
      timeout?: number | null;
      requestTimeout?: number | null;
    } = {}
  ): Promise<InstanceType<typeof CodeInterpreter.Execution>> {
      const {
      language = null,
      context = null,
      onStdout,
      onStderr,
      onResult,
      onError,
      envs = null,
      timeout = null,
    } = options;

    const DEFAULT_TIMEOUT = 60.0;

    if (language && context) {
      throw new Error(
        "You can provide context or language, but not both at the same time."
      );
    }

    const readTimeout =
      timeout === 0 ? null : timeout ?? DEFAULT_TIMEOUT;

    const contextId = context?.id ?? null;

    const body: Record<string, any> = {
      code,
      context_id: contextId,
      language,
      env_vars: envs,
    };

    const execution = new CodeInterpreter.Execution();

    const headers = this._sandboxConfig.forceUrl
      ? this._sandboxConfig.headers
      : settings.headers;

    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | null = null;

    // Set up timeout
    if (readTimeout !== null) {
      timeoutId = setTimeout(() => {
        controller.abort();
      }, readTimeout * 1000);
    }

    try {
      const response = await fetch(`${this._jupyterUrl}/port/8888/execute`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status >= 400) {
        let bodyText = "<unavailable>";
        try {
          bodyText = await response.text();
        } catch {
          // Ignore errors
        }

        const method = "POST";
        const url = `${this._jupyterUrl}/port/8888/execute`;
        const reason = response.statusText;
        const details =
          "Execution failed\n" +
          `- method: ${method}\n- url: ${url}\n- status: ${response.status} ${reason}\n` +
          `- response-headers: ${JSON.stringify(
            Object.fromEntries(response.headers.entries())
          )}\n- body:\n${bodyText}`;

        logger.debug(details);
        throw new Error(details);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          const value = result.value as Uint8Array | undefined;

          if (value instanceof Uint8Array) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line) continue;

              try {
                this._parseOutput(
                  execution,
                  line,
                  onStdout,
                  onStderr,
                  onResult,
                  onError
                );
              } catch {
                // Fallback: treat as stdout text-only message
                execution.logs.stdout.push(line);
                if (onStdout) {
                  onStdout(new CodeInterpreter.OutputMessage(line, null, false));
                }
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "AbortError"
      ) {
        throw new Error("Request timeout");
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    return execution;
  }

  async createCodeContext(options: {
    cwd?: string | null;
    language?: string | null;
    requestTimeout?: number | null;
  } = {}): Promise<InstanceType<typeof CodeInterpreter.Context>> {
    const { cwd = null, language = null, requestTimeout = null } = options;

    const data: Record<string, any> = {};
    if (language) {
      data.language = language;
    }
    if (cwd) {
      data.cwd = cwd;
    }

    const headers = this._sandboxConfig.forceUrl
      ? this._sandboxConfig.headers
      : settings.headers;

    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | null = null;

    if (requestTimeout !== null) {
      timeoutId = setTimeout(() => {
        controller.abort();
      }, requestTimeout * 1000);
    }

    try {
      const response = await fetch(`${this._jupyterUrl}/port/8888/contexts`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      if (response.status >= 400) {
        let bodyText = "<unavailable>";
        try {
          bodyText = await response.text();
        } catch {
          // Ignore errors
        }

        const method = "POST";
        const url = `${this._jupyterUrl}/port/8888/contexts`;
        const reason = response.statusText;
        const details =
          "Create context failed\n" +
          `- method: ${method}\n- url: ${url}\n- status: ${response.status} ${reason}\n` +
          `- response-headers: ${JSON.stringify(
            Object.fromEntries(response.headers.entries())
          )}\n- body:\n${bodyText}`;

        logger.debug(details);
        throw new Error(details);
      }

      const responseData = (await response.json()) as Record<string, any>;
      return CodeInterpreter.Context.fromJson(responseData);
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "AbortError"
      ) {
        throw new Error("Request timeout");
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}

