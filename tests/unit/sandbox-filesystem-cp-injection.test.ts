import { describe, expect, it } from "vitest";
import { SandboxFileSystem } from "../../@blaxel/core/src/sandbox/filesystem/filesystem.js";

// The sandbox process API takes a single command string, which the server runs
// as `sh -c <command>`. Anything cp() interpolates into that string is parsed
// by a shell, so a path carrying shell metacharacters would otherwise run as
// its own command.
const injectionPayloads = [
  "/tmp/out; touch /tmp/pwned",
  "/tmp/$(touch /tmp/pwned)",
  "/tmp/`touch /tmp/pwned`",
  "/tmp/a && touch /tmp/pwned",
  "/tmp/a | touch /tmp/pwned",
  "/tmp/a > /tmp/pwned",
  "/tmp/with space",
  "/tmp/it's-quoted",
];

type CpHarness = {
  cp(source: string, destination: string): Promise<unknown>;
  process: {
    exec(request: { command: string }): Promise<{ pid: string }>;
    wait(pid: string, options: unknown): Promise<{ status: string; logs: string }>;
  };
};

function createCpHarness(): { filesystem: CpHarness; commands: string[] } {
  const commands: string[] = [];
  const filesystem = Object.create(SandboxFileSystem.prototype) as CpHarness;
  filesystem.process = {
    exec: (request) => {
      commands.push(request.command);
      return Promise.resolve({ pid: "pid-1" });
    },
    wait: () => Promise.resolve({ status: "completed", logs: "" }),
  };
  return { filesystem, commands };
}

// A path is safe only if the shell would read it as one literal argument.
// Strip the quoted form of the payload out of the command; whatever is left is
// what the shell gets to interpret, and it must contain no injected command.
function assertPayloadIsInert(command: string, payload: string) {
  const quotedPayload = `'${payload.replace(/'/g, `'\\''`)}'`;
  expect(command).toContain(quotedPayload);
  expect(command.replace(quotedPayload, "")).not.toContain("touch /tmp/pwned");
}

describe("SandboxFileSystem.cp shell injection", () => {
  for (const payload of injectionPayloads) {
    it(`quotes a malicious source path: ${payload}`, async () => {
      const { filesystem, commands } = createCpHarness();

      await filesystem.cp(payload, "/tmp/dst");

      expect(commands).toHaveLength(1);
      assertPayloadIsInert(commands[0], payload);
    });

    it(`quotes a malicious destination path: ${payload}`, async () => {
      const { filesystem, commands } = createCpHarness();

      await filesystem.cp("/tmp/src", payload);

      expect(commands).toHaveLength(1);
      assertPayloadIsInert(commands[0], payload);
    });
  }

  it("still copies ordinary paths", async () => {
    const { filesystem, commands } = createCpHarness();

    const result = await filesystem.cp("/tmp/src", "/tmp/dst");

    expect(commands[0]).toBe("cp -r '/tmp/src' '/tmp/dst'");
    expect(result).toEqual({
      message: "Files copied",
      source: "/tmp/src",
      destination: "/tmp/dst",
    });
  });
});
