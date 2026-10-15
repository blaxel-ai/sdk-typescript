import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveInstance } from "../../@blaxel/core/src/drive/index.js";
import { VolumeInstance } from "../../@blaxel/core/src/volume/index.js";
import {
  createDrive,
  createVolume,
  getDrive,
  getDriveByExternalId,
  getVolume,
  getVolumeByExternalId,
  listDrives,
  listVolumes,
  updateDrive,
  updateVolume,
} from "../../@blaxel/core/src/client/index.js";

vi.mock("../../@blaxel/core/src/client/index.js", () => ({
  createDrive: vi.fn(),
  createVolume: vi.fn(),
  deleteDrive: vi.fn(),
  deleteVolume: vi.fn(),
  getDrive: vi.fn(),
  getDriveByExternalId: vi.fn(),
  getVolume: vi.fn(),
  getVolumeByExternalId: vi.fn(),
  listDrives: vi.fn(),
  listVolumes: vi.fn(),
  updateDrive: vi.fn(),
  updateVolume: vi.fn(),
}));

const createDriveMock = vi.mocked(createDrive);
const createVolumeMock = vi.mocked(createVolume);
const getDriveMock = vi.mocked(getDrive);
const getDriveByExternalIdMock = vi.mocked(getDriveByExternalId);
const getVolumeMock = vi.mocked(getVolume);
const getVolumeByExternalIdMock = vi.mocked(getVolumeByExternalId);
const listDrivesMock = vi.mocked(listDrives);
const listVolumesMock = vi.mocked(listVolumes);
const updateDriveMock = vi.mocked(updateDrive);
const updateVolumeMock = vi.mocked(updateVolume);

const drive = (name: string, externalId: string) => ({
  metadata: { name, externalId },
  spec: { region: "us-was-1", size: 10 },
});

const volume = (name: string, externalId: string) => ({
  metadata: { name, externalId },
  spec: { region: "us-was-1", size: 1024 },
});

describe("DriveInstance externalId", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends externalId when creating a drive", async () => {
    createDriveMock.mockResolvedValueOnce({
      data: drive("drive-ext", "drive-external-1"),
    } as never);

    const created = await DriveInstance.create({
      name: "drive-ext",
      externalId: "drive-external-1",
      region: "us-was-1",
      size: 10,
    });

    expect(created.metadata.externalId).toBe("drive-external-1");
    const createOptions = createDriveMock.mock.calls[0]?.[0];
    expect(createOptions?.body.metadata?.externalId).toBe("drive-external-1");
    expect(createOptions?.throwOnError).toBe(true);
  });

  it("gets a drive by externalId", async () => {
    getDriveByExternalIdMock.mockResolvedValueOnce({
      data: drive("drive-ext", "drive-external-2"),
    } as never);

    const found = await DriveInstance.getByExternalId("drive-external-2");

    expect(found.name).toBe("drive-ext");
    expect(found.metadata.externalId).toBe("drive-external-2");
    expect(getDriveByExternalIdMock).toHaveBeenCalledWith({
      path: { externalId: "drive-external-2" },
      throwOnError: true,
    });
  });

  it("passes externalId through drive list queries", async () => {
    listDrivesMock.mockResolvedValueOnce({
      data: {
        data: [drive("drive-ext", "drive-external-3")],
        meta: { hasMore: false, total: 1 },
      },
    } as never);

    const page = await DriveInstance.list({ externalId: "drive-external-3" });

    expect(page.data).toHaveLength(1);
    expect(page.data[0].metadata.externalId).toBe("drive-external-3");
    const listOptions = listDrivesMock.mock.calls[0]?.[0];
    expect(listOptions?.query).toEqual({ externalId: "drive-external-3" });
    expect(listOptions?.throwOnError).toBe(true);
  });

  it("sends externalId when updating a drive", async () => {
    getDriveMock.mockResolvedValueOnce({
      data: drive("drive-ext", "drive-external-old"),
    } as never);
    updateDriveMock.mockResolvedValueOnce({
      data: drive("drive-ext", "drive-external-new"),
    } as never);

    const updated = await DriveInstance.update("drive-ext", {
      externalId: "drive-external-new",
    });

    expect(updated.metadata.externalId).toBe("drive-external-new");
    const updateOptions = updateDriveMock.mock.calls[0]?.[0];
    expect(updateOptions?.path).toEqual({ driveName: "drive-ext" });
    expect(updateOptions?.body.metadata?.externalId).toBe("drive-external-new");
    expect(updateOptions?.throwOnError).toBe(true);
  });
});

describe("VolumeInstance externalId", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends externalId when creating a volume", async () => {
    createVolumeMock.mockResolvedValueOnce({
      data: volume("volume-ext", "volume-external-1"),
    } as never);

    const created = await VolumeInstance.create({
      name: "volume-ext",
      externalId: "volume-external-1",
      region: "us-was-1",
      size: 1024,
    });

    expect(created.metadata.externalId).toBe("volume-external-1");
    const createOptions = createVolumeMock.mock.calls[0]?.[0];
    expect(createOptions?.body.metadata?.externalId).toBe("volume-external-1");
    expect(createOptions?.throwOnError).toBe(true);
  });

  it("gets a volume by externalId", async () => {
    getVolumeByExternalIdMock.mockResolvedValueOnce({
      data: volume("volume-ext", "volume-external-2"),
    } as never);

    const found = await VolumeInstance.getByExternalId("volume-external-2");

    expect(found.name).toBe("volume-ext");
    expect(found.metadata.externalId).toBe("volume-external-2");
    expect(getVolumeByExternalIdMock).toHaveBeenCalledWith({
      path: { externalId: "volume-external-2" },
      throwOnError: true,
    });
  });

  it("passes externalId through volume list queries", async () => {
    listVolumesMock.mockResolvedValueOnce({
      data: {
        data: [volume("volume-ext", "volume-external-3")],
        meta: { hasMore: false, total: 1 },
      },
    } as never);

    const page = await VolumeInstance.list({ externalId: "volume-external-3" });

    expect(page.data).toHaveLength(1);
    expect(page.data[0].metadata.externalId).toBe("volume-external-3");
    const listOptions = listVolumesMock.mock.calls[0]?.[0];
    expect(listOptions?.query).toEqual({ externalId: "volume-external-3" });
    expect(listOptions?.throwOnError).toBe(true);
  });

  it("sends externalId when updating a volume", async () => {
    getVolumeMock.mockResolvedValueOnce({
      data: volume("volume-ext", "volume-external-old"),
    } as never);
    updateVolumeMock.mockResolvedValueOnce({
      data: volume("volume-ext", "volume-external-new"),
    } as never);

    const updated = await VolumeInstance.update("volume-ext", {
      externalId: "volume-external-new",
    });

    expect(updated.metadata.externalId).toBe("volume-external-new");
    const updateOptions = updateVolumeMock.mock.calls[0]?.[0];
    expect(updateOptions?.path).toEqual({ volumeName: "volume-ext" });
    expect(updateOptions?.body.metadata?.externalId).toBe("volume-external-new");
    expect(updateOptions?.throwOnError).toBe(true);
  });
});
