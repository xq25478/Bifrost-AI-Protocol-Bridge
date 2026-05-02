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

  it("getUsage returns accumulated usage", () => {
    const t = createOpenAIToAnthropicSSETranslator("msg_1", "gpt-4");
    t.translate({
      choices: [{ delta: { content: "x" }, finish_reason: "stop" }],
      usage: { completion_tokens: 10, prompt_tokens: 5 }
    });
    assert.strictEqual(t.getUsage().completion_tokens, 10);
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
      messages: [{
        role: "tool",
        tool_call_id: "call_1",
        content: "It's sunny"
      }]
    };
    const result = openaiBodyToAnthropic(body);
    assert.strictEqual(result.messages[0].role, "user");
    assert.strictEqual(result.messages[0].content[0].type, "tool_result");
    assert.strictEqual(result.messages[0].content[0].tool_use_id, "call_1");
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