/* eslint-disable */
import toml from "toml";
import { dotenv, fs } from "./node.js";

const secretEnv: Record<string, string> = {};
const configEnv: Record<string, string> = {};

if (fs !== null && dotenv !== null) {
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
  } catch (error) {}
  try {
    const secretFile = fs.readFileSync(".env", "utf8");
    const parsed = dotenv.parse(secretFile);
    Object.assign(secretEnv, parsed);
  } catch (error) {}
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
