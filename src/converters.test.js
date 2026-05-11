"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  anthropicBodyToOpenAIChat,
  openaiChatResponseToAnthropic,
  createOpenAIToAnthropicSSETranslator,
  openaiBodyToAnthropic,
  anthropicResponseToOpenAIChat,
  createAnthropicToOpenAISSETranslator,
  usageToAnthropicShape,
  anthropicUsageToOpenAIShape,
  parseAnthropicSSEUsage,
  sanitizeAnthropicBody,
} = require("./converters");

describe("anthropicBodyToOpenAIChat", () => {
  it("passes through basic messages", () => {
    const body = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" }
      ]
    };
    const result = anthropicBodyToOpenAIChat(body);
    assert.strictEqual(result.model, "claude-sonnet-4-20250514");
    assert.strictEqual(result.stream, false);
    assert.strictEqual(result.messages.length, 2);
    assert.deepStrictEqual(result.messages[0], { role: "user", content: "Hello" });
  });

  it("converts string system to system message", () => {
    const body = {
      model: "claude",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      system: "You are helpful."
    };
    const result = anthropicBodyToOpenAIChat(body);
    assert.strictEqual(result.messages[0].role, "system");
    assert.strictEqual(result.messages[0].content, "You are helpful.");
  });

  it("converts array system", () => {
    const body = {
      model: "claude",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      system: [{ type: "text", text: "Be nice." }, { type: "text", text: "Be brief." }]
    };
    const result = anthropicBodyToOpenAIChat(body);
    assert.strictEqual(result.messages[0].role, "system");
  });

  it("handles empty content array", () => {
    const body = {
      model: "claude",
      max_tokens: 100,
      messages: [{ role: "user", content: [] }]
    };
    const result = anthropicBodyToOpenAIChat(body);
    assert.strictEqual(result.messages.length, 0);
  });

  it("converts stop_sequences to stop", () => {
    const body = {
      model: "claude",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      stop_sequences: ["END", "STOP"]
    };
    const result = anthropicBodyToOpenAIChat(body);
    assert.deepStrictEqual(result.stop, ["END", "STOP"]);
  });

  it("converts Anthropic tools to OpenAI tools", () => {
    const body = {
      model: "claude",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      tools: [{
        name: "get_weather",
        description: "Get weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } }
      }]
    };
    const result = anthropicBodyToOpenAIChat(body);
    assert.strictEqual(result.tools[0].type, "function");
    assert.strictEqual(result.tools[0].function.name, "get_weather");
  });

  it("converts tool_choice auto/any/none", () => {
    const resultAuto = anthropicBodyToOpenAIChat({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "auto" }
    });
    assert.strictEqual(resultAuto.tool_choice, "auto");

    const resultRequired = anthropicBodyToOpenAIChat({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "any" }
    });
    assert.strictEqual(resultRequired.tool_choice, "required");

    const resultNone = anthropicBodyToOpenAIChat({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "none" }
    });
    assert.strictEqual(resultNone.tool_choice, "none");
  });

  it("downgrades tool_choice {type:'tool'} without name to 'required'", () => {
    // Anthropic spec requires `name` when `type:'tool'`, but malformed clients
    // sometimes drop it. Old behavior silently fell through to no tool_choice
    // (auto), losing the caller's "must use a tool" intent. We now preserve
    // that intent by mapping to `required`.
    const result = anthropicBodyToOpenAIChat({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "tool" }
    });
    assert.strictEqual(result.tool_choice, "required");

    const resultEmpty = anthropicBodyToOpenAIChat({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "tool", name: "" }
    });
    assert.strictEqual(resultEmpty.tool_choice, "required");
  });

  it("injects chat_template_kwargs by default when thinking is enabled", () => {
    const result = anthropicBodyToOpenAIChat({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
    assert.deepStrictEqual(result.chat_template_kwargs, {
      enable_thinking: true,
      thinking_budget: 4096,
    });
    assert.strictEqual(result.reasoning_effort, undefined);
  });

  it("honors backend.thinking_format=reasoning_effort with budget bucketing", () => {
    const backend = { type: "openai", thinking_format: "reasoning_effort" };
    const result = anthropicBodyToOpenAIChat({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
      thinking: { type: "enabled", budget_tokens: 20000 },
    }, backend);
    assert.strictEqual(result.reasoning_effort, "high");
    assert.strictEqual(result.chat_template_kwargs, undefined);
  });

  it("does not add thinking params when thinking is absent", () => {
    const result = anthropicBodyToOpenAIChat({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
    });
    assert.strictEqual(result.chat_template_kwargs, undefined);
    assert.strictEqual(result.reasoning_effort, undefined);
  });
});

describe("openaiChatResponseToAnthropic", () => {
  it("converts a simple text response", () => {
    const res = {
      id: "chatcmpl-123",
      model: "gpt-4",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    };
    const result = openaiChatResponseToAnthropic(res);
    assert.strictEqual(result.id, "chatcmpl-123");
    assert.strictEqual(result.type, "message");
    assert.strictEqual(result.stop_reason, "end_turn");
    assert.strictEqual(result.content[0].text, "Hello!");
    assert.strictEqual(result.usage.input_tokens, 10);
    assert.strictEqual(result.usage.output_tokens, 5);
  });

  it("converts tool calls", () => {
    const res = {
      id: "chatcmpl-456",
      model: "gpt-4",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_abc",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' }
          }]
        },
        finish_reason: "tool_calls"
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    };
    const result = openaiChatResponseToAnthropic(res);
    assert.strictEqual(result.stop_reason, "tool_use");
    assert.strictEqual(result.content[0].type, "tool_use");
    assert.strictEqual(result.content[0].name, "get_weather");
    assert.deepStrictEqual(result.content[0].input, { city: "Paris" });
  });

  it("handles missing usage gracefully", () => {
    const res = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
    const result = openaiChatResponseToAnthropic(res);
    assert.strictEqual(result.usage.input_tokens, 0);
    assert.strictEqual(result.usage.output_tokens, 0);
  });

  it("maps finish_reason=length to max_tokens", () => {
    const res = { choices: [{ message: { content: "x" }, finish_reason: "length" }] };
    const result = openaiChatResponseToAnthropic(res);
    assert.strictEqual(result.stop_reason, "max_tokens");
  });

  it("maps reasoning_content to a thinking block before the text block", () => {
    const res = {
      choices: [{
        message: {
          role: "assistant",
          content: "42",
          reasoning_content: "Let me compute 13+29: 13+29=42",
        },
        finish_reason: "stop",
      }],
    };
    const result = openaiChatResponseToAnthropic(res);
    assert.strictEqual(result.content[0].type, "thinking");
    assert.strictEqual(result.content[0].thinking, "Let me compute 13+29: 13+29=42");
    assert.strictEqual(result.content[1].type, "text");
    assert.strictEqual(result.content[1].text, "42");
  });

  it("omits thinking block when reasoning_content is null or empty", () => {
    for (const rc of [null, "", undefined]) {
      const res = {
        choices: [{ message: { content: "hi", reasoning_content: rc }, finish_reason: "stop" }],
      };
      const result = openaiChatResponseToAnthropic(res);
      assert.ok(result.content.every(b => b.type !== "thinking"), `rc=${JSON.stringify(rc)}`);
    }
  });
});

describe("createOpenAIToAnthropicSSETranslator", () => {
  it("emits message_start on first chunk", () => {
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "gpt-4");
    const out = t.translate({
      choices: [{ delta: { content: "H" }, finish_reason: null }],
      usage: null
    });
    assert.ok(out.includes("message_start"));
    assert.ok(out.includes("content_block_start"));
    assert.ok(out.includes('"type":"text"'));
  });

  it("streams text deltas", () => {
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "gpt-4");
    t.translate({ choices: [{ delta: { content: "He" }, finish_reason: null }] });
    const out = t.translate({ choices: [{ delta: { content: "llo" }, finish_reason: null }] });
    assert.ok(out.includes('"text_delta"'));
    assert.ok(out.includes("llo"));
  });

  it("closes blocks and emits message_stop on finish", () => {
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "gpt-4");
    const out = t.translate({
      choices: [{ delta: { content: "Done" }, finish_reason: "stop" }],
      usage: { completion_tokens: 4 }
    });
    assert.ok(out.includes("content_block_stop"));
    assert.ok(out.includes("message_stop"));
    assert.ok(out.includes("message_delta"));
  });

  it("translates streaming tool calls", () => {
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "gpt-4");
    const out = t.translate({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: "call_x", function: { name: "search", arguments: '{"q":"hi"}' } }]
        },
        finish_reason: null
      }]
    });
    assert.ok(out.includes("content_block_start"));
    assert.ok(out.includes("tool_use"));
    assert.ok(out.includes("input_json_delta"));
  });

  it("finalize emits full stop sequence", () => {
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "gpt-4");
    t.translate({ choices: [{ delta: { content: "x" }, finish_reason: null }] });
    const out = t.finalize();
    assert.ok(out.includes("content_block_stop"));
    assert.ok(out.includes("message_delta"));
    assert.ok(out.includes("message_stop"));
    assert.ok(out.includes('"stop_reason":"end_turn"'));
  });

  it("finalize is a no-op once translate has emitted the natural finish", () => {
    // Regression: handlers (handlers.js:217-241) call finalize() on the
    // upstream `[DONE]` line, which arrives AFTER the chunk that carried
    // finish_reason. Without a stopEmitted guard, finalize would emit a
    // second message_delta with hard-coded stop_reason:"end_turn", clobbering
    // the real stop_reason (e.g. "tool_use") from the natural finish — so an
    // Anthropic client mistakes a tool-call turn for a normal end.
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "gpt-4");
    const finishOut = t.translate({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "search", arguments: "{}" } }] },
        finish_reason: "tool_calls"
      }]
    });
    assert.ok(finishOut.includes('"stop_reason":"tool_use"'), "translate must emit tool_use stop_reason");

    // Subsequent finalize must NOT re-emit message_delta / message_stop.
    const tail = t.finalize();
    assert.strictEqual(tail, "", "finalize after natural finish must be a no-op");

    // Combined output should carry exactly one message_delta and one message_stop.
    const combined = finishOut + tail;
    const deltaCount = (combined.match(/"type":"message_delta"/g) || []).length;
    const stopCount = (combined.match(/"type":"message_stop"/g) || []).length;
    assert.strictEqual(deltaCount, 1, "exactly one message_delta in combined stream");
    assert.strictEqual(stopCount, 1, "exactly one message_stop in combined stream");
    // And the surviving stop_reason must be the real one, not "end_turn".
    assert.ok(!combined.includes('"stop_reason":"end_turn"'), "must not contain the fallback end_turn stop_reason");
  });

  it("getUsage returns accumulated usage", () => {
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "gpt-4");
    t.translate({
      choices: [{ delta: { content: "x" }, finish_reason: "stop" }],
      usage: { completion_tokens: 10, prompt_tokens: 5 }
    });
    assert.strictEqual(t.getUsage().completion_tokens, 10);
  });

  it("opens a thinking block for streaming reasoning_content and emits thinking_delta", () => {
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "deepseek-v4");
    const out = t.translate({ choices: [{ delta: { reasoning_content: "First step:" }, finish_reason: null }] });
    assert.ok(out.includes("message_start"));
    assert.ok(out.includes('"type":"thinking"'));
    assert.ok(out.includes('"thinking_delta"'));
    assert.ok(out.includes("First step:"));
  });

  it("closes thinking block before opening text block when content starts", () => {
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "deepseek-v4");
    t.translate({ choices: [{ delta: { reasoning_content: "thinking..." }, finish_reason: null }] });
    const out = t.translate({ choices: [{ delta: { content: "answer" }, finish_reason: null }] });
    const thinkingStopIdx = out.indexOf("content_block_stop");
    const textStartIdx = out.indexOf('"type":"text"');
    assert.ok(thinkingStopIdx !== -1, "thinking block must close");
    assert.ok(textStartIdx !== -1, "text block must open");
    assert.ok(thinkingStopIdx < textStartIdx, "thinking must close before text opens");
  });

  it("uses distinct indices for thinking and text content blocks", () => {
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "deepseek-v4");
    t.translate({ choices: [{ delta: { reasoning_content: "R" }, finish_reason: null }] });
    t.translate({ choices: [{ delta: { content: "T" }, finish_reason: null }] });
    const final = t.finalize();
    // Final should close at least one block
    assert.ok(final.includes("content_block_stop"));
    assert.ok(final.includes("message_stop"));
  });

  it("closes thinking block on finish even without text", () => {
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "deepseek-v4");
    t.translate({ choices: [{ delta: { reasoning_content: "only thinking" }, finish_reason: null }] });
    const out = t.translate({ choices: [{ delta: {}, finish_reason: "stop" }] });
    assert.ok(out.includes("content_block_stop"));
    assert.ok(out.includes("message_stop"));
  });
});

describe("openaiBodyToAnthropic", () => {
  it("converts basic messages", () => {
    const body = {
      model: "gpt-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hi" }]
    };
    const result = openaiBodyToAnthropic(body);
    assert.strictEqual(result.model, "gpt-4");
    assert.strictEqual(result.messages[0].role, "user");
    assert.strictEqual(result.messages[0].content, "Hi");
  });

  it("converts system message to top-level system", () => {
    const body = {
      model: "gpt-4",
      max_tokens: 100,
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hi" }
      ]
    };
    const result = openaiBodyToAnthropic(body);
    assert.strictEqual(result.system, "Be helpful");
    assert.strictEqual(result.messages.length, 1);
  });

  it("converts tool calls in assistant message", () => {
    const body = {
      model: "gpt-4",
      max_tokens: 100,
      messages: [{
        role: "assistant",
        content: "Let me check",
        tool_calls: [{
          id: "call_1",
          function: { name: "weather", arguments: '{"city":"NYC"}' }
        }]
      }]
    };
    const result = openaiBodyToAnthropic(body);
    assert.strictEqual(result.messages[0].role, "assistant");
    assert.strictEqual(result.messages[0].content[0].type, "text");
    assert.strictEqual(result.messages[0].content[1].type, "tool_use");
  });

  it("converts tool result messages", () => {
    const body = {
      model: "gpt-4",
      max_tokens: 100,
      messages: [
        { role: "assistant", content: null, tool_calls: [
          { id: "call_1", type: "function", function: { name: "weather", arguments: "{}" } }
        ]},
        { role: "tool", tool_call_id: "call_1", content: "It's sunny" }
      ]
    };
    const result = openaiBodyToAnthropic(body);
    const userMsg = result.messages.find(m => m.role === "user");
    assert.ok(userMsg, "expected a user message carrying tool_result");
    assert.strictEqual(userMsg.content[0].type, "tool_result");
    assert.strictEqual(userMsg.content[0].tool_use_id, "call_1");
  });

  it("orphan tool_result (no preceding assistant tool_use) becomes text", () => {
    const body = {
      model: "gpt-4",
      max_tokens: 100,
      messages: [{
        role: "tool",
        tool_call_id: "call_1",
        content: "stale output"
      }]
    };
    const result = openaiBodyToAnthropic(body);
    const userMsg = result.messages.find(m => m.role === "user");
    assert.ok(userMsg);
    assert.strictEqual(userMsg.content[0].type, "text");
    assert.match(userMsg.content[0].text, /stale tool result call_1.*stale output/);
  });

  it("converts image_url to image content block", () => {
    const body = {
      model: "gpt-4",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [{
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBORw0KGgo" }
        }]
      }]
    };
    const result = openaiBodyToAnthropic(body);
    const img = result.messages[0].content[0];
    assert.strictEqual(img.type, "image");
    assert.strictEqual(img.source.type, "base64");
    assert.strictEqual(img.source.media_type, "image/png");
  });

  it("converts stop array to stop_sequences", () => {
    const body = {
      model: "gpt-4",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      stop: ["\n", "###"]
    };
    const result = openaiBodyToAnthropic(body);
    assert.deepStrictEqual(result.stop_sequences, ["\n", "###"]);
  });

  it("converts OpenAI tools to Anthropic format", () => {
    const body = {
      model: "gpt-4",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "search", description: "Search web" } }]
    };
    const result = openaiBodyToAnthropic(body);
    assert.strictEqual(result.tools[0].name, "search");
  });

  it("converts tool_choice", () => {
    const resultAuto = openaiBodyToAnthropic({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }], tool_choice: "auto"
    });
    assert.deepStrictEqual(resultAuto.tool_choice, { type: "auto" });
  });

  it("strips tools when tool_choice is 'none' (Anthropic rejects type:'none')", () => {
    const result = openaiBodyToAnthropic({
      model: "x",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }],
      tool_choice: "none",
    });
    assert.strictEqual(result.tool_choice, undefined);
    assert.strictEqual(result.tools, undefined);
  });

  it("converts object-form tool_choice {type:'function', function:{name}} → Anthropic {type:'tool', name}", () => {
    const result = openaiBodyToAnthropic({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "function", function: { name: "search" } }
    });
    assert.deepStrictEqual(result.tool_choice, { type: "tool", name: "search" });
  });

  it("downgrades object-form tool_choice without function.name to {type:'any'}", () => {
    // Old behavior emitted `{type:"tool", name:""}` which Anthropic rejects with 400.
    // Preserve "must use a tool" intent by mapping to `any`.
    const noFn = openaiBodyToAnthropic({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "function" }
    });
    assert.deepStrictEqual(noFn.tool_choice, { type: "any" });

    const emptyFn = openaiBodyToAnthropic({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "function", function: {} }
    });
    assert.deepStrictEqual(emptyFn.tool_choice, { type: "any" });

    const emptyName = openaiBodyToAnthropic({
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "function", function: { name: "" } }
    });
    assert.deepStrictEqual(emptyName.tool_choice, { type: "any" });
  });

  it("synthesizes a tool_result placeholder for unpaired trailing tool_use", () => {
    // Simulates Codex replaying a conversation where the final assistant turn
    // invoked a tool but the tool_result never arrived (cancelled / interrupted).
    // Without reconciliation Bedrock rejects the request with a 400 complaining
    // about `tool_use` ids without matching `tool_result` blocks.
    const body = {
      model: "claude",
      messages: [
        { role: "user", content: "run ls" },
        { role: "assistant", content: null, tool_calls: [
          { id: "toolu_abc", type: "function", function: { name: "shell", arguments: "{}" } },
        ]},
      ],
    };
    const result = openaiBodyToAnthropic(body);
    assert.strictEqual(result.messages.length, 3);
    assert.strictEqual(result.messages[2].role, "user");
    const tr = result.messages[2].content.find(b => b.type === "tool_result");
    assert.ok(tr, "expected a synthesized tool_result block");
    assert.strictEqual(tr.tool_use_id, "toolu_abc");
    assert.ok(typeof tr.content === "string" && tr.content.length > 0);
  });

  it("does not duplicate tool_result when the next user msg already has one", () => {
    const body = {
      model: "claude",
      messages: [
        { role: "user", content: "run ls" },
        { role: "assistant", content: null, tool_calls: [
          { id: "toolu_abc", type: "function", function: { name: "shell", arguments: "{}" } },
        ]},
        { role: "tool", tool_call_id: "toolu_abc", content: "a.txt" },
      ],
    };
    const result = openaiBodyToAnthropic(body);
    assert.strictEqual(result.messages.length, 3);
    const userMsg = result.messages[2];
    assert.strictEqual(userMsg.role, "user");
    const toolResults = userMsg.content.filter(b => b.type === "tool_result");
    assert.strictEqual(toolResults.length, 1);
    assert.strictEqual(toolResults[0].content, "a.txt");
  });

  it("fills only the missing tool_use id when a partial set of results is present", () => {
    const body = {
      model: "claude",
      messages: [
        { role: "user", content: "do two things" },
        { role: "assistant", content: null, tool_calls: [
          { id: "toolu_a", type: "function", function: { name: "x", arguments: "{}" } },
          { id: "toolu_b", type: "function", function: { name: "y", arguments: "{}" } },
        ]},
        // Only one of the two tool calls got a result
        { role: "tool", tool_call_id: "toolu_a", content: "done-a" },
      ],
    };
    const result = openaiBodyToAnthropic(body);
    const userMsg = result.messages[result.messages.length - 1];
    const ids = userMsg.content.filter(b => b.type === "tool_result").map(b => b.tool_use_id);
    assert.ok(ids.includes("toolu_a"));
    assert.ok(ids.includes("toolu_b"));
    assert.strictEqual(ids.length, 2);
  });
});

describe("anthropicResponseToOpenAIChat", () => {
  it("converts a simple message", () => {
    const res = {
      id: "msg_123",
      model: "claude",
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 }
    };
    const result = anthropicResponseToOpenAIChat(res);
    assert.strictEqual(result.object, "chat.completion");
    assert.strictEqual(result.choices[0].message.content, "Hello!");
    assert.strictEqual(result.choices[0].finish_reason, "stop");
    assert.strictEqual(result.usage.prompt_tokens, 10);
    assert.strictEqual(result.usage.completion_tokens, 5);
    assert.strictEqual(result.usage.total_tokens, 15);
  });

  it("converts tool_use blocks to tool_calls", () => {
    const res = {
      id: "msg_456",
      model: "claude",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "search", input: { q: "AI" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 10 }
    };
    const result = anthropicResponseToOpenAIChat(res);
    assert.strictEqual(result.choices[0].finish_reason, "tool_calls");
    assert.strictEqual(result.choices[0].message.tool_calls[0].function.name, "search");
  });

  it("maps max_tokens to length", () => {
    const res = {
      id: "msg_789", model: "claude", role: "assistant",
      content: [{ type: "text", text: "x" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 0, output_tokens: 0 }
    };
    const result = anthropicResponseToOpenAIChat(res);
    assert.strictEqual(result.choices[0].finish_reason, "length");
  });

  it("includes cache tokens in usage (OpenAI standard shape + extension)", () => {
    const res = {
      id: "msg_cache",
      model: "claude",
      role: "assistant",
      content: [{ type: "text", text: "cached" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 }
    };
    const result = anthropicResponseToOpenAIChat(res);
    // OpenAI prompt_tokens INCLUDES cached tokens
    assert.strictEqual(result.usage.prompt_tokens, 180);
    assert.strictEqual(result.usage.completion_tokens, 50);
    assert.strictEqual(result.usage.total_tokens, 230);
    // Cached reads surface as prompt_tokens_details.cached_tokens (standard OpenAI)
    assert.strictEqual(result.usage.prompt_tokens_details.cached_tokens, 80);
    // Cache writes kept as extension field (no standard OpenAI equivalent)
    assert.strictEqual(result.usage.cache_creation_input_tokens, 20);
  });

  it("thinking blocks surface as reasoning_content, NOT merged into content", () => {
    const res = {
      id: "msg_think",
      model: "claude",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me consider..." },
        { type: "text", text: "The answer is 42." },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 }
    };
    const result = anthropicResponseToOpenAIChat(res);
    assert.strictEqual(result.choices[0].message.content, "The answer is 42.");
    assert.strictEqual(result.choices[0].message.reasoning_content, "Let me consider...");
    assert.ok(!result.choices[0].message.content.includes("[Thinking]"));
  });
});

describe("createAnthropicToOpenAISSETranslator", () => {
  it("emits role chunk on message_start", () => {
    const t = createAnthropicToOpenAISSETranslator("chat_1", "claude");
    const out = t.translate(
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":12}}}'
    );
    assert.ok(out.includes('"delta":{"role":"assistant"'));
  });

  it("accumulates input_tokens and cache fields from message_start", () => {
    const t = createAnthropicToOpenAISSETranslator("chat_1", "claude");
    t.translate(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":40,"cache_creation_input_tokens":15}}}'
    );
    const acc = t.getAcc();
    assert.strictEqual(acc.input_tokens, 100);
    assert.strictEqual(acc.cache_read_tokens, 40);
    assert.strictEqual(acc.cache_write_tokens, 15);
  });

  it("emits tool call on content_block_start", () => {
    const t = createAnthropicToOpenAISSETranslator("chat_1", "claude");
    const out = t.translate(
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"search"}}'
    );
    assert.ok(out.includes("tool_calls"));
    assert.ok(out.includes("search"));
  });

  it("emits text delta", () => {
    const t = createAnthropicToOpenAISSETranslator("chat_1", "claude");
    const out = t.translate(
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}'
    );
    assert.ok(out.includes('"content":"Hello"'));
  });

  it("emits reasoning_content delta for thinking_delta (not swallowed)", () => {
    const t = createAnthropicToOpenAISSETranslator("chat_1", "claude");
    const out = t.translate(
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"considering..."}}'
    );
    assert.ok(out.includes('"reasoning_content":"considering..."'),
      `expected reasoning_content delta, got: ${out}`);
    // Should NOT be mis-mapped onto content
    assert.ok(!out.includes('"content":"considering..."'));
  });

  it("finalize(err) emits a terminal stop chunk and [DONE]", () => {
    const t = createAnthropicToOpenAISSETranslator("chat_1", "claude");
    t.translate('data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}');
    const out = t.finalize(new Error("boom"));
    assert.ok(out.includes('"finish_reason":"error"'));
    assert.ok(out.endsWith("data: [DONE]\n\n"));
  });

  it("emits finish_reason on message_delta with full OpenAI usage shape", () => {
    const t = createAnthropicToOpenAISSETranslator("chat_1", "claude");
    t.translate(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}'
    );
    const out = t.translate(
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}'
    );
    assert.ok(out.includes('"finish_reason":"stop"'));
    // prompt_tokens = input_tokens (50) + cache_read_tokens (20) = 70
    assert.ok(out.includes('"prompt_tokens":70'));
    assert.ok(out.includes('"completion_tokens":10'));
    assert.ok(out.includes('"total_tokens":80'));
    assert.ok(out.includes('"cached_tokens":20'));
    assert.ok(out.includes('"cache_creation_input_tokens":5'));
  });

  it("maps tool_use stop_reason to tool_calls", () => {
    const t = createAnthropicToOpenAISSETranslator("chat_1", "claude");
    t.translate('data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}');
    const out = t.translate(
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}'
    );
    assert.ok(out.includes('"finish_reason":"tool_calls"'));
  });

  it("maps max_tokens stop_reason to length", () => {
    const t = createAnthropicToOpenAISSETranslator("chat_1", "claude");
    t.translate('data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}');
    const out = t.translate(
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3}}'
    );
    assert.ok(out.includes('"finish_reason":"length"'));
  });

  it("emits [DONE] on message_stop", () => {
    const t = createAnthropicToOpenAISSETranslator("chat_1", "claude");
    const out = t.translate('data: {"type":"message_stop"}');
    assert.strictEqual(out, "data: [DONE]\n\n");
  });

  it("returns empty for non-data lines", () => {
    const t = createAnthropicToOpenAISSETranslator("c", "m");
    assert.strictEqual(t.translate("event: ping"), "");
  });

  it("returns empty for unhandled event types", () => {
    const t = createAnthropicToOpenAISSETranslator("c", "m");
    assert.strictEqual(t.translate('data: {"type":"ping"}'), "");
  });
});

describe("usageToAnthropicShape", () => {
  it("returns zeros for null/undefined", () => {
    const out = usageToAnthropicShape(null);
    assert.strictEqual(out.input_tokens, 0);
    assert.strictEqual(out.output_tokens, 0);
    assert.ok(!("cache_read_input_tokens" in out));
    assert.ok(!("cache_creation_input_tokens" in out));
  });

  it("passes Anthropic shape through", () => {
    const out = usageToAnthropicShape({
      input_tokens: 100, output_tokens: 50,
      cache_read_input_tokens: 40, cache_creation_input_tokens: 10,
    });
    assert.strictEqual(out.input_tokens, 100);
    assert.strictEqual(out.output_tokens, 50);
    assert.strictEqual(out.cache_read_input_tokens, 40);
    assert.strictEqual(out.cache_creation_input_tokens, 10);
  });

  it("splits OpenAI prompt_tokens: strips cached portion from input_tokens", () => {
    // OpenAI: prompt_tokens=500 INCLUDES cached_tokens=200
    // Anthropic: input_tokens=300 (non-cached), cache_read_input_tokens=200
    const out = usageToAnthropicShape({
      prompt_tokens: 500, completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 200 },
    });
    assert.strictEqual(out.input_tokens, 300);
    assert.strictEqual(out.output_tokens, 100);
    assert.strictEqual(out.cache_read_input_tokens, 200);
  });

  it("omits cache fields when zero", () => {
    const out = usageToAnthropicShape({ prompt_tokens: 10, completion_tokens: 5 });
    assert.strictEqual(out.input_tokens, 10);
    assert.strictEqual(out.output_tokens, 5);
    assert.ok(!("cache_read_input_tokens" in out));
    assert.ok(!("cache_creation_input_tokens" in out));
  });
});

describe("anthropicUsageToOpenAIShape", () => {
  it("basic conversion adds input + output to total", () => {
    const out = anthropicUsageToOpenAIShape({ input_tokens: 100, output_tokens: 50 });
    assert.strictEqual(out.prompt_tokens, 100);
    assert.strictEqual(out.completion_tokens, 50);
    assert.strictEqual(out.total_tokens, 150);
    assert.ok(!("prompt_tokens_details" in out));
  });

  it("prompt_tokens INCLUDES cache_read_input_tokens (OpenAI semantics)", () => {
    const out = anthropicUsageToOpenAIShape({
      input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80,
    });
    assert.strictEqual(out.prompt_tokens, 180);
    assert.strictEqual(out.total_tokens, 230);
    assert.strictEqual(out.prompt_tokens_details.cached_tokens, 80);
  });

  it("emits cache_creation_input_tokens as OpenAI extension field", () => {
    const out = anthropicUsageToOpenAIShape({
      input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20,
    });
    assert.strictEqual(out.cache_creation_input_tokens, 20);
  });

  it("handles missing fields gracefully", () => {
    const out = anthropicUsageToOpenAIShape({});
    assert.strictEqual(out.prompt_tokens, 0);
    assert.strictEqual(out.completion_tokens, 0);
    assert.strictEqual(out.total_tokens, 0);
  });
});

describe("parseAnthropicSSEUsage", () => {
  it("captures input_tokens and cache from message_start", () => {
    const acc = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    parseAnthropicSSEUsage(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":40,"cache_creation_input_tokens":15}}}',
      acc
    );
    assert.strictEqual(acc.input_tokens, 100);
    assert.strictEqual(acc.cache_read_tokens, 40);
    assert.strictEqual(acc.cache_write_tokens, 15);
    assert.strictEqual(acc.output_tokens, 0);
  });

  it("replaces output_tokens on message_delta (cumulative)", () => {
    const acc = { input_tokens: 100, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    parseAnthropicSSEUsage(
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}',
      acc
    );
    assert.strictEqual(acc.output_tokens, 25);
  });

  it("overwrites output_tokens on subsequent message_delta", () => {
    const acc = { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 };
    parseAnthropicSSEUsage(
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}',
      acc
    );
    assert.strictEqual(acc.output_tokens, 50);
  });

  it("does not mutate on non-SSE lines", () => {
    const acc = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    parseAnthropicSSEUsage("event: ping", acc);
    assert.deepStrictEqual(acc, { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
  });

  it("handles null/undefined acc safely", () => {
    assert.doesNotThrow(() => parseAnthropicSSEUsage('data: {"type":"message_start","message":{}}', null));
    assert.doesNotThrow(() => parseAnthropicSSEUsage('data: {"type":"message_start","message":{}}', undefined));
  });

  it("handles empty line", () => {
    const acc = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    parseAnthropicSSEUsage("", acc);
    assert.deepStrictEqual(acc, { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
  });
});
// ============================================================
// Protocol round-trip coverage — function_call + thinking parity
// ============================================================

describe("anthropicBodyToOpenAIChat - thinking block handling", () => {
  it("preserves historical thinking blocks as reasoning_content", () => {
    const body = {
      model: "m",
      max_tokens: 200,
      messages: [
        { role: "user", content: "think" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "deliberating..." },
          { type: "text", text: "final" }
        ]}
      ]
    };
    const out = anthropicBodyToOpenAIChat(body);
    const assistant = out.messages.find(m => m.role === "assistant");
    assert.strictEqual(assistant.reasoning_content, "deliberating...");
    assert.strictEqual(assistant.content, "final");
  });

  it("omits reasoning_content when no thinking block present", () => {
    const body = {
      model: "m", max_tokens: 10,
      messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }]
    };
    const out = anthropicBodyToOpenAIChat(body);
    const a = out.messages.find(m => m.role === "assistant");
    assert.strictEqual("reasoning_content" in a, false);
  });

  it("flattens tool_result text blocks to string", () => {
    const body = {
      model: "m", max_tokens: 10,
      messages: [{ role: "user", content: [
        { type: "tool_result", tool_use_id: "x", content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" }
        ]}
      ]}]
    };
    const out = anthropicBodyToOpenAIChat(body);
    const t = out.messages.find(m => m.role === "tool");
    assert.strictEqual(t.content, "ab");
  });

  it("preserves tool_result image blocks as structured array", () => {
    const body = {
      model: "m", max_tokens: 10,
      messages: [{ role: "user", content: [
        { type: "tool_result", tool_use_id: "x", content: [
          { type: "text", text: "see" },
          { type: "image", source: { type: "url", url: "https://e.co/i.png" } }
        ]}
      ]}]
    };
    const out = anthropicBodyToOpenAIChat(body);
    const t = out.messages.find(m => m.role === "tool");
    assert.ok(Array.isArray(t.content));
    assert.strictEqual(t.content[0].type, "text");
    assert.strictEqual(t.content[1].type, "image_url");
    assert.strictEqual(t.content[1].image_url.url, "https://e.co/i.png");
  });

  it("maps Anthropic disable_parallel_tool_use to Chat parallel_tool_calls:false", () => {
    const body = {
      model: "m", max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true }
    };
    const out = anthropicBodyToOpenAIChat(body);
    assert.strictEqual(out.parallel_tool_calls, false);
    assert.strictEqual(out.tool_choice, "auto");
  });
});

describe("openaiBodyToAnthropic - reasoning round-trip", () => {
  it("coalesces multiple tool messages into a single user turn", () => {
    const body = {
      model: "m",
      messages: [
        { role: "assistant", content: null, tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } }
        ]},
        { role: "tool", tool_call_id: "c1", content: "r1" },
        { role: "tool", tool_call_id: "c2", content: "r2" }
      ]
    };
    const out = openaiBodyToAnthropic(body);
    // expect: assistant (tool_use*2) + user (tool_result*2)
    assert.strictEqual(out.messages.length, 2);
    assert.strictEqual(out.messages[1].role, "user");
    assert.ok(Array.isArray(out.messages[1].content));
    assert.strictEqual(out.messages[1].content.length, 2);
    assert.strictEqual(out.messages[1].content[0].type, "tool_result");
    assert.strictEqual(out.messages[1].content[1].type, "tool_result");
  });

  it("flattens assistant array content + tool_calls without nested arrays", () => {
    const body = {
      model: "m",
      messages: [{ role: "assistant", content: [
        { type: "text", text: "hi " }, { type: "text", text: "there" }
      ], tool_calls: [
        { id: "c", type: "function", function: { name: "f", arguments: "{}" } }
      ]}]
    };
    const out = openaiBodyToAnthropic(body);
    const blocks = out.messages[0].content;
    // Every block must be a legal Anthropic block with a scalar payload.
    for (const b of blocks) {
      if (b.type === "text") assert.strictEqual(typeof b.text, "string");
      else if (b.type === "tool_use") assert.strictEqual(typeof b.id, "string");
      else assert.fail("unexpected block type " + b.type);
    }
  });

  it("assistant.reasoning_content → Anthropic thinking block", () => {
    const body = {
      model: "m",
      messages: [{ role: "assistant", content: "ans", reasoning_content: "mull" }]
    };
    const out = openaiBodyToAnthropic(body);
    const blocks = out.messages[0].content;
    assert.strictEqual(blocks[0].type, "thinking");
    assert.strictEqual(blocks[0].thinking, "mull");
  });

  it("Chat reasoning_effort → Anthropic thinking with matching budget", () => {
    const out = openaiBodyToAnthropic({
      // Provide a max_tokens generous enough that the synthesized budget
      // (effortToBudget("high")=16384) plus answer-room still fits, so the
      // guard does not clamp or drop it. This test specifically verifies the
      // effort → budget mapping, not the guard.
      model: "m", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high",
      max_tokens: 32000
    });
    assert.ok(out.thinking);
    assert.strictEqual(out.thinking.type, "enabled");
    assert.strictEqual(out.thinking.budget_tokens, 16384);
  });

  it("chat_template_kwargs.enable_thinking → Anthropic thinking", () => {
    const out = openaiBodyToAnthropic({
      model: "m", messages: [{ role: "user", content: "hi" }],
      // Generous max_tokens for the same reason as the reasoning_effort test.
      max_tokens: 32000,
      chat_template_kwargs: { enable_thinking: true, thinking_budget: 4096 }
    });
    assert.deepStrictEqual(out.thinking, { type: "enabled", budget_tokens: 4096 });
  });

  it("thinking budget guard: clamps budget below max_tokens when conflict", () => {
    // Synthesizes budget = 16384 (effort=high) > max_tokens = 8000 → guard
    // should reduce budget to max_tokens - 256 = 7744 so Anthropic accepts.
    const out = openaiBodyToAnthropic({
      model: "m", messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high", max_tokens: 8000
    });
    assert.ok(out.thinking);
    assert.strictEqual(out.thinking.type, "enabled");
    assert.ok(out.thinking.budget_tokens < out.max_tokens, "budget must be strictly less than max_tokens");
    assert.ok(out.thinking.budget_tokens >= 1024, "budget must remain >= 1024");
  });

  it("thinking budget guard: drops thinking when max_tokens too small for a valid budget", () => {
    // max_tokens = 800: even after clamping to max_tokens - 256 = 544 the
    // result is < 1024, so Anthropic will reject any thinking config.
    // The guard must drop the `thinking` block entirely.
    const out = openaiBodyToAnthropic({
      model: "m", messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high", max_tokens: 800
    });
    assert.strictEqual(out.thinking, undefined);
  });

  it("Chat parallel_tool_calls:false → Anthropic tool_choice.disable_parallel_tool_use", () => {
    const out = openaiBodyToAnthropic({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      tools: [{ type: "function", function: { name: "f", parameters: {} } }]
    });
    assert.strictEqual(out.tool_choice.type, "auto");
    assert.strictEqual(out.tool_choice.disable_parallel_tool_use, true);
  });

  it("does not fabricate thinking when not requested", () => {
    const out = openaiBodyToAnthropic({
      model: "m", messages: [{ role: "user", content: "hi" }]
    });
    assert.strictEqual(out.thinking, undefined);
  });
});

describe("stop_reason / finish_reason mapping", () => {
  it("Anthropic stop_sequence → Chat stop", () => {
    const r = anthropicResponseToOpenAIChat({
      content: [{ type: "text", text: "x" }], stop_reason: "stop_sequence"
    });
    assert.strictEqual(r.choices[0].finish_reason, "stop");
  });

  it("Anthropic refusal → Chat content_filter", () => {
    const r = anthropicResponseToOpenAIChat({
      content: [{ type: "text", text: "" }], stop_reason: "refusal"
    });
    assert.strictEqual(r.choices[0].finish_reason, "content_filter");
  });

  it("Chat content_filter → Anthropic refusal", () => {
    const r = openaiChatResponseToAnthropic({
      choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "" } }]
    });
    assert.strictEqual(r.stop_reason, "refusal");
  });

  it("Chat function_call → Anthropic tool_use (legacy)", () => {
    const r = openaiChatResponseToAnthropic({
      choices: [{ finish_reason: "function_call", message: { role: "assistant", content: "" } }]
    });
    assert.strictEqual(r.stop_reason, "tool_use");
  });
});

describe("createAnthropicToOpenAISSETranslator - tool index remap", () => {
  it("assigns dense 0-based tool_calls[].index across content-block indexes", () => {
    const t = createAnthropicToOpenAISSETranslator("c", "m");
    const evs = [
      'data: {"type":"message_start","message":{"id":"m","role":"assistant","model":"m","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"A","name":"f1","input":{}}}',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}',
      'data: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"B","name":"f2","input":{}}}',
      'data: {"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\\"b\\":2}"}}',
      'data: {"type":"message_stop"}'
    ];
    let out = "";
    for (const e of evs) out += t.translate(e);
    const indexes = [];
    for (const line of out.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      if (line.includes("[DONE]")) continue;
      let obj; try { obj = JSON.parse(line.slice(6)); } catch { continue; }
      const tc = obj?.choices?.[0]?.delta?.tool_calls;
      if (Array.isArray(tc)) for (const x of tc) indexes.push(x.index);
    }
    // First tool_use got index 0, second got 1 — NOT 2/3 from content-block indexes.
    assert.deepStrictEqual(Array.from(new Set(indexes)).sort(), [0, 1]);
  });
});

describe("sanitizeAnthropicBody", () => {
  it("replaces empty text blocks with placeholder", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "" }] },
      ],
    };
    sanitizeAnthropicBody(body);
    assert.equal(body.messages[0].content[0].text, "(empty)");
  });

  it("replaces whitespace-only text blocks with placeholder", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "   \n\t " }] },
      ],
    };
    sanitizeAnthropicBody(body);
    assert.equal(body.messages[0].content[0].text, "(empty)");
  });

  it("preserves text blocks containing valid characters", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    };
    sanitizeAnthropicBody(body);
    assert.equal(body.messages[0].content[0].text, "hello");
  });

  it("cleans empty text inside tool_result content arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "" }] },
          ],
        },
      ],
    };
    sanitizeAnthropicBody(body);
    const tr = body.messages[0].content[0];
    assert.equal(tr.content[0].text, "(empty)");
  });

  it("collapses tool_result with no usable parts to placeholder string", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "x", content: [{ type: "weird" }] },
          ],
        },
      ],
    };
    sanitizeAnthropicBody(body);
    assert.equal(body.messages[0].content[0].content, "(empty)");
  });

  it("converts string tool_result content of whitespace to placeholder", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "  " }] },
      ],
    };
    sanitizeAnthropicBody(body);
    assert.equal(body.messages[0].content[0].content, "(empty)");
  });

  it("fills missing tool_use id and name", () => {
    const body = {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", input: { x: 1 } }] },
      ],
    };
    sanitizeAnthropicBody(body);
    const tu = body.messages[1].content[0];
    assert.ok(tu.id && typeof tu.id === "string");
    assert.equal(tu.name, "unknown_tool");
    assert.deepStrictEqual(tu.input, { x: 1 });
  });

  it("normalizes non-object tool_use input to {}", () => {
    const body = {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "n", input: null }] },
      ],
    };
    sanitizeAnthropicBody(body);
    assert.deepStrictEqual(body.messages[1].content[0].input, {});
  });

  it("drops image blocks without a usable source", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "base64" } },
            { type: "image", source: { type: "url", url: "" } },
          ],
        },
      ],
    };
    sanitizeAnthropicBody(body);
    assert.equal(body.messages[0].content.length, 1);
    assert.equal(body.messages[0].content[0].type, "text");
  });

  it("drops thinking blocks without payload", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "" },
            { type: "text", text: "real" },
          ],
        },
      ],
    };
    sanitizeAnthropicBody(body);
    assert.equal(body.messages[0].content.length, 1);
    assert.equal(body.messages[0].content[0].type, "text");
  });

  it("drops messages whose content becomes empty", () => {
    const body = {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "image", source: null }] },
        { role: "user", content: "third" },
      ],
    };
    sanitizeAnthropicBody(body);
    // Empty assistant turn dropped; both user turns survive but get coalesced
    // into one because they are now adjacent same-role.
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, "user");
    const texts = body.messages[0].content.map(b => b.text);
    assert.deepStrictEqual(texts, ["first", "third"]);
  });

  it("coalesces adjacent same-role messages", () => {
    const body = {
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
    };
    sanitizeAnthropicBody(body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content.length, 2);
  });

  it("ensures first message is role user", () => {
    const body = {
      messages: [
        { role: "assistant", content: "lead" },
      ],
    };
    sanitizeAnthropicBody(body);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, "user");
  });

  it("inserts a placeholder user message when input is empty", () => {
    const body = { messages: [] };
    sanitizeAnthropicBody(body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.messages[0].content[0].text, "(empty)");
  });

  it("normalizes string content to a text block", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    sanitizeAnthropicBody(body);
    assert.deepStrictEqual(body.messages[0].content, [{ type: "text", text: "hi" }]);
  });

  it("strips whitespace-only top-level system string", () => {
    const body = { system: "   ", messages: [{ role: "user", content: "x" }] };
    sanitizeAnthropicBody(body);
    assert.equal(body.system, undefined);
  });

  it("flattens array system blocks to a string", () => {
    const body = {
      system: [{ type: "text", text: "a" }, { type: "text", text: "" }, { type: "text", text: "b" }],
      messages: [{ role: "user", content: "x" }],
    };
    sanitizeAnthropicBody(body);
    assert.equal(body.system, "a\n\nb");
  });

  it("returns body unchanged when not an object or no messages", () => {
    assert.equal(sanitizeAnthropicBody(null), null);
    const noMsgs = { foo: 1 };
    assert.equal(sanitizeAnthropicBody(noMsgs), noMsgs);
  });
});
