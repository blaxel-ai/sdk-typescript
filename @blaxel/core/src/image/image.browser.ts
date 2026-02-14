/* eslint-disable @typescript-eslint/no-unused-vars */
import { Sandbox } from "../client/types.gen.js";

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

function throwBrowserError(): never {
  throw new Error(
    "ImageInstance is only available in Node.js environments. " +
      "Image building requires file system operations that are not supported in browsers."
  );
}

/**
 * A fluent builder for creating sandbox images programmatically.
 *
 * NOTE: This class is only available in Node.js environments.
 * In browser environments, all methods will throw an error.
 */
export class ImageInstance {
  private _context: ImageBuildContext;

  constructor(_context: ImageBuildContext) {
    this._context = _context;
    throwBrowserError();
  }

  static fromRegistry(_tag: string): ImageInstance {
    throwBrowserError();
  }

  workdir(_path: string): ImageInstance {
    throwBrowserError();
  }

  runCommands(..._commands: string[]): ImageInstance {
    throwBrowserError();
  }

  env(_variables: Record<string, string>): ImageInstance {
    throwBrowserError();
  }

  copy(_source: string, _destination: string): ImageInstance {
    throwBrowserError();
  }

  addLocalFile(_sourcePath: string, _destination: string, _contextName?: string): ImageInstance {
    throwBrowserError();
  }

  addLocalDir(_sourcePath: string, _destination: string, _contextName?: string): ImageInstance {
    throwBrowserError();
  }

  expose(..._ports: number[]): ImageInstance {
    throwBrowserError();
  }

  entrypoint(..._args: string[]): ImageInstance {
    throwBrowserError();
  }

  user(_user: string): ImageInstance {
    throwBrowserError();
  }

  label(_labels: Record<string, string>): ImageInstance {
    throwBrowserError();
  }

  arg(_name: string, _defaultValue?: string): ImageInstance {
    throwBrowserError();
  }

  get dockerfile(): string {
    throw new Error(
      "ImageInstance is only available in Node.js environments. " +
        "Image building requires file system operations that are not supported in browsers."
    );
  }

  get hash(): string {
    throw new Error(
      "ImageInstance is only available in Node.js environments. " +
        "Image building requires file system operations that are not supported in browsers."
    );
  }

  get baseImage(): string {
    throw new Error(
      "ImageInstance is only available in Node.js environments. " +
        "Image building requires file system operations that are not supported in browsers."
    );
  }

  write(_outputPath: string, _name?: string): string {
    throwBrowserError();
  }

  writeTemp(): string {
    throwBrowserError();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async build(_options: ImageBuildOptions): Promise<Sandbox> {
    throwBrowserError();
  }

  buildSync(_options: ImageBuildOptions): Promise<Sandbox> {
    throwBrowserError();
  }
}

