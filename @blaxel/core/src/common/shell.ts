/**
 * Quote a string so a POSIX shell reads it as one literal argument.
 *
 * The sandbox process API accepts a single command string, which the server
 * runs as `sh -c <command>`. Any value interpolated into that string is parsed
 * by the shell, so an unquoted path containing `;`, `|`, `&&`, `$()`, backticks
 * or `>` would execute as its own command. Single quotes suppress every form of
 * shell expansion; the only character they cannot contain is a single quote
 * itself, which is closed, escaped, and reopened.
 *
 * This is the TypeScript equivalent of Python's `shlex.quote`.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
