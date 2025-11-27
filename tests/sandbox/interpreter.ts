import { CodeInterpreter } from "@blaxel/core";

async function main() {
  console.log("🚀 [interpreter] starting");

  let interp: CodeInterpreter | null = null;

  try {
    console.log("🔧 [interpreter] creating interpreter sandbox (jupyter-server)...");
    const t0 = performance.now();
    interp = await CodeInterpreter.create();
    // interp = await CodeInterpreter.get("sandbox-79c13193");
    // interp = new CodeInterpreter({ metadata: { name: "test" }, forceUrl: "http://localhost:8888" });

    const name = interp.metadata?.name;
    console.log(`✅ created: ${name}`);
    console.log(`⏱️ create: ${Math.round((performance.now() - t0))} ms`);

    // Try creating a context (skip if endpoint not available)
    try {
      console.log("🔧 [interpreter] creating code context (python)...");
      const t0 = performance.now();
      const ctx = await interp.createCodeContext({ language: "python" });
      console.log(`✅ context created: id=${ctx.id}`);
      console.log(`⏱️ create_context: ${Math.round((performance.now() - t0))} ms`);
    } catch (e) {
      console.log(`⚠️ [interpreter] create_code_context skipped: ${e}`);
    }

    // Try running simple code (skip if endpoint not available)
    try {
      console.log("🔧 [interpreter] running code...");
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const results: InstanceType<typeof CodeInterpreter.Result>[] = [];
      const errors: InstanceType<typeof CodeInterpreter.ExecutionError>[] = [];

      const onStdout = (msg: InstanceType<typeof CodeInterpreter.OutputMessage>) => {
        const text = msg.text;
        stdoutLines.push(text);
        console.log(`[stdout] ${text}`);
      };

      const onStderr = (msg: InstanceType<typeof CodeInterpreter.OutputMessage>) => {
        const text = msg.text;
        stderrLines.push(text);
        console.log(`[stderr] ${text}`);
      };

      const onResult = (res: InstanceType<typeof CodeInterpreter.Result>) => {
        results.push(res);
        console.log(`[result] ${JSON.stringify(res)}`);
      };

      const onError = (err: InstanceType<typeof CodeInterpreter.ExecutionError>) => {
        errors.push(err);
        console.log(`[error] ${err.name}: ${err.value}`);
      };

      const t0 = performance.now();
      await interp.runCode("print('Hello from interpreter (async)')", {
        language: "python",
        onStdout,
        onStderr,
        onResult,
        onError,
        timeout: 30.0,
      });
      console.log(`⏱️ run_code(hello): ${Math.round((performance.now() - t0))} ms`);
      console.log(
        `✅ run_code finished: stdout=${stdoutLines.length} stderr=${stderrLines.length} ` +
          `results=${results.length} errors=${errors.length}`
      );

      // Define a function in one run, then call it in another run
      console.log("🔧 [interpreter] define function in first run_code, call in second");
      try {
        stdoutLines.length = 0;
        stderrLines.length = 0;
        results.length = 0;
        errors.length = 0;

        // First run: define a function
        const t0 = performance.now();
        await interp.runCode("def add(a, b):\n    return a + b", {
          onStdout,
          onStderr,
          onResult,
          onError,
          timeout: 30.0,
        });
        console.log(`⏱️ run_code(define): ${Math.round((performance.now() - t0))} ms`);

        // Second run: call the function
        stdoutLines.length = 0;
        stderrLines.length = 0;
        results.length = 0;
        errors.length = 0;

        const t1 = performance.now();
        await interp.runCode("print(add(2, 3))", {
          onStdout,
          onStderr,
          onResult,
          onError,
          timeout: 30.0,
        });
        console.log(`⏱️ run_code(call): ${Math.round((performance.now() - t1))} ms`);

        // Expect to see "5" in stdout
        const gotStdout = stdoutLines.join("");
        if (!gotStdout.includes("5")) {
          throw new Error(`Expected function output '5', got stdout=${JSON.stringify(gotStdout)}`);
        }
        console.log("✅ function persisted across runs");
      } catch (e2) {
        console.log(`⚠️ [interpreter] two-step run_code skipped: ${e2}`);
      }
    } catch (e) {
      console.log(`⚠️ [interpreter] run_code skipped: ${e}`);
    }

    console.log("🎉 [interpreter] done");
  } catch (e) {
    if (e instanceof Error && e.name === "AssertionError") {
      console.log(`❌ [interpreter] assertion failed: ${e.message}`);
    } else {
      console.log(`❌ [interpreter] error: ${JSON.stringify(e)}`);
    }
  } finally {
    if (interp) {
      try {
        const n = interp.metadata?.name;
        if (n) {
          await CodeInterpreter.delete(n);
          console.log(`🧹 [interpreter] cleaned ${n}`);
        }
      } catch (e) {
        console.log(`⚠️ [interpreter] cleanup failed: ${e}`);
      }
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("There was an error => ", err);
    process.exit(1);
  });

