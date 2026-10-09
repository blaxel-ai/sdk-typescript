/**
 * Thrown by `cp(..., { noOverwrite: true })` when the sandbox API reports that the
 * final target already exists (HTTP 409, code `FILE_ALREADY_EXISTS`). The target is
 * left unchanged. Paths are the original request strings, not the resolved child path.
 */
export class SandboxFileExistsError extends Error {
  readonly code = "FILE_ALREADY_EXISTS" as const;

  constructor(readonly source: string, readonly destination: string, options?: { cause?: unknown }) {
    super(`Could not copy ${source} to ${destination}: destination already exists`, options);
    this.name = "SandboxFileExistsError";
  }
}
