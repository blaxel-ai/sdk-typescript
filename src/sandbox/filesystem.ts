import { Sandbox } from "../client";
import { SandboxAction } from "./action";
import { deleteFilesystemByPath, Directory, getFilesystemByPath, putFilesystemByPath } from "./client";

export type CopyResponse = {
  message: string;
  source: string;
  destination: string;
}

export class SandboxFileSystem extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  async mkdir(path: string, permissions: string = "0755") {
    path = this.formatPath(path);
    const { data } = await putFilesystemByPath({
      path: { path },
      body: { isDirectory: true, permissions },
      baseUrl: this.url,
      throwOnError: true,
    });
    return data;
  }

  async write(path: string, content: string) {
    path = this.formatPath(path);
    const { data } = await putFilesystemByPath({
      path: { path },
      body: { content },
      baseUrl: this.url,
      throwOnError: true,
    });
    return data;
  }

  async read(path: string): Promise<string> {
    path = this.formatPath(path);
    const { data } = await getFilesystemByPath({
      path: { path },
      baseUrl: this.url,
      throwOnError: true,
    });
    if ('content' in data) {
      return data.content as string;
    }
    throw new Error("Unsupported file type");
  }

  async rm(path: string, recursive: boolean = false) {
    path = this.formatPath(path);
    const { data } = await deleteFilesystemByPath({
      path: { path },
      query: { recursive },
      baseUrl: this.url,
      throwOnError: true,
    });
    return data;
  }

  async ls(path: string): Promise<Directory> {
    path = this.formatPath(path);
    const { data } = await getFilesystemByPath({
      path: { path },
      baseUrl: this.url,
      throwOnError: true,
    });
    if (!('files' in data || 'subdirectories' in data)) {
      throw new Error(JSON.stringify({ error: "Directory not found" }));
    }
    return data
  }

  async cp(source: string, destination: string): Promise<CopyResponse> {
    source = this.formatPath(source);
    destination = this.formatPath(destination);
    const { data } = await getFilesystemByPath({
      path: { path: source },
      baseUrl: this.url,
      throwOnError: true,
    });
    if ('files' in data || 'subdirectories' in data) {
      // Create destination directory
      await this.mkdir(destination);

      // Process subdirectories in batches of 5
      const subdirectories = data.subdirectories || [];
      for (let i = 0; i < subdirectories.length; i += 5) {
        const batch = subdirectories.slice(i, i + 5);
        await Promise.all(
          batch.map(async (subdir) => {
            const sourcePath = subdir.path || `${source}/${subdir.path}`;
            const destPath = `${destination}/${subdir.path}`;
            await this.cp(sourcePath, destPath);
          })
        );
      }

      // Process files in batches of 10
      const files = data.files || [];
      for (let i = 0; i < files.length; i += 10) {
        const batch = files.slice(i, i + 10);
        await Promise.all(
          batch.map(async (file) => {
            const sourcePath = file.path || `${source}/${file.path}`;
            const destPath = `${destination}/${file.path}`;
            const fileContent = await this.read(sourcePath);
            if (typeof fileContent === 'string') {
              await this.write(destPath, fileContent);
            }
          })
        );
      }
      return {
        message: "Directory copied successfully",
        source,
        destination,
      }
    } else if ('content' in data) {
      await this.write(destination, data.content as string);
      return {
        message: "File copied successfully",
        source,
        destination,
      }
    }
    throw new Error("Unsupported file type");
  }

  private formatPath(path: string): string {
    if (path.startsWith("/")) {
      path = path.slice(1);
    }
    return path;
  }
}