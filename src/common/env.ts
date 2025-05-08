// import fs from "fs";
// import toml from "toml";

const secretEnv: Record<string, string> = {};
const configEnv: Record<string, string> = {};

// try {
//   const configFile = fs.readFileSync("blaxel.toml", "utf8");
//   type ConfigInfos = {
//     env: {
//       [key: string]: string;
//     };
//   };
//   const configInfos = toml.parse(configFile) as ConfigInfos;
//   for (const key in configInfos.env) {
//     configEnv[key] = configInfos.env[key];
//   }
//   /* eslint-disable */
// } catch (error) {}

// try {
//   const secretFile = fs.readFileSync(".env", "utf8");
//   secretFile.split("\n").forEach((line) => {
//     if (line.startsWith("#")) {
//       return;
//     }
//     const [key, value] = line.split("=");
//     secretEnv[key] = value;
//   });
// } catch (error) {}

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
      return process.env[prop];
    },
  }
);

export { env };
