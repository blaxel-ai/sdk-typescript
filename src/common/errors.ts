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