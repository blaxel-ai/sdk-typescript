import toml from "toml";
import { dotenv, fs } from "./node.js";

const secretEnv: Record<string, string> = {};
const configEnv: Record<string, string> = {};

if (fs !== null ) {
  try {
    const configFile = fs.readFileSync("blaxel.toml", "utf8");
      type ConfigInfos = {
        env: {
        [key: string]: string;
      };
    };
    const configInfos = toml.parse(configFile) as ConfigInfos;
    for (const key in configInfos.env) {
      configEnv[key] = configInfos.env[key];
    }
  } catch {
    // ignore
  }

  try {
    const secretFile = fs.readFileSync(".env", "utf8");
    if (dotenv) {
      const parsed = dotenv.parse(secretFile);
      Object.assign(secretEnv, parsed);
    } else {
      // Simple .env parsing fallback when dotenv is not available
      const lines = secretFile.split('\n');
      for (const line of lines) {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
          secretEnv[match[1].trim()] = match[2].trim();
        }
      }
    }
  } catch {
    // ignore
  }
}


type EnvVariables = {
  [key: string]: string | undefined;
};

const env = new Proxy<EnvVariables>(
  {},
  {
    get: (target, prop: string) => {
      if (secretEnv[prop]) {
        return secretEnv[prop];
      }
      if (configEnv[prop]) {
        return configEnv[prop];
      }
      if (typeof process !== "undefined" && process.env) {
        return process.env[prop];
      }
      return undefined;
    },
  }
);

export { env };
