import toml from "smol-toml";
import { dotenv, fs } from "./node.js";

const hasOwn = (source: object, prop: string): boolean => Object.prototype.hasOwnProperty.call(source, prop);

const secretEnv = Object.create(null) as Record<string, string>;
const configEnv = Object.create(null) as Record<string, string>;

const stringifyTomlEnvValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
};

if (fs !== null ) {
  try {
    const configFile = fs.readFileSync("blaxel.toml", "utf8");
    type ConfigInfos = {
      env?: Record<string, unknown>;
    };
    const configInfos = toml.parse(configFile, { maxDepth: 100 }) as ConfigInfos;
    if (configInfos.env && typeof configInfos.env === "object") {
      for (const [key, value] of Object.entries(configInfos.env)) {
        configEnv[key] = stringifyTomlEnvValue(value);
      }
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
      if (hasOwn(secretEnv, prop)) {
        return secretEnv[prop];
      }
      if (hasOwn(configEnv, prop)) {
        return configEnv[prop];
      }
      if (typeof process !== "undefined" && process.env && hasOwn(process.env, prop)) {
        return process.env[prop];
      }
      return undefined;
    },
  }
);

export { env };
