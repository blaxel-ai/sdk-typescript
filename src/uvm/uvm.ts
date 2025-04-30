import { createUvm, deleteUvm, getUvm, listUvm, UVM as UVMModel } from "../client";
import { HttpError } from "../common/errors";
import { UVMFileSystem } from "./filesystem";
import { UVMNetwork } from "./network";
import { UVMProcess } from "./process";

export class UVM {
  fs: UVMFileSystem;
  network: UVMNetwork;
  process: UVMProcess;

  constructor(private uvm: UVMModel) {
    this.fs = new UVMFileSystem(uvm);
    this.network = new UVMNetwork(uvm);
    this.process = new UVMProcess(uvm);
  }

  static async create(uvm: UVMModel) {
    const { response, data } = await createUvm({
      body: uvm,
    });
    if (!response.ok) {
      throw new HttpError(response, data);
    }
    if (!data) {
      throw new Error("No data returned from createUvm");
    }
    return new UVM(data);
  }

  static async get(uvmName: string) {
    const { response, data } = await getUvm({
      path: {
        uvmName,
      },
    });
    if (!response.ok) {
      throw new HttpError(response, data);
    }
    if (!data) {
      throw new Error("No data returned from getUvm");
    }
    return new UVM(data);
  }

  static async list() {
    const { response, data } = await listUvm() as { response: Response; data: UVMModel[] };
    if (!response.ok) {
      throw new HttpError(response, data);
    }
    if (!data) {
      throw new Error("No data returned from listUvm");
    }
    return data.map((uvm) => new UVM(uvm));
  }

  static async delete(uvmName: string) {
    const { response, data } = await deleteUvm({
      path: {
        uvmName,
      },
    });
    if (!response.ok) {
      throw new HttpError(response, data);
    }
    if (!data) {
      throw new Error("No data returned from deleteUvm");
    }
    return data;
  }
}