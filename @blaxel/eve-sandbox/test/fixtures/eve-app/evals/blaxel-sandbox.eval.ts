import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "All five eve sandbox tools run through the Blaxel backend.",
  async test(t) {
    await t.send("Run the Blaxel sandbox acceptance sequence.");

    t.succeeded();
    t.calledTool("write_file");
    t.calledTool("read_file");
    t.calledTool("glob");
    t.calledTool("grep");
    t.calledTool("bash");
    t.check(t.reply, equals("eve-blaxel-acceptance-ok"));
  },
});
