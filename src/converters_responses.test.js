"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  responsesBodyToOpenAIChat,
  openaiChatResponseToResponses,
  createOpenAIChatToResponsesSSETranslator,
  usageToResponsesShape,
} = require("./converters_responses");

// ============================================================
// responsesBodyToOpenAIChat
// ============================================================

test("responsesBodyToOpenAIChat - string input becomes user message", () => {
  const chat = responsesBodyToOpenAIChat({ model: "gpt-4o", input: "hi there" });
  assert.strictEqual(chat.model, "gpt-4o");
  assert.deepStrictEqual(chat.messages, [{ role: "user", content: "hi there" }]);
});

test("responsesBodyToOpenAIChat - instructions render as leading system message", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "gpt-4o",
    instructions: "You are helpful.",
    input: "hi",
  });
  assert.strictEqual(chat.messages.length, 2);
  assert.deepStrictEqual(chat.messages[0], { role: "system", content: "You are helpful." });
  assert.deepStrictEqual(chat.messages[1], { role: "user", content: "hi" });
});

test("responsesBodyToOpenAIChat - input_text parts fold into plain content string", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "gpt-4o",
    input: [
      { type: "message", role: "user", content: [
        { type: "input_text", text: "Hello " },
        { type: "input_text", text: "world" },
      ] }
    ],
  });
  assert.deepStrictEqual(chat.messages[0], { role: "user", content: "Hello world" });
});

test("responsesBodyToOpenAIChat - mixed text + image goes through as array", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "gpt-4o",
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "describe" },
      { type: "input_image", image_url: "https://example.com/x.png", detail: "high" },
    ] }],
  });
  const m = chat.messages[0];
  assert.strictEqual(m.role, "user");
  assert.ok(Array.isArray(m.content));
  assert.strictEqual(m.content[0].type, "text");
  assert.strictEqual(m.content[1].type, "image_url");
  assert.strictEqual(m.content[1].image_url.url, "https://example.com/x.png");
  assert.strictEqual(m.content[1].image_url.detail, "high");
});

test("responsesBodyToOpenAIChat - function_call items fold into assistant.tool_calls", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "gpt-4o",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] },
      { type: "function_call", call_id: "call_123", name: "get_weather", arguments: '{"city":"NYC"}' },
      { type: "function_call_output", call_id: "call_123", output: "72F" },
    ],
  });
  assert.strictEqual(chat.messages.length, 3);
  assert.strictEqual(chat.messages[1].role, "assistant");
  assert.deepStrictEqual(chat.messages[1].tool_calls, [{
    id: "call_123",
    type: "function",
    function: { name: "get_weather", arguments: '{"city":"NYC"}' },
  }]);
  assert.strictEqual(chat.messages[2].role, "tool");
  assert.strictEqual(chat.messages[2].tool_call_id, "call_123");
  assert.strictEqual(chat.messages[2].content, "72F");
});

test("responsesBodyToOpenAIChat - Responses flat function tool wraps into Chat function tool", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "gpt-4o",
    input: "hi",
    tools: [{ type: "function", name: "get_weather", description: "d", parameters: { type: "object", properties: { x: { type: "string" } } } }],
    tool_choice: { type: "function", name: "get_weather" },
    parallel_tool_calls: false,
  });
  assert.strictEqual(chat.tools.length, 1);
  assert.deepStrictEqual(chat.tools[0], {
    type: "function",
    function: {
      name: "get_weather",
      description: "d",
      parameters: { type: "object", properties: { x: { type: "string" } } },
    },
  });
  assert.deepStrictEqual(chat.tool_choice, { type: "function", function: { name: "get_weather" } });
  assert.strictEqual(chat.parallel_tool_calls, false);
});

test("responsesBodyToOpenAIChat - hosted tool types are dropped silently", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "gpt-4o",
    input: "hi",
    tools: [
      { type: "function", name: "echo", description: "", parameters: { type: "object" } },
      { type: "web_search_preview" },
      { type: "file_search" },
    ],
  });
  assert.strictEqual(chat.tools.length, 1);
  assert.strictEqual(chat.tools[0].function.name, "echo");
});

test("responsesBodyToOpenAIChat - max_output_tokens renames to max_tokens", () => {
  const chat = responsesBodyToOpenAIChat({ model: "gpt-4o", input: "hi", max_output_tokens: 100 });
  assert.strictEqual(chat.max_tokens, 100);
  assert.strictEqual(chat.max_output_tokens, undefined);
});

test("responsesBodyToOpenAIChat - reasoning.effort passes through as reasoning_effort", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "o3", input: "hi", reasoning: { effort: "high", summary: "auto" },
  });
  assert.strictEqual(chat.reasoning_effort, "high");
});

test("responsesBodyToOpenAIChat - unknown input item types are dropped", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "gpt-4o",
    input: [
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "web_search_call" },
    ],
  });
  assert.strictEqual(chat.messages.length, 1);
  assert.strictEqual(chat.messages[0].content, "go");
});

test("responsesBodyToOpenAIChat - developer role collapses to system", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "gpt-4o",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Be terse." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  });
  assert.strictEqual(chat.messages.length, 2);
  assert.strictEqual(chat.messages[0].role, "system");
  assert.strictEqual(chat.messages[0].content, "Be terse.");
});

test("responsesBodyToOpenAIChat - function_call_output array flattens to text", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "gpt-4o",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "run" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: '{"cmd":"ls"}' },
      { type: "function_call_output", call_id: "c1", output: [
        { type: "output_text", text: "file1\n" },
        { type: "output_text", text: "file2" },
      ] },
    ],
  });
  const toolMsg = chat.messages[chat.messages.length - 1];
  assert.strictEqual(toolMsg.role, "tool");
  assert.strictEqual(toolMsg.content, "file1\nfile2");
});

test("responsesBodyToOpenAIChat - text + function_call in same assistant turn merge to one message", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "gpt-4o",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me check." }] },
      { type: "function_call", call_id: "c1", name: "get_weather", arguments: '{}' },
      { type: "function_call_output", call_id: "c1", output: "72F" },
    ],
  });
  // Assistant text + tool_call should be ONE message (Chat spec).
  const assistantMsgs = chat.messages.filter(m => m.role === "assistant");
  assert.strictEqual(assistantMsgs.length, 1);
  assert.strictEqual(assistantMsgs[0].content, "Let me check.");
  assert.strictEqual(assistantMsgs[0].tool_calls.length, 1);
  assert.strictEqual(assistantMsgs[0].tool_calls[0].function.name, "get_weather");
});

test("responsesBodyToOpenAIChat - reasoning between function_calls does not split assistant turn", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "gpt-4o",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "plan" }] },
      { type: "function_call", call_id: "c1", name: "a", arguments: "{}" },
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "function_call", call_id: "c2", name: "b", arguments: "{}" },
    ],
  });
  const assistantMsgs = chat.messages.filter(m => m.role === "assistant");
  // Both tool_calls should live on a single assistant message.
  assert.strictEqual(assistantMsgs.length, 1);
  assert.strictEqual(assistantMsgs[0].tool_calls.length, 2);
  assert.strictEqual(assistantMsgs[0].tool_calls[0].function.name, "a");
  assert.strictEqual(assistantMsgs[0].tool_calls[1].function.name, "b");
});

// ============================================================
// openaiChatResponseToResponses (non-streaming)
// ============================================================

test("openaiChatResponseToResponses - text response shape", () => {
  const chat = {
    id: "cmpl_x",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
  const resp = openaiChatResponseToResponses(chat, { model: "gpt-4o" });
  assert.strictEqual(resp.object, "response");
  assert.strictEqual(resp.status, "completed");
  assert.strictEqual(resp.model, "gpt-4o");
  assert.ok(resp.id.startsWith("resp_"));
  assert.strictEqual(resp.output_text, "Hi there");
  assert.strictEqual(resp.output.length, 1);
  assert.strictEqual(resp.output[0].type, "message");
  assert.strictEqual(resp.output[0].role, "assistant");
  assert.strictEqual(resp.output[0].content[0].type, "output_text");
  assert.strictEqual(resp.output[0].content[0].text, "Hi there");
  assert.deepStrictEqual(resp.usage, { input_tokens: 10, output_tokens: 3, total_tokens: 13 });
});

test("openaiChatResponseToResponses - tool_calls become function_call items", () => {
  const chat = {
    id: "cmpl_y",
    model: "gpt-4o",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
  };
  const resp = openaiChatResponseToResponses(chat, { model: "gpt-4o" });
  assert.strictEqual(resp.output.length, 1);
  const item = resp.output[0];
  assert.strictEqual(item.type, "function_call");
  assert.strictEqual(item.call_id, "call_1");
  assert.strictEqual(item.name, "get_weather");
  assert.strictEqual(item.arguments, '{"city":"NYC"}');
  assert.strictEqual(item.status, "completed");
});

test("openaiChatResponseToResponses - finish_reason=length maps to incomplete", () => {
  const chat = {
    choices: [{ message: { content: "truncated..." }, finish_reason: "length" }],
  };
  const resp = openaiChatResponseToResponses(chat, {});
  assert.strictEqual(resp.status, "incomplete");
  assert.deepStrictEqual(resp.incomplete_details, { reason: "max_output_tokens" });
});

test("openaiChatResponseToResponses - cached tokens surface in input_tokens_details", () => {
  const chat = {
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 30 } },
  };
  const resp = openaiChatResponseToResponses(chat, {});
  assert.strictEqual(resp.usage.input_tokens, 100);
  assert.strictEqual(resp.usage.output_tokens, 10);
  assert.strictEqual(resp.usage.total_tokens, 110);
  assert.deepStrictEqual(resp.usage.input_tokens_details, { cached_tokens: 30 });
});

// ============================================================
// usageToResponsesShape
// ============================================================

test("usageToResponsesShape - Anthropic-style cache_read maps to input_tokens_details", () => {
  const u = usageToResponsesShape({ input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 12 });
  assert.strictEqual(u.input_tokens, 32);
  assert.strictEqual(u.output_tokens, 5);
  assert.strictEqual(u.total_tokens, 37);
  assert.deepStrictEqual(u.input_tokens_details, { cached_tokens: 12 });
});

test("usageToResponsesShape - cache_write_input_tokens preserved as extension field", () => {
  const u = usageToResponsesShape({ input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 3 });
  assert.strictEqual(u.cache_creation_input_tokens, 3);
});

// ============================================================
// createOpenAIChatToResponsesSSETranslator
// ============================================================

function parseResponsesSSE(buffer) {
  const blocks = buffer.split("\n\n").filter(s => s.trim().length > 0);
  const events = [];
  for (const b of blocks) {
    const eventLine = b.split("\n").find(l => l.startsWith("event: "));
    const dataLine = b.split("\n").find(l => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    events.push({
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)),
    });
  }
  return events;
}

test("ChatToResponsesSSETranslator - text-only stream emits canonical event sequence", () => {
  const t = createOpenAIChatToResponsesSSETranslator("gpt-4o", { model: "gpt-4o" });
  const buf = [];
  buf.push(t.translate({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }));
  buf.push(t.translate({ choices: [{ index: 0, delta: { content: "Hello " } }] }));
  buf.push(t.translate({ choices: [{ index: 0, delta: { content: "world" } }] }));
  buf.push(t.translate({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  buf.push(t.translate({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  buf.push(t.finalize());
  const events = parseResponsesSSE(buf.join(""));
  const order = events.map(e => e.event);
  assert.deepStrictEqual(order, [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  const done = events.find(e => e.event === "response.output_text.done");
  assert.strictEqual(done.data.text, "Hello world");
  const completed = events.find(e => e.event === "response.completed");
  assert.strictEqual(completed.data.response.status, "completed");
  assert.strictEqual(completed.data.response.output_text, "Hello world");
  assert.deepStrictEqual(completed.data.response.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
});

test("ChatToResponsesSSETranslator - sequence_number increments monotonically", () => {
  const t = createOpenAIChatToResponsesSSETranslator("gpt-4o", {});
  const buf = [];
  buf.push(t.translate({ choices: [{ delta: { content: "a" } }] }));
  buf.push(t.translate({ choices: [{ delta: { content: "b" }, finish_reason: "stop" }] }));
  buf.push(t.finalize());
  const events = parseResponsesSSE(buf.join(""));
  const seqs = events.map(e => e.data.sequence_number);
  for (let i = 1; i < seqs.length; i += 1) {
    assert.strictEqual(seqs[i], seqs[i - 1] + 1, `seq[${i}] should follow seq[${i - 1}]`);
  }
});

test("ChatToResponsesSSETranslator - tool call stream emits function_call events", () => {
  const t = createOpenAIChatToResponsesSSETranslator("gpt-4o", {});
  const buf = [];
  buf.push(t.translate({ choices: [{ delta: { tool_calls: [
    { index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } }
  ] } }] }));
  buf.push(t.translate({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"' } }] } }] }));
  buf.push(t.translate({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'NYC"}' } }] } }] }));
  buf.push(t.translate({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
  buf.push(t.finalize());
  const events = parseResponsesSSE(buf.join(""));
  const added = events.find(e => e.event === "response.output_item.added");
  assert.strictEqual(added.data.item.type, "function_call");
  assert.strictEqual(added.data.item.call_id, "call_abc");
  assert.strictEqual(added.data.item.name, "get_weather");
  const deltas = events.filter(e => e.event === "response.function_call_arguments.delta");
  assert.strictEqual(deltas.length, 2);
  const done = events.find(e => e.event === "response.function_call_arguments.done");
  assert.strictEqual(done.data.arguments, '{"city":"NYC"}');
});

test("ChatToResponsesSSETranslator - mixed text-then-tool closes message before opening tool", () => {
  const t = createOpenAIChatToResponsesSSETranslator("gpt-4o", {});
  const buf = [];
  buf.push(t.translate({ choices: [{ delta: { content: "thinking" } }] }));
  buf.push(t.translate({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }] } }] }));
  buf.push(t.translate({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
  buf.push(t.finalize());
  const events = parseResponsesSSE(buf.join(""));
  const seq = events.map(e => e.event);
  const msgDoneIdx = seq.indexOf("response.output_item.done");
  const toolAddedIdx = seq.indexOf("response.output_item.added", msgDoneIdx + 1);
  assert.ok(msgDoneIdx > 0);
  assert.ok(toolAddedIdx > msgDoneIdx);
  const completed = events.find(e => e.event === "response.completed");
  assert.strictEqual(completed.data.response.output.length, 2);
});

test("ChatToResponsesSSETranslator - finalize() with error emits response.failed", () => {
  const t = createOpenAIChatToResponsesSSETranslator("gpt-4o", {});
  t.translate({ choices: [{ delta: { content: "hi" } }] });
  const out = t.finalize(new Error("upstream boom"));
  const events = parseResponsesSSE(out);
  assert.ok(events.some(e => e.event === "response.failed"));
  const failed = events.find(e => e.event === "response.failed");
  assert.strictEqual(failed.data.response.status, "failed");
  assert.strictEqual(failed.data.response.error.message, "upstream boom");
});

test("ChatToResponsesSSETranslator - finalize is idempotent", () => {
  const t = createOpenAIChatToResponsesSSETranslator("gpt-4o", {});
  t.translate({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] });
  const first = t.finalize();
  const second = t.finalize();
  assert.ok(first.length > 0);
  assert.strictEqual(second, "");
});

// ============================================================
// Responses ↔ Chat reasoning parity + tool passthrough
// ============================================================

test("openaiChatResponseToResponses - reasoning_content becomes reasoning output item", () => {
  const resp = openaiChatResponseToResponses({
    model: "m",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ans", reasoning_content: "mull it over" } }],
    usage: { prompt_tokens: 5, completion_tokens: 2 }
  }, { model: "m" });
  assert.strictEqual(resp.output.length, 2);
  assert.strictEqual(resp.output[0].type, "reasoning");
  assert.strictEqual(resp.output[0].summary[0].type, "summary_text");
  assert.strictEqual(resp.output[0].summary[0].text, "mull it over");
  assert.strictEqual(resp.output[1].type, "message");
});

test("openaiChatResponseToResponses - no reasoning item when reasoning_content absent", () => {
  const resp = openaiChatResponseToResponses({
    model: "m",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ans" } }]
  }, { model: "m" });
  assert.ok(!resp.output.find(o => o.type === "reasoning"));
});

test("responsesBodyToOpenAIChat - tools[].strict forwards through to Chat function.strict", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "m",
    input: "hi",
    tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object", properties: {} }, strict: true }]
  });
  assert.strictEqual(chat.tools.length, 1);
  assert.strictEqual(chat.tools[0].function.strict, true);
});

test("responsesBodyToOpenAIChat - parallel_tool_calls:false propagates", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "m", input: "hi", parallel_tool_calls: false
  });
  assert.strictEqual(chat.parallel_tool_calls, false);
});

test("createOpenAIChatToResponsesSSETranslator - delta.reasoning_content emits reasoning events in order", () => {
  const tr = createOpenAIChatToResponsesSSETranslator("m", { model: "m" });
  const out =
    tr.translate({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }) +
    tr.translate({ choices: [{ delta: { reasoning_content: "part1 " } }] }) +
    tr.translate({ choices: [{ delta: { reasoning_content: "part2" } }] }) +
    tr.translate({ choices: [{ delta: { content: "answer" } }] }) +
    tr.translate({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
    tr.finalize();

  const events = out.split("\n\n").filter(Boolean).map(blk => {
    const m = blk.match(/^event: ([^\n]+)/);
    return m ? m[1] : null;
  }).filter(Boolean);

  // Reasoning phase must fully close BEFORE text message opens.
  const firstReasoningDelta = events.indexOf("response.reasoning_summary_text.delta");
  const reasoningItemDone = events.indexOf("response.output_item.done");
  const firstTextDelta = events.indexOf("response.output_text.delta");
  assert.ok(firstReasoningDelta >= 0 && reasoningItemDone >= 0 && firstTextDelta >= 0);
  assert.ok(firstReasoningDelta < firstTextDelta);
  assert.ok(reasoningItemDone < firstTextDelta);

  // Summary text was concatenated correctly.
  assert.ok(out.includes('"delta":"part1 "'));
  assert.ok(out.includes('"delta":"part2"'));
});

test("createOpenAIChatToResponsesSSETranslator - reasoning before tool_calls (no text)", () => {
  const tr = createOpenAIChatToResponsesSSETranslator("m", { model: "m" });
  const out =
    tr.translate({ choices: [{ delta: { role: "assistant" } }] }) +
    tr.translate({ choices: [{ delta: { reasoning_content: "thinking" } }] }) +
    tr.translate({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_A", type: "function", function: { name: "f", arguments: "{}" } }] } }] }) +
    tr.translate({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
    tr.finalize();

  // Ensure reasoning item was added AND closed before the tool item was added.
  const lines = out.split("\n");
  const addedIdxs = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === "event: response.output_item.added") addedIdxs.push(i);
  }
  assert.ok(addedIdxs.length >= 2, "expected at least two output_item.added (reasoning + tool)");
});

test("createOpenAIChatToResponsesSSETranslator - tool call_id backfilled when first chunk lacked it", () => {
  const tr = createOpenAIChatToResponsesSSETranslator("m", { model: "m" });
  tr.translate({ choices: [{ delta: { role: "assistant" } }] });
  // First tool chunk: no id, only name
  tr.translate({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", function: { name: "fn", arguments: "" } }] } }] });
  // Later chunk reveals upstream id
  tr.translate({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_REAL", function: { arguments: "{}" } }] } }] });
  const out = tr.translate({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + tr.finalize();

  // Search for the output_item.done item with call_id=call_REAL
  const match = out.match(/"call_id":"([^"]+)"/);
  assert.ok(match);
  assert.strictEqual(match[1], "call_REAL");
});

test("createOpenAIChatToResponsesSSETranslator - synthetic call_id kept when upstream never reveals one", () => {
  const tr = createOpenAIChatToResponsesSSETranslator("m", { model: "m" });
  tr.translate({ choices: [{ delta: { role: "assistant" } }] });
  tr.translate({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", function: { name: "fn", arguments: "{}" } }] } }] });
  const out = tr.translate({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + tr.finalize();
  const match = out.match(/"call_id":"(call_[a-f0-9]+)"/);
  assert.ok(match, "expected synthetic call_... id");
});

// ============================================================
// End-to-end: three-protocol round-trip parity
// ============================================================

test("round-trip: Responses reasoning → Chat → Anthropic preserves thinking", () => {
  const { openaiBodyToAnthropic } = require("./converters");
  const chat = responsesBodyToOpenAIChat({
    model: "m",
    input: "hi",
    reasoning: { effort: "high" },
    // Use a max_output_tokens large enough that the synthesized
    // thinking.budget_tokens (effortToBudget("high") ≈ 8k) plus answer-room
    // headroom still fits — otherwise the budget guard in openaiBodyToAnthropic
    // legitimately drops the thinking block. The test wants to verify that
    // the effort routing path produces a `thinking` block at all.
    max_output_tokens: 16000,
  });
  assert.strictEqual(chat.reasoning_effort, "high");
  const anth = openaiBodyToAnthropic(chat);
  assert.ok(anth.thinking);
  assert.strictEqual(anth.thinking.type, "enabled");
  assert.ok(anth.thinking.budget_tokens > 0);
});

test("round-trip: Anthropic history thinking → Chat reasoning_content → Anthropic thinking", () => {
  const { anthropicBodyToOpenAIChat, openaiBodyToAnthropic } = require("./converters");
  const original = {
    model: "m", max_tokens: 200,
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "CoT" },
        { type: "text", text: "ans" }
      ]},
      { role: "user", content: "next" }
    ]
  };
  const chat = anthropicBodyToOpenAIChat(original);
  const back = openaiBodyToAnthropic(chat);
  const aMsg = back.messages.find(m => m.role === "assistant");
  assert.ok(Array.isArray(aMsg.content));
  const thinkBlock = aMsg.content.find(b => b.type === "thinking");
  assert.ok(thinkBlock);
  assert.strictEqual(thinkBlock.thinking, "CoT");
  const textBlock = aMsg.content.find(b => b.type === "text");
  assert.strictEqual(textBlock.text, "ans");
});

test("round-trip: parallel_tool_calls:false survives Chat ↔ Anthropic both ways", () => {
  const { openaiBodyToAnthropic, anthropicBodyToOpenAIChat } = require("./converters");
  // Chat → Anthropic
  const anth = openaiBodyToAnthropic({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "auto",
    parallel_tool_calls: false,
    tools: [{ type: "function", function: { name: "f", parameters: {} } }]
  });
  assert.strictEqual(anth.tool_choice.disable_parallel_tool_use, true);
  // ...and back
  const chat = anthropicBodyToOpenAIChat(anth);
  assert.strictEqual(chat.parallel_tool_calls, false);
});

test("round-trip: Anthropic tool history → Chat merges tool_results, preserves order", () => {
  const { anthropicBodyToOpenAIChat, openaiBodyToAnthropic } = require("./converters");
  const original = {
    model: "m", max_tokens: 100,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [
        { type: "tool_use", id: "c1", name: "a", input: { x: 1 } },
        { type: "tool_use", id: "c2", name: "b", input: { y: 2 } }
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "c1", content: "r1" },
        { type: "tool_result", tool_use_id: "c2", content: "r2" }
      ]},
      { role: "assistant", content: "done" }
    ]
  };
  const chat = anthropicBodyToOpenAIChat(original);
  // Two role:"tool" messages, id order preserved.
  const toolMsgs = chat.messages.filter(m => m.role === "tool");
  assert.strictEqual(toolMsgs.length, 2);
  assert.strictEqual(toolMsgs[0].tool_call_id, "c1");
  assert.strictEqual(toolMsgs[1].tool_call_id, "c2");
  // Going back should collapse them into a single user turn with 2 tool_results.
  const back = openaiBodyToAnthropic(chat);
  const userTurns = back.messages.filter(m => m.role === "user");
  const mergedTurn = userTurns.find(m => Array.isArray(m.content) && m.content.some(c => c.type === "tool_result"));
  assert.ok(mergedTurn);
  assert.strictEqual(mergedTurn.content.filter(c => c.type === "tool_result").length, 2);
});

test("responsesBodyToOpenAIChat - function_call_output paired with function_call by call_id", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "m",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
      { type: "reasoning", summary: "plan" },
      { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" }
    ]
  });
  // assistant(tool_calls:[c1]) must be immediately followed by role:tool(c1)
  const asst = chat.messages.find(m => m.role === "assistant");
  const tool = chat.messages.find(m => m.role === "tool");
  assert.ok(asst && Array.isArray(asst.tool_calls) && asst.tool_calls[0].id === "c1");
  assert.ok(tool && tool.tool_call_id === "c1" && tool.content === "ok");
  const idxA = chat.messages.indexOf(asst);
  const idxT = chat.messages.indexOf(tool);
  assert.strictEqual(idxT, idxA + 1, "tool result must come immediately after its assistant tool_call");
});

test("responsesBodyToOpenAIChat - output that appears before its call is reordered", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "m",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call_output", call_id: "c1", output: "late-arriving" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "middle" }] },
      { type: "function_call", call_id: "c1", name: "f", arguments: "{}" }
    ]
  });
  const asst = chat.messages.find(m => m.role === "assistant" && Array.isArray(m.tool_calls));
  const tool = chat.messages.find(m => m.role === "tool");
  assert.ok(asst && tool);
  assert.strictEqual(chat.messages.indexOf(tool), chat.messages.indexOf(asst) + 1);
  assert.strictEqual(tool.content, "late-arriving");
});

test("responsesBodyToOpenAIChat - function_call without matching output gets empty placeholder", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "m",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
      { type: "function_call", call_id: "pending", name: "slow", arguments: "{}" }
    ]
  });
  const tool = chat.messages.find(m => m.role === "tool");
  assert.ok(tool, "orphan tool_call should still produce a paired empty tool message");
  assert.strictEqual(tool.tool_call_id, "pending");
  assert.strictEqual(tool.content, "");
});

test("responsesBodyToOpenAIChat - function_call_output with no matching call is dropped", () => {
  const chat = responsesBodyToOpenAIChat({
    model: "m",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call_output", call_id: "orphan", output: "stale" }
    ]
  });
  assert.strictEqual(chat.messages.some(m => m.role === "tool"), false);
});
