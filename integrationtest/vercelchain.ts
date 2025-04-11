import { generateObject } from "ai";
import { z } from "zod";
import { blModel } from "../src/index.js";
async function main() {
  const firstResponse = await generateObject({
    model: await blModel("gpt-4o-mini").ToVercelAI(),
    system:
      "You are a first point of contact for a loan company. Your job is to turn client conversation into loan application.",
    schema: z.object({
      name: z.string(),
      loan_amount: z.number(),
      loan_time_in_months: z.number(),
      monthly_income: z.number(),
    }),
    messages: [
      {
        role: "user",
        content: `
      Hi! My name is Kewin.
      I'd like to ask for a loan.
      I need 2000$.
      I can pay it back in a year.
      My salary is 300$ a month
      `,
      },
    ],
  });

  const gateResponse = await generateObject({
    model: await blModel("gpt-4o-mini").ToVercelAI(),
    system:
      "You are a loan specialist. Based on the given json file with client data, your job is to decide if a client can be further processed.",
    schema: z.object({
      is_client_accepted: z.boolean(),
      denial_reason: z
        .string()
        .optional()
        .describe("If client is rejected, you need to give a reason."),
    }),
    messages: [{ role: "user", content: JSON.stringify(firstResponse.object) }],
  });

  console.info(gateResponse.object);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
