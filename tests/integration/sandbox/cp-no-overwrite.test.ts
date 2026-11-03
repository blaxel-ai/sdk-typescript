import { SandboxFileExistsError, SandboxInstance } from "@blaxel/core";
import { expect, it } from "vitest";
import { defaultImage, defaultLabels, uniqueName } from "./helpers.js";

it("protects cp final entries, directory children and parallel copies without changing defaults", async () => {
  const name = uniqueName("cp-no-overwrite");
  try {
    const sandbox = await SandboxInstance.create({ name, image: defaultImage, region: "us-was-1", memory: 512, labels: defaultLabels });
    const setup = await sandbox.process.exec({
      command: "mkdir -p /tmp/cpn/container /tmp/cpn/tree/sub /tmp/cpn/race; printf source-new > /tmp/cpn/source; printf target-original > /tmp/cpn/target; printf hidden > /tmp/cpn/tree/.hidden; printf nested > /tmp/cpn/tree/sub/file; ln -s sub/file /tmp/cpn/tree/link; ln -s missing /tmp/cpn/source-link; ln -s missing /tmp/cpn/dangling-target",
      waitForCompletion: true,
    });
    expect(setup.exitCode).toBe(0);
    await expect(sandbox.fs.cp("/tmp/cpn/source", "/tmp/cpn/target", { noOverwrite: true })).rejects.toBeInstanceOf(SandboxFileExistsError);
    expect(await sandbox.fs.read("/tmp/cpn/target")).toBe("target-original");
    expect(await sandbox.fs.cp("/tmp/cpn/source", "/tmp/cpn/new-target", { noOverwrite: true })).toEqual({ message: "Files copied", source: "/tmp/cpn/source", destination: "/tmp/cpn/new-target" });
    expect(await sandbox.fs.read("/tmp/cpn/new-target")).toBe("source-new");
    await expect(sandbox.fs.cp("/tmp/cpn/source", "/tmp/cpn/new-target", { noOverwrite: true })).rejects.toBeInstanceOf(SandboxFileExistsError);

    await sandbox.fs.cp("/tmp/cpn/source", "/tmp/cpn/container", { noOverwrite: true });
    expect(await sandbox.fs.read("/tmp/cpn/container/source")).toBe("source-new");
    await expect(sandbox.fs.cp("/tmp/cpn/source", "/tmp/cpn/container", { noOverwrite: true })).rejects.toBeInstanceOf(SandboxFileExistsError);
    await sandbox.fs.cp("/tmp/cpn/tree", "/tmp/cpn/new-tree", { noOverwrite: true });
    expect(await sandbox.fs.read("/tmp/cpn/new-tree/.hidden")).toBe("hidden");
    expect(await sandbox.fs.read("/tmp/cpn/new-tree/sub/file")).toBe("nested");
    await sandbox.fs.cp("/tmp/cpn/source-link", "/tmp/cpn/new-link", { noOverwrite: true });
    const links = await sandbox.process.exec({ command: "test -L /tmp/cpn/new-tree/link && test \"$(readlink /tmp/cpn/new-tree/link)\" = sub/file && test -L /tmp/cpn/new-link && test \"$(readlink /tmp/cpn/new-link)\" = missing && test ! -e /tmp/cpn/new-tree/tree", waitForCompletion: true });
    expect(links.exitCode).toBe(0);
    await expect(sandbox.fs.cp("/tmp/cpn/source-link", "/tmp/cpn/new-link", { noOverwrite: true })).rejects.toBeInstanceOf(SandboxFileExistsError);
    await expect(sandbox.fs.cp("/tmp/cpn/source", "/tmp/cpn/dangling-target", { noOverwrite: true })).rejects.toBeInstanceOf(SandboxFileExistsError);

    const race = await Promise.allSettled(Array.from({ length: 8 }, () => sandbox.fs.cp("/tmp/cpn/tree", "/tmp/cpn/race", { noOverwrite: true })));
    expect(race.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter(result => result.status === "rejected" && result.reason instanceof SandboxFileExistsError)).toHaveLength(7);
    expect(await sandbox.fs.read("/tmp/cpn/race/tree/.hidden")).toBe("hidden");
    await sandbox.fs.cp("/tmp/cpn/source", "/tmp/cpn/target", { noOverwrite: false });
    expect(await sandbox.fs.read("/tmp/cpn/target")).toBe("source-new");
  } finally {
    await SandboxInstance.delete(name);
  }
}, 55_000);
