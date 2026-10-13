/**
 * @vitest-environment node
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "../client/types.gen.js";
import { settings } from "../common/settings.js";
import { ImageInstance } from "./image.js";

// Test fixtures
let tempDir: string;
let tempFile: string;
let tempSourceDir: string;

beforeEach(() => {
  // Create temp directory
  tempDir = mkdtempSync(join(tmpdir(), "blaxel-test-"));

  // Create temp file
  tempFile = join(tempDir, "test.txt");
  writeFileSync(tempFile, "test content");

  // Create temp source directory with test files
  tempSourceDir = join(tempDir, "source");
  mkdirSync(tempSourceDir);
  writeFileSync(join(tempSourceDir, "file1.txt"), "content1");
  writeFileSync(join(tempSourceDir, "file2.txt"), "content2");
  mkdirSync(join(tempSourceDir, "subdir"));
  writeFileSync(join(tempSourceDir, "subdir", "nested.txt"), "nested content");
});

afterEach(() => {
  // Cleanup temp directory
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("ImageInstanceInstance.fromRegistry", () => {
  it("creates image with correct base image", () => {
    const image = ImageInstance.fromRegistry("python:3.11-slim");
    expect(image.baseImage).toBe("python:3.11-slim");
  });

  it("works with full DockerHub image tag", () => {
    const image = ImageInstance.fromRegistry(
      "namanjain12/numpy_final:05aa44d53f4f9528847a0c014fe4bda5caa5fd3d"
    );
    expect(image.baseImage).toBe(
      "namanjain12/numpy_final:05aa44d53f4f9528847a0c014fe4bda5caa5fd3d"
    );
  });

  it("generates correct FROM instruction in dockerfile", () => {
    const image = ImageInstance.fromRegistry("ubuntu:22.04");
    expect(image.dockerfile).toContain("FROM ubuntu:22.04");
  });

  it("works with private registry URL", () => {
    const image = ImageInstance.fromRegistry("gcr.io/my-project/my-image:v1.0.0");
    expect(image.baseImage).toBe("gcr.io/my-project/my-image:v1.0.0");
    expect(image.dockerfile).toContain("FROM gcr.io/my-project/my-image:v1.0.0");
  });

  it("works with image digest", () => {
    const image = ImageInstance.fromRegistry(
      "python@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
    );
    expect(image.baseImage).toContain("sha256:abcdef");
  });
});

describe("ImageInstanceInstance.workdir", () => {
  it("adds WORKDIR instruction", () => {
    const image = ImageInstance.fromRegistry("python:3.11").workdir("/app");
    expect(image.dockerfile).toContain("WORKDIR /app");
  });

  it("returns new image instance (immutability)", () => {
    const image1 = ImageInstance.fromRegistry("python:3.11");
    const image2 = image1.workdir("/app");
    expect(image1).not.toBe(image2);
    expect(image1.dockerfile).not.toContain("WORKDIR /app");
    expect(image2.dockerfile).toContain("WORKDIR /app");
  });

  it("supports multiple workdir changes in sequence", () => {
    const image = ImageInstance.fromRegistry("python:3.11")
      .workdir("/first")
      .runCommands("echo first")
      .workdir("/second")
      .runCommands("echo second");

    const dockerfile = image.dockerfile;
    expect(dockerfile).toContain("WORKDIR /first");
    expect(dockerfile).toContain("WORKDIR /second");
    // Check order
    const firstIdx = dockerfile.indexOf("WORKDIR /first");
    const secondIdx = dockerfile.indexOf("WORKDIR /second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});

describe("ImageInstanceInstance.runCommands", () => {
  it("adds single RUN instruction", () => {
    const image = ImageInstance.fromRegistry("python:3.11").runCommands("echo hello");
    expect(image.dockerfile).toContain("RUN echo hello");
  });

  it("adds multiple RUN instructions", () => {
    const image = ImageInstance.fromRegistry("python:3.11").runCommands(
      "echo hello",
      "echo world"
    );
    expect(image.dockerfile).toContain("RUN echo hello");
    expect(image.dockerfile).toContain("RUN echo world");
  });

  it("supports chaining multiple runCommands calls", () => {
    const image = ImageInstance.fromRegistry("python:3.11")
      .runCommands("echo first")
      .runCommands("echo second");
    expect(image.dockerfile).toContain("RUN echo first");
    expect(image.dockerfile).toContain("RUN echo second");
  });

  it("works with complex shell commands", () => {
    const image = ImageInstance.fromRegistry("python:3.11").runCommands(
      "cd /app && git clone https://github.com/example/repo.git",
      "find . -name '*.pyc' -delete",
      "chmod +x ./run_tests.sh && ./run_tests.sh"
    );
    const dockerfile = image.dockerfile;
    expect(dockerfile).toContain("git clone");
    expect(dockerfile).toContain("find . -name");
    expect(dockerfile).toContain("chmod +x");
  });
});

describe("ImageInstanceInstance.env", () => {
  it("sets single variable", () => {
    const image = ImageInstance.fromRegistry("python:3.11").env({ PYTHONUNBUFFERED: "1" });
    expect(image.dockerfile).toContain('ENV PYTHONUNBUFFERED="1"');
  });

  it("sets multiple variables", () => {
    const image = ImageInstance.fromRegistry("python:3.11").env({
      PYTHONUNBUFFERED: "1",
      DEBUG: "true",
    });
    expect(image.dockerfile).toContain('ENV PYTHONUNBUFFERED="1"');
    expect(image.dockerfile).toContain('ENV DEBUG="true"');
  });

  it("returns same image with empty object", () => {
    const image1 = ImageInstance.fromRegistry("python:3.11");
    const image2 = image1.env({});
    expect(image1).toBe(image2);
  });

  it("handles special characters in values", () => {
    const image = ImageInstance.fromRegistry("python:3.11").env({
      PATH: "/usr/local/bin:$PATH",
      CONNECTION_STRING: "host=localhost;port=5432",
    });
    const dockerfile = image.dockerfile;
    expect(dockerfile).toContain('ENV PATH="/usr/local/bin:$PATH"');
    expect(dockerfile).toContain('ENV CONNECTION_STRING="host=localhost;port=5432"');
  });
});

describe("ImageInstanceInstance.copy", () => {
  it("adds COPY instruction", () => {
    const image = ImageInstance.fromRegistry("python:3.11").copy(".", "/app");
    expect(image.dockerfile).toContain("COPY . /app");
  });

  it("works with specific paths", () => {
    const image = ImageInstance.fromRegistry("python:3.11").copy(
      "requirements.txt",
      "/app/requirements.txt"
    );
    expect(image.dockerfile).toContain("COPY requirements.txt /app/requirements.txt");
  });

  it("supports multiple copy instructions", () => {
    const image = ImageInstance.fromRegistry("python:3.11")
      .copy("requirements.txt", "/app/requirements.txt")
      .copy("src/", "/app/src/");
    const dockerfile = image.dockerfile;
    expect(dockerfile).toContain("COPY requirements.txt /app/requirements.txt");
    expect(dockerfile).toContain("COPY src/ /app/src/");
  });
});

describe("ImageInstanceInstance.expose", () => {
  it("exposes single port", () => {
    const image = ImageInstance.fromRegistry("python:3.11").expose(8080);
    expect(image.dockerfile).toContain("EXPOSE 8080");
  });

  it("exposes multiple ports", () => {
    const image = ImageInstance.fromRegistry("python:3.11").expose(80, 443, 8080);
    expect(image.dockerfile).toContain("EXPOSE 80");
    expect(image.dockerfile).toContain("EXPOSE 443");
    expect(image.dockerfile).toContain("EXPOSE 8080");
  });

  it("returns same image with no ports", () => {
    const image1 = ImageInstance.fromRegistry("python:3.11");
    const image2 = image1.expose();
    expect(image1).toBe(image2);
  });
});

describe("ImageInstanceInstance.entrypoint", () => {
  it("sets single arg entrypoint", () => {
    const image = ImageInstance.fromRegistry("python:3.11").entrypoint("python");
    expect(image.dockerfile).toContain('ENTRYPOINT ["python"]');
  });

  it("sets multiple args entrypoint", () => {
    const image = ImageInstance.fromRegistry("python:3.11").entrypoint("python", "-m", "app");
    expect(image.dockerfile).toContain('ENTRYPOINT ["python", "-m", "app"]');
  });

  it("returns same image with no args", () => {
    const image1 = ImageInstance.fromRegistry("python:3.11");
    const image2 = image1.entrypoint();
    expect(image1).toBe(image2);
  });

  it("escapes double quotes in arguments", () => {
    const image = ImageInstance.fromRegistry("python:3.11").entrypoint("echo", 'hello"world');
    expect(image.dockerfile).toContain('ENTRYPOINT ["echo", "hello\\"world"]');
  });

  it("escapes backslashes in arguments", () => {
    const image = ImageInstance.fromRegistry("python:3.11").entrypoint("echo", "path\\to\\file");
    expect(image.dockerfile).toContain('ENTRYPOINT ["echo", "path\\\\to\\\\file"]');
  });

  it("escapes newlines in arguments", () => {
    const image = ImageInstance.fromRegistry("python:3.11").entrypoint("echo", "line1\nline2");
    expect(image.dockerfile).toContain('ENTRYPOINT ["echo", "line1\\nline2"]');
  });

  it("handles complex strings with multiple special characters", () => {
    const image = ImageInstance.fromRegistry("python:3.11").entrypoint(
      "/bin/sh",
      "-c",
      'echo "hello\nworld" && cat /path\\to\\file'
    );
    const dockerfile = image.dockerfile;
    expect(dockerfile).toContain('ENTRYPOINT ["/bin/sh", "-c", "echo \\"hello\\nworld\\" && cat /path\\\\to\\\\file"]');
  });
});

describe("ImageInstanceInstance.user", () => {
  it("sets user by name", () => {
    const image = ImageInstance.fromRegistry("python:3.11").user("appuser");
    expect(image.dockerfile).toContain("USER appuser");
  });

  it("sets user by UID", () => {
    const image = ImageInstance.fromRegistry("python:3.11").user("1000");
    expect(image.dockerfile).toContain("USER 1000");
  });

  it("sets user with UID:GID format", () => {
    const image = ImageInstance.fromRegistry("python:3.11").user("1000:1000");
    expect(image.dockerfile).toContain("USER 1000:1000");
  });
});

describe("ImageInstanceInstance.label", () => {
  it("adds single label", () => {
    const image = ImageInstance.fromRegistry("python:3.11").label({ version: "1.0" });
    expect(image.dockerfile).toContain('LABEL version="1.0"');
  });

  it("adds multiple labels", () => {
    const image = ImageInstance.fromRegistry("python:3.11").label({
      version: "1.0",
      maintainer: "test@example.com",
    });
    expect(image.dockerfile).toContain('LABEL version="1.0"');
    expect(image.dockerfile).toContain('LABEL maintainer="test@example.com"');
  });

  it("returns same image with empty object", () => {
    const image1 = ImageInstance.fromRegistry("python:3.11");
    const image2 = image1.label({});
    expect(image1).toBe(image2);
  });
});

describe("ImageInstanceInstance.arg", () => {
  it("defines arg without default value", () => {
    const image = ImageInstance.fromRegistry("python:3.11").arg("VERSION");
    expect(image.dockerfile).toContain("ARG VERSION");
  });

  it("defines arg with default value", () => {
    const image = ImageInstance.fromRegistry("python:3.11").arg("VERSION", "1.0");
    expect(image.dockerfile).toContain("ARG VERSION=1.0");
  });

  it("supports multiple ARG instructions", () => {
    const image = ImageInstance.fromRegistry("python:3.11")
      .arg("VERSION", "1.0")
      .arg("BUILD_DATE")
      .arg("GIT_COMMIT", "unknown");
    const dockerfile = image.dockerfile;
    expect(dockerfile).toContain("ARG VERSION=1.0");
    expect(dockerfile).toContain("ARG BUILD_DATE");
    expect(dockerfile).toContain("ARG GIT_COMMIT=unknown");
  });
});

describe("ImageInstance chaining", () => {
  it("supports full chain of operations", () => {
    const image = ImageInstance.fromRegistry("python:3.11-slim")
      .runCommands("apt-get update && apt-get install -y git curl")
      .workdir("/app")
      .copy(".", "/app")
      .runCommands("pip install -r requirements.txt")
      .env({ PYTHONUNBUFFERED: "1" })
      .expose(8080);

    const dockerfile = image.dockerfile;
    expect(dockerfile).toContain("FROM python:3.11-slim");
    expect(dockerfile).toContain("apt-get install");
    expect(dockerfile).toContain("WORKDIR /app");
    expect(dockerfile).toContain("COPY . /app");
    expect(dockerfile).toContain("RUN pip install -r requirements.txt");
    expect(dockerfile).toContain('ENV PYTHONUNBUFFERED="1"');
    expect(dockerfile).toContain("EXPOSE 8080");
  });

  it("maintains immutability through chaining", () => {
    const base = ImageInstance.fromRegistry("python:3.11");
    const withWorkdir = base.workdir("/app");
    const withEnv = withWorkdir.env({ DEBUG: "true" });

    // Each should be a different instance
    expect(base).not.toBe(withWorkdir);
    expect(withWorkdir).not.toBe(withEnv);
    expect(base).not.toBe(withEnv);

    // Original should not be modified
    expect(base.dockerfile).not.toContain("WORKDIR");
    expect(base.dockerfile).not.toContain("ENV");
  });

  it("supports complex web app image pattern", () => {
    const image = ImageInstance.fromRegistry("python:3.11-slim")
      .arg("APP_VERSION", "1.0.0")
      .label({
        maintainer: "dev@example.com",
        version: "1.0.0",
      })
      .runCommands("apt-get update && apt-get install -y curl ca-certificates")
      .workdir("/app")
      .env({
        PYTHONUNBUFFERED: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PIP_NO_CACHE_DIR: "1",
      })
      .copy("requirements.txt", "/app/requirements.txt")
      .runCommands("pip install -r requirements.txt")
      .copy(".", "/app")
      .user("1000:1000")
      .expose(8000)
      .entrypoint("python", "-m", "gunicorn");

    const dockerfile = image.dockerfile;
    expect(dockerfile).toContain("FROM python:3.11-slim");
    expect(dockerfile).toContain("ARG APP_VERSION=1.0.0");
    expect(dockerfile).toContain('LABEL maintainer="dev@example.com"');
    expect(dockerfile).toContain("apt-get install");
    expect(dockerfile).toContain("WORKDIR /app");
    expect(dockerfile).toContain("PYTHONUNBUFFERED");
    expect(dockerfile).toContain("USER 1000:1000");
    expect(dockerfile).toContain("EXPOSE 8000");
    expect(dockerfile).toContain("ENTRYPOINT");
  });
});

describe("ImageInstanceInstance.hash", () => {
  it("produces consistent hash for same image", () => {
    const image1 = ImageInstance.fromRegistry("python:3.11").workdir("/app");
    const image2 = ImageInstance.fromRegistry("python:3.11").workdir("/app");
    expect(image1.hash).toBe(image2.hash);
  });

  it("produces different hash for different images", () => {
    const image1 = ImageInstance.fromRegistry("python:3.11").workdir("/app");
    const image2 = ImageInstance.fromRegistry("python:3.11").workdir("/other");
    expect(image1.hash).not.toBe(image2.hash);
  });

  it("produces different hash for different base images", () => {
    const image1 = ImageInstance.fromRegistry("python:3.11").workdir("/app");
    const image2 = ImageInstance.fromRegistry("python:3.12").workdir("/app");
    expect(image1.hash).not.toBe(image2.hash);
  });

  it("has consistent length of 12 characters", () => {
    const image = ImageInstance.fromRegistry("python:3.11").workdir("/app");
    expect(image.hash.length).toBe(12);
  });

  it("throws error when local file is missing", () => {
    const image = ImageInstance.fromRegistry("python:3.11").addLocalFile(tempFile, "/app/file.txt");

    // Delete the file after adding it to the image
    rmSync(tempFile);

    expect(() => image.hash).toThrow(/Local file not found/);
  });

  it("throws error when local directory is missing", () => {
    const image = ImageInstance.fromRegistry("python:3.11").addLocalDir(tempSourceDir, "/app");

    // Delete the directory after adding it to the image
    rmSync(tempSourceDir, { recursive: true });

    expect(() => image.hash).toThrow(/Local file not found/);
  });

  it("produces different hash when file content changes", () => {
    const image = ImageInstance.fromRegistry("python:3.11").addLocalFile(tempFile, "/app/file.txt");
    const hash1 = image.hash;

    // Modify the file (change mtime)
    writeFileSync(tempFile, "modified content");
    const hash2 = image.hash;

    expect(hash1).not.toBe(hash2);
  });
});

describe("ImageInstanceInstance.write", () => {
  it("creates Dockerfile", () => {
    const image = ImageInstance.fromRegistry("python:3.11").workdir("/app");
    const buildDir = image.write(tempDir, "test-image");
    const dockerfilePath = join(buildDir, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf-8");

    expect(content).toContain("FROM python:3.11");
    expect(content).toContain("WORKDIR /app");
  });

  it("creates manifest.json", () => {
    const image = ImageInstance.fromRegistry("python:3.11").workdir("/app");
    const buildDir = image.write(tempDir, "test-image");
    const manifestPath = join(buildDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { base_image: string; hash: string; instructions_count: number };

    expect(manifest.base_image).toBe("python:3.11");
    expect(manifest.hash).toBeDefined();
    expect(manifest.instructions_count).toBe(1);
  });

  it("auto-generates folder name from hash", () => {
    const image = ImageInstance.fromRegistry("python:3.11");
    const buildDir = image.write(tempDir);
    const dirName = buildDir.split("/").pop() || "";

    expect(dirName.startsWith("image-")).toBe(true);
    expect(dirName.length).toBe(6 + 12); // "image-" + 12 char hash
  });

  it("creates nested directories if needed", () => {
    const image = ImageInstance.fromRegistry("python:3.11");
    const nestedPath = join(tempDir, "deep", "nested", "path");
    const buildDir = image.write(nestedPath, "test-image");
    const dockerfilePath = join(buildDir, "Dockerfile");

    expect(readFileSync(dockerfilePath, "utf-8")).toContain("FROM python:3.11");
  });
});

describe("ImageInstanceInstance.writeTemp", () => {
  it("creates in temporary directory", () => {
    const image = ImageInstance.fromRegistry("python:3.11").workdir("/app");
    let buildDir: string | null = null;

    try {
      buildDir = image.writeTemp();
      const dockerfilePath = join(buildDir, "Dockerfile");
      const manifestPath = join(buildDir, "manifest.json");

      expect(readFileSync(dockerfilePath, "utf-8")).toContain("FROM python:3.11");
      expect(readFileSync(manifestPath, "utf-8")).toContain("python:3.11");
    } finally {
      if (buildDir) {
        rmSync(join(buildDir, ".."), { recursive: true, force: true });
      }
    }
  });
});

describe("ImageInstanceInstance.addLocalFile", () => {
  it("adds COPY instruction", () => {
    const image = ImageInstance.fromRegistry("python:3.11").addLocalFile(tempFile, "/app/file.txt");
    expect(image.dockerfile).toContain("COPY");
  });

  it("copies file to build context", () => {
    const outputDir = join(tempDir, "output");
    const image = ImageInstance.fromRegistry("python:3.11").addLocalFile(
      tempFile,
      "/app/file.txt",
      "myfile.txt"
    );
    const buildDir = image.write(outputDir, "test-image");
    const copiedFile = join(buildDir, "myfile.txt");

    expect(readFileSync(copiedFile, "utf-8")).toBe("test content");
  });

  it("throws error for missing file", () => {
    const outputDir = join(tempDir, "output");
    const image = ImageInstance.fromRegistry("python:3.11").addLocalFile(
      "/nonexistent/file.txt",
      "/app/file.txt"
    );

    expect(() => image.write(outputDir, "test-image")).toThrow(/not found/i);
  });

  it("adds multiple local files", () => {
    const file1 = join(tempDir, "file1.txt");
    const file2 = join(tempDir, "file2.txt");
    writeFileSync(file1, "content1");
    writeFileSync(file2, "content2");

    const outputDir = join(tempDir, "output");
    const image = ImageInstance.fromRegistry("python:3.11")
      .addLocalFile(file1, "/app/file1.txt")
      .addLocalFile(file2, "/app/file2.txt");
    const buildDir = image.write(outputDir, "test-image");

    expect(readFileSync(join(buildDir, "file1.txt"), "utf-8")).toBe("content1");
    expect(readFileSync(join(buildDir, "file2.txt"), "utf-8")).toBe("content2");
  });
});

describe("ImageInstanceInstance.addLocalDir", () => {
  it("copies directory to build context", () => {
    const outputDir = join(tempDir, "output");
    const image = ImageInstance.fromRegistry("python:3.11").addLocalDir(
      tempSourceDir,
      "/app",
      "mydir"
    );
    const buildDir = image.write(outputDir, "test-image");
    const copiedDir = join(buildDir, "mydir");

    expect(readFileSync(join(copiedDir, "file1.txt"), "utf-8")).toBe("content1");
    expect(readFileSync(join(copiedDir, "file2.txt"), "utf-8")).toBe("content2");
  });

  it("preserves directory structure", () => {
    const outputDir = join(tempDir, "output");
    const image = ImageInstance.fromRegistry("python:3.11").addLocalDir(
      tempSourceDir,
      "/app",
      "mydir"
    );
    const buildDir = image.write(outputDir, "test-image");
    const copiedDir = join(buildDir, "mydir");

    expect(readFileSync(join(copiedDir, "subdir", "nested.txt"), "utf-8")).toBe("nested content");
  });
});

describe("ImageInstance sandbox-api preparation", () => {
  it("adds sandbox-api COPY instruction", () => {
    const image = ImageInstance.fromRegistry("python:3.11-slim");
    // @ts-expect-error - accessing private method for testing
    const prepared = image._prepareForSandbox();

    expect(prepared.dockerfile).toContain(
      "COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api"
    );
  });

  it("adds default entrypoint if not set", () => {
    const image = ImageInstance.fromRegistry("python:3.11-slim");
    // @ts-expect-error - accessing private method for testing
    const prepared = image._prepareForSandbox();

    expect(prepared.dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/sandbox-api"]');
  });

  it("preserves user-defined entrypoint", () => {
    const image = ImageInstance.fromRegistry("python:3.11-slim").entrypoint("/custom/entrypoint");
    // @ts-expect-error - accessing private method for testing
    const prepared = image._prepareForSandbox();

    // User entrypoint should be present
    expect(prepared.dockerfile).toContain('ENTRYPOINT ["/custom/entrypoint"]');
    // Should only have one ENTRYPOINT
    const entrypointCount = (prepared.dockerfile.match(/ENTRYPOINT/g) || []).length;
    expect(entrypointCount).toBe(1);
  });

  it("uses custom sandbox version", () => {
    const image = ImageInstance.fromRegistry("python:3.11-slim");
    // @ts-expect-error - accessing private method for testing
    const prepared = image._prepareForSandbox("v1.2.3");

    expect(prepared.dockerfile).toContain(
      "COPY --from=ghcr.io/blaxel-ai/sandbox:v1.2.3 /sandbox-api /usr/local/bin/sandbox-api"
    );
  });

  it("does not duplicate sandbox-api if base image is sandbox", () => {
    const image = ImageInstance.fromRegistry("ghcr.io/blaxel-ai/sandbox:latest");
    // @ts-expect-error - accessing private method for testing
    expect(image._hasSandboxApi()).toBe(true);

    // @ts-expect-error - accessing private method for testing
    const prepared = image._prepareForSandbox();
    const copyCount = (prepared.dockerfile.match(/COPY --from=ghcr.io\/blaxel-ai\/sandbox/g) || [])
      .length;
    expect(copyCount).toBe(0);
  });

  it("returns new image instance (immutability)", () => {
    const image = ImageInstance.fromRegistry("python:3.11-slim");
    // @ts-expect-error - accessing private method for testing
    const prepared = image._prepareForSandbox();

    expect(image).not.toBe(prepared);
    expect(image.dockerfile).not.toContain("sandbox-api");
    expect(prepared.dockerfile).toContain("sandbox-api");
  });

  it("preserves all original instructions", () => {
    const image = ImageInstance.fromRegistry("python:3.11-slim")
      .runCommands("apt-get update && apt-get install -y curl git")
      .workdir("/app")
      .runCommands("pip install requests")
      .env({ DEBUG: "true" });
    // @ts-expect-error - accessing private method for testing
    const prepared = image._prepareForSandbox();

    expect(prepared.dockerfile).toContain("apt-get install");
    expect(prepared.dockerfile).toContain("WORKDIR /app");
    expect(prepared.dockerfile).toContain("pip install");
    expect(prepared.dockerfile).toContain('DEBUG="true"');
    expect(prepared.dockerfile).toContain("sandbox-api");
  });
});

describe("Dockerfile instruction order", () => {
  it("preserves instruction order", () => {
    const image = ImageInstance.fromRegistry("python:3.11")
      .env({ FIRST: "1" })
      .workdir("/app")
      .env({ SECOND: "2" })
      .runCommands("echo middle")
      .env({ THIRD: "3" });

    const dockerfile = image.dockerfile;
    const lines = dockerfile.split("\n");

    const firstIdx = lines.findIndex((line) => line.includes('FIRST="1"'));
    const workdirIdx = lines.findIndex((line) => line.includes("WORKDIR /app"));
    const secondIdx = lines.findIndex((line) => line.includes('SECOND="2"'));
    const runIdx = lines.findIndex((line) => line.includes("echo middle"));
    const thirdIdx = lines.findIndex((line) => line.includes('THIRD="3"'));

    expect(firstIdx).toBeLessThan(workdirIdx);
    expect(workdirIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(runIdx);
    expect(runIdx).toBeLessThan(thirdIdx);
  });
});

describe("ImageInstance.build worker resources", () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

  // signing: "all" signs every build label, "update" signs only on PUT after a
  // 404 then POST create (production today), "none" never signs them.
  let calls: Call[] = [];

  async function buildWith(
    options: Partial<Parameters<ImageInstance["build"]>[0]>,
    storedLabels?: Record<string, string>,
    signing: "all" | "update" | "none" = "all"
  ) {
    calls = [];
    let created = false;
    vi.spyOn(settings, "authenticate").mockResolvedValue(undefined);
    vi.spyOn(settings, "headers", "get").mockReturnValue({});
    vi.spyOn(settings, "baseUrl", "get").mockReturnValue("https://api.test");
    vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string>;
      const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init.method ?? "GET", headers, body });
      if (url.includes("upload=true")) {
        if (signing === "update" && init.method === "PUT" && !created) {
          return Promise.resolve(new Response("{}", { status: 404 }));
        }
        created ||= init.method === "POST";
        const labels = storedLabels ?? (body as Sandbox).metadata?.labels ?? {};
        const signed = ["host"];
        if (signing === "all" || (signing === "update" && init.method === "PUT")) {
          signed.push(...Object.keys(labels).filter((k) => k.startsWith("x-blaxel-build")).map((k) => `x-amz-meta-${k}`));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ metadata: { name: "img", labels } }), {
            status: 200,
            headers: { "x-blaxel-upload-url": `https://upload.test/object?X-Amz-SignedHeaders=${signed.join(";")}` },
          })
        );
      }
      if (url.startsWith("https://upload.test")) {
        return Promise.resolve(new Response("", { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ metadata: { name: "img" }, status: "DEPLOYED" }), { status: 200 }));
    });
    const image = ImageInstance.fromRegistry("alpine:3.20");
    // @ts-expect-error - private method
    vi.spyOn(image, "_prepareForSandbox").mockReturnValue(image);
    // @ts-expect-error - private method
    vi.spyOn(image, "_waitForDeployment").mockResolvedValue("DEPLOYED");
    await image.build({ name: "img", ...options });
    return {
      create: calls.find((call) => call.url.includes("upload=true"))!,
      upload: calls.find((call) => call.url.startsWith("https://upload.test"))!,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends build memory and volume as labels and signed upload headers", async () => {
    const { create, upload } = await buildWith({ buildMemoryMb: 16384, buildVolumeMb: 32768 });
    const labels = (create.body as Sandbox).metadata?.labels;
    expect(labels?.["x-blaxel-build-memory"]).toBe("16384");
    expect(labels?.["x-blaxel-build-volume"]).toBe("32768");
    expect((create.body as Sandbox).spec?.runtime?.memory).toBe(4096);
    expect(upload.headers["x-amz-meta-x-blaxel-build-memory"]).toBe("16384");
    expect(upload.headers["x-amz-meta-x-blaxel-build-volume"]).toBe("32768");
    expect(upload.headers["x-amz-meta-x-blaxel-auto-generated"]).toBeUndefined();
  });

  it("asks again when creating a sandbox does not sign the settings", async () => {
    const { upload } = await buildWith({ buildMemoryMb: 2048 }, undefined, "update");
    expect(calls.filter((call) => call.url.includes("upload=true")).map((call) => call.method)).toEqual(["PUT", "POST", "PUT"]);
    expect(upload.headers["x-amz-meta-x-blaxel-build-memory"]).toBe("2048");
  });

  it("fails clearly when the settings are never signed", async () => {
    await expect(buildWith({ buildVolumeMb: 32768 }, undefined, "none")).rejects.toThrow("x-blaxel-build-volume");
    expect(calls.some((call) => call.url.startsWith("https://upload.test"))).toBe(false);
  });

  it("drops stored labels the upload URL was not signed for", async () => {
    const { upload } = await buildWith({}, { "x-blaxel-auto-generated": "true", "x-blaxel-build-memory": "8192" }, "none");
    expect(upload.headers["x-amz-meta-x-blaxel-build-memory"]).toBeUndefined();
  });

  it("keeps an explicit zero volume", async () => {
    const { upload } = await buildWith({ buildVolumeMb: 0 });
    expect(upload.headers["x-amz-meta-x-blaxel-build-volume"]).toBe("0");
    expect(upload.headers["x-amz-meta-x-blaxel-build-memory"]).toBeUndefined();
  });

  it("sends no build headers by default", async () => {
    const { upload } = await buildWith({});
    expect(Object.keys(upload.headers).filter((name) => name.startsWith("x-amz-meta-"))).toEqual([]);
  });

  it("mirrors build labels the control plane already stored", async () => {
    const { upload } = await buildWith({}, { "x-blaxel-auto-generated": "true", "x-blaxel-build-memory": "8192" });
    expect(upload.headers["x-amz-meta-x-blaxel-build-memory"]).toBe("8192");
  });

  it.each([
    [{ buildMemoryMb: 0 }, "buildMemoryMb"],
    [{ buildMemoryMb: 32769 }, "buildMemoryMb"],
    [{ buildMemoryMb: 1.5 }, "buildMemoryMb"],
    [{ buildVolumeMb: -1 }, "buildVolumeMb"],
    [{ buildVolumeMb: 131073 }, "buildVolumeMb"],
  ])("rejects out-of-range %o before any request", async (options, option) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(ImageInstance.fromRegistry("alpine:3.20").build({ name: "img", ...options })).rejects.toThrow(option);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
