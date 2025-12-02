import { env, logger, settings } from "@blaxel/core";
import Fastify from "fastify";

async function main() {
  console.log("Booting up...");
  console.log("Sentry DSN:", settings.sentryDsn);
  const app = Fastify();

  app.get("/", async (request, reply) => {
    try {
      console.log(settings.headers);
      return reply.status(200).send('Hello, world !');
    } catch (error: any) {
      console.error(error);
      return reply.status(500).send(error.stack);
    }
  });
  const port = parseInt(env.PORT || "1338");
  const host = env.HOST || "0.0.0.0";
  try {
    await app.listen({ port, host });
    console.log(`Server is running on port ${host}:${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

await main()
