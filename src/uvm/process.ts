import { UVM } from "../client";
import { HttpError } from "../common/errors";
import { UVMAction } from "./action";
import { ProcessRequest, postProcess } from "./client";

export class UVMProcess extends UVMAction {
  constructor(uvm: UVM) {
    super(uvm);
  }

  async exec(process: ProcessRequest) {
    const { response, data } = await postProcess({
      body: process,
      baseUrl: this.url.toString(),
    });
    if (!response.ok) {
      throw new HttpError(response, data);
    }
    return data;
  }
}

