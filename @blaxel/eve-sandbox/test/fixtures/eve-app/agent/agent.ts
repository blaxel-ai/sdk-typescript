import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  modelContextWindowTokens: 32_000,
  model: mockModel(({ toolResults }) => {
    switch (toolResults.length) {
      case 0:
        return {
          toolCalls: [
            {
              name: "write_file",
              input: {
                content: "alpha\nbeta\n",
                filePath: "/workspace/eve-acceptance.txt",
              },
            },
          ],
        };
      case 1:
        return {
          toolCalls: [
            {
              name: "read_file",
              input: { filePath: "/workspace/eve-acceptance.txt" },
            },
          ],
        };
      case 2:
        return {
          toolCalls: [
            {
              name: "glob",
              input: { pattern: "**/eve-acceptance.txt" },
            },
          ],
        };
      case 3:
        return {
          toolCalls: [
            {
              name: "grep",
              input: { literal: true, pattern: "beta" },
            },
          ],
        };
      case 4:
        return {
          toolCalls: [
            {
              name: "bash",
              input: { command: "printf 'eve-blaxel-agent-live-ok'" },
            },
          ],
        };
      default:
        return "eve-blaxel-acceptance-ok";
    }
  }),
});
