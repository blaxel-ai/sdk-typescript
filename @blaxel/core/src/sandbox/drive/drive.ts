import { Sandbox } from "../../client/types.gen.js";
import { SandboxAction } from "../action.js";
import {
  postDrivesMount,
  deleteDrivesMountByMountPath,
  getDrivesMount,
  type DriveMountRequest,
  type DriveMountResponse,
  type DriveMountInfo,
  type DriveListResponse,
  type DriveUnmountResponse,
  type PostDrivesMountResponse,
  type DeleteDrivesMountByMountPathResponse,
  type GetDrivesMountResponse,
} from "../client/index.js";

export type { DriveMountRequest, DriveMountResponse, DriveMountInfo, DriveListResponse, DriveUnmountResponse };

export class SandboxDrive extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  /**
   * Mount a drive to the sandbox at a specific mount path
   */
  async mount(request: DriveMountRequest): Promise<DriveMountResponse> {
    const { response, data, error } = await postDrivesMount({
      baseUrl: this.url,
      client: this.client,
      body: request,
    });
    this.handleResponseError(response, data, error);
    return data as PostDrivesMountResponse;
  }

  /**
   * Unmount a drive from the sandbox by mount path
   */
  async unmount(mountPath: string): Promise<DriveUnmountResponse> {
    // Strip leading slash for the path parameter since the URL template
    // already includes the slash: /drives/mount/{mountPath}
    const paramPath = mountPath.startsWith("/") ? mountPath.substring(1) : mountPath;

    const { response, data, error } = await deleteDrivesMountByMountPath({
      baseUrl: this.url,
      client: this.client,
      path: { mountPath: paramPath },
    });
    this.handleResponseError(response, data, error);
    return data as DeleteDrivesMountByMountPathResponse;
  }

  /**
   * List all mounted drives in the sandbox
   */
  async list(): Promise<DriveMountInfo[]> {
    const { response, data, error } = await getDrivesMount({
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    const result = data as GetDrivesMountResponse;
    return result.mounts ?? [];
  }
}
