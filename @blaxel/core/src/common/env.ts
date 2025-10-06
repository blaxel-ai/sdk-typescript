/* eslint-disable */
import toml from "toml";

// Avoid importing Node built-ins in environments that don't support them (e.g., Next.js client build)
const isNode = typeof process !== "undefined" && (process as any).versions != null && (process as any).versions.node != null;
const isBrowser = typeof globalThis !== "undefined" && (globalThis as any)?.window !== undefined;

let fs: any = null;
let dotenv: any = null;

if (isNode && !isBrowser) {
  try {
    // Use eval to avoid bundler static analysis of 'require(\"fs\")'
    fs = (eval("require") as any)("fs");
  } catch {}
  try {
    dotenv = (eval("require") as any)("dotenv");
  } catch {}
}

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
  } catch (error) {}

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
