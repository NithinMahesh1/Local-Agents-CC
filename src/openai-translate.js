// Translation between the Anthropic Messages API (what Claude Code speaks) and the OpenAI
// Chat Completions API (what some local servers speak). Every function here is pure: no network,
// no logging, no settings. The router (router.js) does the sending.
//
// Parts that have no match on the other side are dropped on purpose and are listed in the
// comments of each function.

/**
 * Converts the body of an Anthropic POST /v1/messages request to the body of an OpenAI
 * POST /v1/chat/completions request.
 *
 * Dropped, because OpenAI has no slot for them: top_k, thinking, metadata, cache_control,
 * thinking blocks in earlier assistant turns, images inside tool results, and is_error on tool
 * results.
 * @param {object} anthropicBody - the parsed JSON request body
 * @returns {object} the OpenAI request body
 * @throws {Error} when the body or its messages do not have the expected shape
 */
export function anthropicToOpenAIRequest(anthropicBody) {
  if (!isObject(anthropicBody)) {
    throw new Error('the request body must be a JSON object');
  }
  if (!Array.isArray(anthropicBody.messages)) {
    throw new Error('the request body must hold a "messages" list');
  }
  const out = { model: anthropicBody.model };
  if (anthropicBody.max_tokens !== undefined) {
    out.max_tokens = anthropicBody.max_tokens;
  }
  if (anthropicBody.temperature !== undefined) {
    out.temperature = anthropicBody.temperature;
  }
  if (anthropicBody.top_p !== undefined) {
    out.top_p = anthropicBody.top_p;
  }
  if (anthropicBody.stop_sequences !== undefined) {
    out.stop = anthropicBody.stop_sequences;
  }
  if (anthropicBody.stream !== undefined) {
    out.stream = anthropicBody.stream;
  }

  const messages = [];
  const system = systemText(anthropicBody.system);
  if (system !== '') {
    messages.push({ role: 'system', content: system });
  }
  for (const message of anthropicBody.messages) {
    messages.push(...convertMessage(message));
  }
  out.messages = messages;

  const tools = convertTools(anthropicBody.tools);
  if (tools.length > 0) {
    out.tools = tools;
    const choice = convertToolChoice(anthropicBody.tool_choice);
    if (choice !== undefined) {
      out.tool_choice = choice;
    }
    if (isObject(anthropicBody.tool_choice)
      && anthropicBody.tool_choice.disable_parallel_tool_use === true) {
      out.parallel_tool_calls = false;
    }
  }
  return out;
}

/**
 * Converts the JSON answer of an OpenAI chat completion to an Anthropic message.
 * Only the first choice is used. A "reasoning" field of the answer is dropped.
 * @param {object} openAIJson - the parsed answer
 * @returns {{id: string, type: 'message', role: 'assistant', model: string, content: object[],
 *   stop_reason: string, stop_sequence: null,
 *   usage: {input_tokens: number, output_tokens: number}}}
 * @throws {Error} when the answer has no choice, or a tool call has arguments that are not JSON
 */
export function openAIToAnthropicResponse(openAIJson) {
  const choice = isObject(openAIJson) && Array.isArray(openAIJson.choices)
    ? openAIJson.choices[0]
    : undefined;
  if (!isObject(choice) || !isObject(choice.message)) {
    throw new Error('the answer holds no message');
  }
  const { message } = choice;
  const content = [];
  if (typeof message.content === 'string' && message.content !== '') {
    content.push({ type: 'text', text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const argumentsText = call?.function?.arguments;
      let input = {};
      if (typeof argumentsText === 'string' && argumentsText.trim() !== '') {
        try {
          input = JSON.parse(argumentsText);
        } catch {
          throw new Error('the arguments of a tool call are not valid JSON');
        }
      }
      content.push({
        type: 'tool_use',
        id: call?.id ?? `call_${content.length}`,
        name: call?.function?.name ?? '',
        input,
      });
    }
  }
  return {
    id: openAIJson.id ?? 'msg_local',
    type: 'message',
    role: 'assistant',
    model: openAIJson.model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openAIJson.usage?.prompt_tokens ?? 0,
      output_tokens: openAIJson.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Makes a translator for ONE streamed answer. Feed it the parsed "data:" objects of the OpenAI
 * stream with push(), and call end() once when the stream is over. Both return a list of
 * complete Anthropic SSE records ("event: <type>\ndata: <json>\n\n").
 *
 * Order of the events: message_start, then for each block content_block_start, its deltas and
 * content_block_stop (text deltas are text_delta, tool arguments are input_json_delta), then
 * message_delta and message_stop. A block of text starts at the first text; a block of tool_use
 * starts at the first fragment of each tool call. A tool call whose block was already closed
 * (a server that mixes the fragments of two calls) is not reopened: that fragment is dropped.
 * @returns {{push: (chunk: object) => string[], end: () => string[]}}
 */
export function createStreamTranslator() {
  let started = false;
  let stopped = false;
  let nextIndex = 0;
  let openBlock = null;
  let finishReason = null;
  let inputTokens = 0;
  let outputTokens = 0;
  const toolBlocks = new Map();

  function start(chunk, events) {
    if (started) {
      return;
    }
    started = true;
    events.push(sse('message_start', {
      type: 'message_start',
      message: {
        id: chunk?.id ?? 'msg_local',
        type: 'message',
        role: 'assistant',
        model: chunk?.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    }));
  }

  function closeBlock(events) {
    if (openBlock !== null) {
      events.push(sse('content_block_stop', {
        type: 'content_block_stop',
        index: openBlock.index,
      }));
      openBlock = null;
    }
  }

  function openNew(type, contentBlock, events) {
    closeBlock(events);
    const index = nextIndex;
    nextIndex += 1;
    openBlock = { index, type };
    events.push(sse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: contentBlock,
    }));
    return index;
  }

  return {
    push(chunk) {
      const events = [];
      if (stopped || !isObject(chunk)) {
        return events;
      }
      if (isObject(chunk.usage)) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }
      start(chunk, events);
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (!isObject(choice)) {
        return events;
      }
      const delta = isObject(choice.delta) ? choice.delta : {};
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (openBlock === null || openBlock.type !== 'text') {
          openNew('text', { type: 'text', text: '' }, events);
        }
        events.push(sse('content_block_delta', {
          type: 'content_block_delta',
          index: openBlock.index,
          delta: { type: 'text_delta', text: delta.content },
        }));
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          pushToolCall(call, events);
        }
      }
      if (typeof choice.finish_reason === 'string') {
        finishReason = choice.finish_reason;
      }
      return events;
    },

    end() {
      const events = [];
      if (stopped) {
        return events;
      }
      stopped = true;
      start(null, events);
      closeBlock(events);
      events.push(sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }));
      events.push(sse('message_stop', { type: 'message_stop' }));
      return events;
    },
  };

  function pushToolCall(call, events) {
    if (!isObject(call)) {
      return;
    }
    const key = Number.isInteger(call.index) ? call.index : 0;
    const fragment = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
    if (!toolBlocks.has(key)) {
      const index = openNew('tool_use', {
        type: 'tool_use',
        id: call.id ?? `call_${key}`,
        name: call.function?.name ?? '',
        input: {},
      }, events);
      toolBlocks.set(key, index);
    }
    const blockIndex = toolBlocks.get(key);
    if (fragment !== '' && openBlock !== null && openBlock.index === blockIndex) {
      events.push(sse('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: fragment },
      }));
    }
  }
}

// ---- helpers -----------------------------------------------------------------------------------

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sse(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mapFinishReason(reason) {
  if (reason === 'length') {
    return 'max_tokens';
  }
  if (reason === 'tool_calls') {
    return 'tool_use';
  }
  return 'end_turn';
}

// The system prompt: a string, or a list of { type: 'text', text } blocks joined by line breaks.
function systemText(system) {
  if (typeof system === 'string') {
    return system;
  }
  if (Array.isArray(system)) {
    return system
      .filter((block) => isObject(block) && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

// One Anthropic message becomes one or more OpenAI messages.
function convertMessage(message) {
  if (!isObject(message) || (message.role !== 'user' && message.role !== 'assistant')) {
    throw new Error('a message must have the role "user" or "assistant"');
  }
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }];
  }
  if (!Array.isArray(message.content)) {
    throw new Error('a message must have a string or a list as content');
  }
  return message.role === 'assistant'
    ? convertAssistant(message.content)
    : convertUser(message.content);
}

// A user message: each tool_result is a message of its own (they come first, because OpenAI
// wants the tool messages right after the assistant message that made the calls). The text and
// images that remain stay one user message.
function convertUser(blocks) {
  const toolMessages = [];
  const parts = [];
  for (const block of blocks) {
    if (!isObject(block)) {
      continue;
    }
    if (block.type === 'tool_result') {
      toolMessages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: toolResultText(block.content),
      });
    } else {
      const part = convertPart(block);
      if (part !== null) {
        parts.push(part);
      }
    }
  }
  const content = joinParts(parts);
  return content === null ? toolMessages : [...toolMessages, { role: 'user', content }];
}

// An assistant message: its text, and its tool_use blocks as tool_calls.
function convertAssistant(blocks) {
  const parts = [];
  const toolCalls = [];
  for (const block of blocks) {
    if (!isObject(block)) {
      continue;
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    } else {
      const part = convertPart(block);
      if (part !== null) {
        parts.push(part);
      }
    }
  }
  const message = { role: 'assistant', content: joinParts(parts) };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  } else if (message.content === null) {
    message.content = '';
  }
  return [message];
}

// A text or image block as an OpenAI content part. Other blocks (thinking, documents) give null.
function convertPart(block) {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'image' && isObject(block.source)) {
    if (block.source.type === 'base64') {
      const url = `data:${block.source.media_type};base64,${block.source.data}`;
      return { type: 'image_url', image_url: { url } };
    }
    if (block.source.type === 'url' && typeof block.source.url === 'string') {
      return { type: 'image_url', image_url: { url: block.source.url } };
    }
  }
  return null;
}

// Only text: one string (blocks joined by line breaks). With an image: a content list.
// Nothing: null.
function joinParts(parts) {
  if (parts.length === 0) {
    return null;
  }
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('\n');
  }
  return parts;
}

// The content of a tool_result: a string, or a list of text blocks joined by line breaks.
function toolResultText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

function convertTools(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .filter((tool) => isObject(tool) && typeof tool.name === 'string')
    .map((tool) => {
      const fn = {
        name: tool.name,
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      };
      if (tool.description !== undefined) {
        fn.description = tool.description;
      }
      return { type: 'function', function: fn };
    });
}

function convertToolChoice(choice) {
  if (!isObject(choice)) {
    return undefined;
  }
  if (choice.type === 'auto') {
    return 'auto';
  }
  if (choice.type === 'any') {
    return 'required';
  }
  if (choice.type === 'none') {
    return 'none';
  }
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}
