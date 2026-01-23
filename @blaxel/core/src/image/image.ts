import { DockerfileParser, Dockerfile } from "dockerfile-ast";
import { Metadata, MetadataLabels, SandboxRuntime, Sandbox, SandboxSpec } from "../client/types.gen.js";
import { crypto, fs, os, path } from "../common/node.js";
import { settings } from "../common/settings.js";
import archiver from "archiver";

function ensureNodeEnvironment(): void {
  if (!fs || !os || !path || !crypto) {
    throw new Error("Image is only available in Node.js environments. File system operations are not supported in browsers.");
  }
}

export const SANDBOX_API_IMAGE = "ghcr.io/blaxel-ai/sandbox";
export const SANDBOX_API_PATH = "/usr/local/bin/sandbox-api";

/**
 * Represents a local file to be copied into the build context.
 */
export interface LocalFile {
  sourcePath: string;
  destinationPath: string;
  contextName: string; // Name in the build context
}

/**
 * Contains all information needed to generate a deployable folder.
 */
export interface ImageBuildContext {
  baseImage: string;
  instructions: string[];
  localFiles: LocalFile[];
  hasEntrypoint: boolean;
}

/**
 * Options for building and deploying an image
 */
export interface ImageBuildOptions {
  name: string;
  memory?: number;
  timeout?: number;
  onStatusChange?: (status: string) => void;
  sandboxVersion?: string;
}

function generateDockerfile(context: ImageBuildContext): string {
  // Build the raw Dockerfile content
  const lines: string[] = [`FROM ${context.baseImage}`];
  lines.push(...context.instructions);
  const rawContent = lines.join("\n") + "\n";

  // Parse using dockerfile-ast to validate syntax
  const dockerfile: Dockerfile = DockerfileParser.parse(rawContent);

  // Check for any parsing errors by validating instruction count matches
  const instructions = dockerfile.getInstructions();
  if (instructions.length !== lines.length) {
    throw new Error("Invalid Dockerfile syntax: instruction count mismatch after parsing");
  }

  // Return raw content to preserve escaping in JSON-format instructions (ENTRYPOINT, CMD)
  // The AST reconstruction via toString() doesn't properly preserve escape sequences
  return rawContent;
}

function computeHash(context: ImageBuildContext): string {
  ensureNodeEnvironment();
  let content = generateDockerfile(context);
  for (const localFile of context.localFiles) {
    if (!fs!.existsSync(localFile.sourcePath)) {
      throw new Error(`Local file not found: ${localFile.sourcePath}. Cannot compute hash for missing files.`);
    }
    const stat = fs!.statSync(localFile.sourcePath);
    content += `\n${localFile.contextName}:${stat.mtimeMs}`;
  }
  return crypto!.createHash("sha256").update(content).digest("hex").substring(0, 12);
}

function cloneContext(context: ImageBuildContext): ImageBuildContext {
  return {
    baseImage: context.baseImage,
    instructions: [...context.instructions],
    localFiles: [...context.localFiles],
    hasEntrypoint: context.hasEntrypoint,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A fluent builder for creating sandbox images programmatically.
 *
 * Similar to Modal's Image class, allows chaining operations to build
 * a custom image from a base image.
 *
 * @example
 * ```typescript
 * const image = ImageInstance.fromRegistry("python:3.11-slim")
 *   .runCommands("apt-get update && apt-get install -y git curl")
 *   .workdir("/app")
 *   .runCommands("pip install --upgrade pip")
 *   .env({ PYTHONUNBUFFERED: "1" });
 *
 * await image.build({
 *   name: "my-sandbox",
 *   memory: 4096,
 *   timeout: 900000,
 *   onStatusChange: console.log,
 *   sandboxVersion: "latest",
 * });
 * ```
 */
export class ImageInstance {
  private _context: ImageBuildContext;

  constructor(context: ImageBuildContext) {
    this._context = context;
  }

  /**
   * Create an image from a Docker registry image.
   *
   * @param tag - The image tag (e.g., "python:3.11-slim", "ubuntu:22.04")
   * @returns A new Image instance
   */
  static fromRegistry(tag: string): ImageInstance {
    const context: ImageBuildContext = {
      baseImage: tag,
      instructions: [],
      localFiles: [],
      hasEntrypoint: false,
    };
    return new ImageInstance(context);
  }

  /**
   * Set the working directory for subsequent instructions.
   *
   * @param path - The working directory path inside the container
   * @returns A new Image instance with the working directory set
   */
  workdir(path: string): ImageInstance {
    const newContext = cloneContext(this._context);
    newContext.instructions.push(`WORKDIR ${path}`);
    return new ImageInstance(newContext);
  }

  /**
   * Run shell commands in the image.
   *
   * @param commands - One or more shell commands to run
   * @returns A new Image instance with the commands added
   */
  runCommands(...commands: string[]): ImageInstance {
    const newContext = cloneContext(this._context);
    for (const cmd of commands) {
      newContext.instructions.push(`RUN ${cmd}`);
    }
    return new ImageInstance(newContext);
  }

  /**
   * Set environment variables.
   *
   * @param variables - Environment variables as an object
   * @returns A new Image instance with the environment variables set
   */
  env(variables: Record<string, string>): ImageInstance {
    const keys = Object.keys(variables);
    if (keys.length === 0) {
      return this;
    }

    const newContext = cloneContext(this._context);
    for (const [key, value] of Object.entries(variables)) {
      newContext.instructions.push(`ENV ${key}="${value}"`);
    }
    return new ImageInstance(newContext);
  }

  /**
   * Copy files or directories from the build context to the image.
   *
   * @param source - Source path (relative to build context)
   * @param destination - Destination path in the image
   * @returns A new Image instance with the copy instruction
   */
  copy(source: string, destination: string): ImageInstance {
    const newContext = cloneContext(this._context);
    newContext.instructions.push(`COPY ${source} ${destination}`);
    return new ImageInstance(newContext);
  }

  /**
   * Add a local file to the build context and copy it to the image.
   *
   * @param sourcePath - Path to the local file
   * @param destination - Destination path in the image
   * @param contextName - Optional name for the file in the build context
   * @returns A new Image instance with the file added
   */
  addLocalFile(sourcePath: string, destination: string, contextName?: string): ImageInstance {
    ensureNodeEnvironment();
    const source = path!.resolve(sourcePath);
    const name = contextName ?? path!.basename(source);

    const newContext = cloneContext(this._context);
    newContext.localFiles.push({
      sourcePath: source,
      destinationPath: destination,
      contextName: name,
    });
    newContext.instructions.push(`COPY ${name} ${destination}`);
    return new ImageInstance(newContext);
  }

  /**
   * Add a local directory to the build context and copy it to the image.
   *
   * @param sourcePath - Path to the local directory
   * @param destination - Destination path in the image
   * @param contextName - Optional name for the directory in the build context
   * @returns A new Image instance with the directory added
   */
  addLocalDir(sourcePath: string, destination: string, contextName?: string): ImageInstance {
    ensureNodeEnvironment();
    const source = path!.resolve(sourcePath);
    const name = contextName ?? path!.basename(source);

    const newContext = cloneContext(this._context);
    newContext.localFiles.push({
      sourcePath: source,
      destinationPath: destination,
      contextName: name,
    });
    newContext.instructions.push(`COPY ${name} ${destination}`);
    return new ImageInstance(newContext);
  }

  /**
   * Expose ports.
   *
   * @param ports - Port numbers to expose
   * @returns A new Image instance with the ports exposed
   */
  expose(...ports: number[]): ImageInstance {
    if (ports.length === 0) {
      return this;
    }

    const newContext = cloneContext(this._context);
    for (const port of ports) {
      newContext.instructions.push(`EXPOSE ${port}`);
    }
    return new ImageInstance(newContext);
  }

  /**
   * Set the entrypoint for the image.
   *
   * @param args - Entrypoint command and arguments
   * @returns A new Image instance with the entrypoint set
   */
  entrypoint(...args: string[]): ImageInstance {
    if (args.length === 0) {
      return this;
    }

    // Format as JSON array for exec form, using JSON.stringify to properly escape quotes and special characters
    const argsJson = args.map((arg) => JSON.stringify(arg)).join(", ");
    const newContext = cloneContext(this._context);
    newContext.instructions.push(`ENTRYPOINT [${argsJson}]`);
    newContext.hasEntrypoint = true;
    return new ImageInstance(newContext);
  }

  /**
   * Set the user for subsequent instructions.
   *
   * @param user - Username or UID
   * @returns A new Image instance with the user set
   */
  user(user: string): ImageInstance {
    const newContext = cloneContext(this._context);
    newContext.instructions.push(`USER ${user}`);
    return new ImageInstance(newContext);
  }

  /**
   * Add labels to the image.
   *
   * @param labels - Labels as an object
   * @returns A new Image instance with the labels added
   */
  label(labels: Record<string, string>): ImageInstance {
    const keys = Object.keys(labels);
    if (keys.length === 0) {
      return this;
    }

    const newContext = cloneContext(this._context);
    for (const [key, value] of Object.entries(labels)) {
      newContext.instructions.push(`LABEL ${key}="${value}"`);
    }
    return new ImageInstance(newContext);
  }

  /**
   * Define a build argument.
   *
   * @param name - Argument name
   * @param defaultValue - Optional default value
   * @returns A new Image instance with the argument defined
   */
  arg(name: string, defaultValue?: string): ImageInstance {
    const newContext = cloneContext(this._context);
    if (defaultValue !== undefined) {
      newContext.instructions.push(`ARG ${name}=${defaultValue}`);
    } else {
      newContext.instructions.push(`ARG ${name}`);
    }
    return new ImageInstance(newContext);
  }

  /**
   * Get the generated Dockerfile content.
   */
  get dockerfile(): string {
    return generateDockerfile(this._context);
  }

  /**
   * Get a hash of the image configuration.
   */
  get hash(): string {
    return computeHash(this._context);
  }

  /**
   * Get the base image tag.
   */
  get baseImage(): string {
    return this._context.baseImage;
  }

  private _hasSandboxApi(): boolean {
    const dockerfile = generateDockerfile(this._context);
    return dockerfile.includes("sandbox-api") || dockerfile.includes("blaxel-ai/sandbox");
  }

  private _prepareForSandbox(sandboxVersion: string = "latest"): ImageInstance {
    const newContext = cloneContext(this._context);

    // Add sandbox-api if not already present
    if (!this._hasSandboxApi()) {
      const sandboxImage = `${SANDBOX_API_IMAGE}:${sandboxVersion}`;
      const copyInstruction = `COPY --from=${sandboxImage} /sandbox-api ${SANDBOX_API_PATH}`;
      newContext.instructions.push(copyInstruction);
    }

    // Add default entrypoint if not set by user
    if (!newContext.hasEntrypoint) {
      newContext.instructions.push(`ENTRYPOINT ["${SANDBOX_API_PATH}"]`);
      newContext.hasEntrypoint = true;
    }

    return new ImageInstance(newContext);
  }

  /**
   * Write the image to a deployable folder structure.
   *
   * @param outputPath - Path to the output directory
   * @param name - Optional name for the generated folder (defaults to hash-based name)
   * @returns Path to the generated folder
   */
  write(outputPath: string, name?: string): string {
    ensureNodeEnvironment();
    const outputDir = path!.resolve(outputPath);

    // Create folder name based on hash if not provided
    if (!name) {
      name = `image-${this.hash}`;
    }

    const buildDir = path!.join(outputDir, name);
    fs!.mkdirSync(buildDir, { recursive: true });

    // Generate Dockerfile
    const dockerfilePath = path!.join(buildDir, "Dockerfile");
    fs!.writeFileSync(dockerfilePath, generateDockerfile(this._context));

    // Copy local files to build context
    for (const localFile of this._context.localFiles) {
      if (!fs!.existsSync(localFile.sourcePath)) {
        throw new Error(`Local file not found: ${localFile.sourcePath}`);
      }

      const dest = path!.join(buildDir, localFile.contextName);
      const stat = fs!.statSync(localFile.sourcePath);
      if (stat.isDirectory()) {
        if (fs!.existsSync(dest)) {
          fs!.rmSync(dest, { recursive: true });
        }
        fs!.cpSync(localFile.sourcePath, dest, { recursive: true });
      } else {
        fs!.cpSync(localFile.sourcePath, dest);
      }
    }

    // Generate a manifest file with metadata
    const manifest = {
      base_image: this._context.baseImage,
      hash: this.hash,
      instructions_count: this._context.instructions.length,
      local_files_count: this._context.localFiles.length,
    };
    const manifestPath = path!.join(buildDir, "manifest.json");
    fs!.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return buildDir;
  }

  /**
   * Write the image to a deployable folder in a temporary directory.
   *
   * @returns Path to the generated folder
   */
  writeTemp(): string {
    ensureNodeEnvironment();
    const tempDir = path!.join(os!.tmpdir(), `blaxel-image-${Date.now()}`);
    fs!.mkdirSync(tempDir, { recursive: true });
    return this.write(tempDir);
  }

  private async _createZip(buildDir: string): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];

      const archive = archiver("zip", {
        zlib: { level: 9 },
      });

      archive.on("data", (chunk: Uint8Array) => {
        chunks.push(chunk);
      });

      archive.on("end", () => {
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(result);
      });

      archive.on("error", reject);

      // Add all files from the build directory
      archive.directory(buildDir, false);

      void archive.finalize();
    });
  }

  private _createSandboxPayload(name: string, memory: number = 4096): Sandbox {
    const labels: MetadataLabels = {
      "x-blaxel-auto-generated": "true",
    };

    const metadata: Metadata = {
      name,
      labels,
    };

    const runtime: SandboxRuntime = {
      memory,
    };

    const spec: SandboxSpec = {
      runtime,
    };

    return {
      metadata,
      spec,
    };
  }

  private async _createSandboxWithUpload(sandbox: Sandbox): Promise<{ response: Response; uploadUrl: string | null }> {
    const name = sandbox.metadata?.name || "";
    const body = sandbox;

    await settings.authenticate();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...settings.headers,
    };

    // Try PUT first (update), fall back to POST (create)
    let response = await fetch(`${settings.baseUrl}/sandboxes/${name}?upload=true`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });

    // If 404, try create
    if (response.status === 404) {
      response = await fetch(`${settings.baseUrl}/sandboxes?upload=true`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    }

    const uploadUrl = response.headers.get("x-blaxel-upload-url");

    return { response, uploadUrl };
  }

  private async _uploadZip(uploadUrl: string, zipContent: Uint8Array): Promise<void> {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/zip",
      },
      body: zipContent,
    });

    if (response.status >= 400) {
      const text = await response.text();
      throw new Error(`Upload failed with status ${response.status}: ${text}`);
    }
  }

  private async _getSandboxStatus(name: string): Promise<string | null> {
    await settings.authenticate();

    const response = await fetch(`${settings.baseUrl}/sandboxes/${name}`, {
      method: "GET",
      headers: settings.headers,
    });

    if (response.status === 200) {
      const data = (await response.json()) as { status?: string };
      return data.status || null;
    }
    return null;
  }

  private async _waitForDeployment(
    name: string,
    timeout: number = 900000, // 15 minutes in ms
    pollInterval: number = 3000,
    onStatusChange?: (status: string) => void
  ): Promise<string> {
    const startTime = Date.now();
    let lastStatus: string | null = null;
    const terminalStates = new Set(["DEPLOYED", "FAILED", "TERMINATED"]);
    let buildStarted = false;

    while (Date.now() - startTime < timeout) {
      const status = await this._getSandboxStatus(name);

      if (status && status !== lastStatus) {
        lastStatus = status;
        if (onStatusChange) {
          onStatusChange(status);
        }
      }

      // Track if the build has started (status changed from DEPLOYED)
      if (status && status !== "DEPLOYED") {
        buildStarted = true;
      }

      // Only consider DEPLOYED as terminal if the build has started
      // This handles re-builds where status starts as DEPLOYED
      if (status && terminalStates.has(status)) {
        if (status === "FAILED") {
          throw new Error(`Deployment failed for sandbox '${name}'`);
        }
        if (status === "TERMINATED") {
          throw new Error(`Sandbox '${name}' was terminated`);
        }
        if (status === "DEPLOYED" && buildStarted) {
          return status;
        }
      }

      await sleep(pollInterval);
    }

    throw new Error(`Deployment timed out after ${timeout / 1000} seconds`);
  }

  /**
   * Build and deploy the image as a sandbox.
   *
   * This method:
   * 1. Prepares the image for sandbox deployment (adds sandbox-api)
   * 2. Builds the image folder
   * 3. Creates a zip of the folder
   * 4. Creates/updates the sandbox resource
   * 5. Uploads the zip to Blaxel
   * 6. Waits for deployment to complete
   *
   * @param options - Build options
   * @returns The deployed Sandbox object
   */
  async build(options: ImageBuildOptions): Promise<Sandbox> {
    const { name, memory = 4096, timeout = 900000, onStatusChange, sandboxVersion = "latest" } = options;

    // Prepare image for sandbox deployment (add sandbox-api and entrypoint)
    const preparedImage = this._prepareForSandbox(sandboxVersion);

    // Write the image folder
    const buildDir = preparedImage.writeTemp();

    try {
      // Create zip
      const zipContent = await this._createZip(buildDir);

      // Create sandbox payload
      const sandboxPayload = this._createSandboxPayload(name, memory);

      // Create/update sandbox and get upload URL
      const { response, uploadUrl } = await this._createSandboxWithUpload(sandboxPayload);

      if (response.status >= 400) {
        const text = await response.text();
        throw new Error(`Failed to create sandbox: ${response.status} - ${text}`);
      }

      if (!uploadUrl) {
        throw new Error("No upload URL returned from API");
      }

      // Upload the zip
      await this._uploadZip(uploadUrl, zipContent);

      // Wait for deployment to complete
      await this._waitForDeployment(name, timeout, 3000, onStatusChange);

      // Get the final sandbox state
      await settings.authenticate();

      const finalResponse = await fetch(`${settings.baseUrl}/sandboxes/${name}`, {
        method: "GET",
        headers: settings.headers,
      });

      if (finalResponse.status === 200) {
        const sandbox = (await finalResponse.json()) as Sandbox;
        return sandbox;
      }

      throw new Error(`Failed to get sandbox '${name}' after deployment`);
    } finally {
      // Cleanup temp directory
      const parentDir = path!.resolve(buildDir, "..");
      try {
        fs!.rmSync(parentDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Build and deploy the image as a sandbox (sync version).
   *
   * @deprecated Use build() instead - this is provided for API parity with Python SDK
   */
  buildSync(options: ImageBuildOptions): Promise<Sandbox> {
    return this.build(options);
  }
}
