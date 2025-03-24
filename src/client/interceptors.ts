import { onLoad } from "../common/autoload";
import settings from "../common/settings";

type Interceptor = (request: Request, options: any) => Promise<Request | Response>;

export const interceptors: Interceptor[] = [
  // Authentication interceptor
  async (request: Request, options: any) => {
    if (options.authenticated === false) {
      return request;
    }
    await onLoad()
    for(const header in settings.headers) {
      request.headers.set(header, settings.headers[header])
    }
    return request;
  },
]
