/**
 * Thrown when Blaxel credentials are missing or incomplete.
 *
 * Surfaced eagerly with an actionable message (which env var / login step is
 * missing) instead of silently sending empty workspace/authorization headers
 * and letting the user hit a misleading server-side "workspace is required".
 */
export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

export function handleDynamicImportError(err: any) {
  if (err instanceof Error) {
    // We check if it's module import error and retrieve package name from the error message with a regex
    if (err.message.includes("Cannot find module")) {
      const packageName = err.message.match(
        /Cannot find module '([^']+)'/
      )?.[1];
      if (packageName) {
        err.message = `Dependency not found. Please run one of the following commands to install it:
- npm: 'npm install ${packageName}'
- yarn: 'yarn add ${packageName}'
- pnpm: 'pnpm add ${packageName}'`;
      }
    }
  }
}