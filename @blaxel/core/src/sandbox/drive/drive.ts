import { Sandbox } from "../../client/types.gen.js";
import { settings } from "../../common/settings.js";
import { SandboxAction } from "../action.js";

export interface DriveMountRequest {
  driveName: string;
  mountPath: string;
  drivePath?: string;
}

export interface DriveMountResponse {
  success: boolean;
  message: string;
  driveName: string;
  mountPath: string;
  drivePath: string;
}

export interface DriveMountInfo {
  driveName: string;
  mountPath: string;
  drivePath: string;
}

export interface DriveListResponse {
  mounts: DriveMountInfo[];
}

export interface DriveUnmountResponse {
  success: boolean;
  message: string;
  mountPath: string;
}

export class SandboxDrive extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  /**
   * Mount a drive to the sandbox at a specific mount path
   */
  async mount(request: DriveMountRequest): Promise<DriveMountResponse> {
    const headers = this.sandbox.forceUrl ? this.sandbox.headers : settings.headers;
    
    const body = {
      driveName: request.driveName,
      mountPath: request.mountPath,
      drivePath: request.drivePath || "/",
    };

    const response = await fetch(`${this.url}/drives/mount`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to mount drive: ${errorText}`);
    }

    return await response.json() as DriveMountResponse;
  }

  /**
   * Unmount a drive from the sandbox by mount path
   */
  async unmount(mountPath: string): Promise<DriveUnmountResponse> {
    const headers = this.sandbox.forceUrl ? this.sandbox.headers : settings.headers;
    
    // Ensure mountPath starts with /
    const normalizedPath = mountPath.startsWith('/') ? mountPath : `/${mountPath}`;
    
    // Remove leading slash for URL (DELETE /drives/mnt/test not /drives//mnt/test)
    const urlPath = normalizedPath.substring(1);

    const response = await fetch(`${this.url}/drives/${urlPath}`, {
      method: 'DELETE',
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to unmount drive: ${errorText}`);
    }

    return await response.json() as DriveUnmountResponse;
  }

  /**
   * List all mounted drives in the sandbox
   */
  async list(): Promise<DriveMountInfo[]> {
    const headers = this.sandbox.forceUrl ? this.sandbox.headers : settings.headers;

    const response = await fetch(`${this.url}/drives/mount`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to list drives: ${errorText}`);
    }

    const data = await response.json() as DriveListResponse;
    return data.mounts || [];
  }
}
