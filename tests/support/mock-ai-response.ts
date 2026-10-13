/** In-memory SDK responses: no DNS, sockets, real credentials or model calls. */
export function mockAIResponse(init?: RequestInit, calls: { name: string; input: unknown }[] = [
  { name: "add_step", input: { id: "s1", narration: "讲解", target: { kind: "code-line", start: 1 } } },
  { name: "finish", input: {} },
]): Response {
  const body = JSON.parse(String(init?.body));
  if (!body.stream) return Response.json({
    id: "mock", object: "chat.completion", created: 0, model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: "观察题目条件。" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
    id: "mock", object: "chat.completion.chunk", created: 0, model: body.model,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`;
  return new Response(chunk({ tool_calls: calls.map((call, index) => ({
    index, id: `call-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) },
  })) }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}
