import assert from "node:assert/strict";
import type {
  RuntimeCall,
  RuntimeRunner,
} from "../../src/providers/claude-code";
import type { RecognitionInput } from "../../src/shared/recognition";
export function runtimeFixture() {
  const calls: RuntimeCall[] = [];
  const h = {
    loggedIn: false,
    search: true,
    failed: false,
    permissionDenied: false,
    scopeWrong: false,
  };
  const runner: RuntimeRunner = async (call) => {
    calls.push(call);
    if (call.args[0] === "auth") {
      if (call.args[1] === "login") {
        h.loggedIn = true;
        return { code: 0, output: "" };
      }
      if (call.args[1] === "logout") {
        h.loggedIn = false;
        return { code: 0, output: "" };
      }
      return {
        code: h.loggedIn ? 0 : 1,
        output: JSON.stringify({
          loggedIn: h.loggedIn,
          authMethod: h.loggedIn ? "claude.ai" : "none",
          email: "fixture@example.test",
        }),
      };
    }
    if (call.controlId) {
      const input = JSON.parse(call.input!);
      assert.equal(input.request.subtype, "initialize");
      assert(!call.input?.includes('"type":"user"'));
      return {
        code: 0,
        output:
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: call.controlId,
              response: {
                models: [
                  { value: "fixture-model", displayName: "Fixture Model" },
                ],
              },
            },
          }) + "\n",
      };
    }
    const input: RecognitionInput = JSON.parse(call.input!.split("\n")[1]);
    const work = h.scopeWrong
      ? { title: "Wrong", description: null, tags: null, cover: null }
      : null;
    return {
      code: h.failed ? 1 : 0,
      output:
        [
          ...(h.search
            ? [
                {
                  type: "assistant",
                  message: {
                    content: [
                      { type: "tool_use", name: "WebSearch", id: "tool-1" },
                    ],
                  },
                },
                {
                  type: "user",
                  message: {
                    content: [
                      {
                        type: "tool_result",
                        tool_use_id: "tool-1",
                        is_error: h.permissionDenied,
                        content:
                          'Links: [{"title":"Fixture","url":"https://example.test/film"}]',
                      },
                    ],
                  },
                },
              ]
            : []),
          {
            type: "result",
            subtype: h.failed ? "error_during_execution" : "success",
            is_error: h.failed,
            structured_output: {
              work,
              files: input.files.map((f) => ({
                id: f.id,
                number: String(f.order),
                title: "第一集",
                description: null,
              })),
            },
          },
        ]
          .map((v) => JSON.stringify(v))
          .join("\n") + "\n",
    };
  };
  return { h, calls, runner };
}
