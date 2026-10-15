import { SandboxInstance } from "@blaxel/core";

export async function deleteSandboxesWithPrefix(namePrefix: string): Promise<void> {
  const page = await SandboxInstance.list({
    limit: 100,
    q: namePrefix,
    showTerminated: true,
  });
  const sandboxes = page.data.filter((sandbox) =>
    sandbox.metadata.name?.startsWith(`${namePrefix}-`),
  );
  const results = await Promise.allSettled(
    sandboxes.map((sandbox) => sandbox.delete()),
  );
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to delete ${failures.length} Blaxel test sandbox${failures.length === 1 ? "" : "es"}.`,
    );
  }
}
