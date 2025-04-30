import { createUvm, deleteUvm, getUvm, listUvm, UVM as UVMModel } from "../client";
import { UVMFileSystem } from "./filesystem";
import { UVMNetwork } from "./network";
import { UVMProcess } from "./process";

export class UVMInstance {
  fs: UVMFileSystem;
  network: UVMNetwork;
  process: UVMProcess;

  constructor(private uvm: UVMModel) {
    this.fs = new UVMFileSystem(uvm);
    this.network = new UVMNetwork(uvm);
    this.process = new UVMProcess(uvm);
  }

  static async create(uvm: UVMModel) {
    const { data } = await createUvm({
      body: uvm,
      throwOnError: true,
    });
    return new UVMInstance(data);
  }

  static async get(uvmName: string) {
    const { data } = await getUvm({
      path: {
        uvmName,
      },
      throwOnError: true,
    });
    return new UVMInstance(data);
  }

  static async list() {
    const { data } = await listUvm({throwOnError: true}) as { response: Response; data: UVMModel[] };
    return data.map((uvm) => new UVMInstance(uvm));
  }

  static async delete(uvmName: string) {
    const { data } = await deleteUvm({
      path: {
        uvmName,
      },
      throwOnError: true,
    });
    return data;
  }
}