import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToOpenAIRequest,
  createStreamTranslator,
  openAIToAnthropicResponse,
} from '../src/openai-translate.js';

// The events of a stream as [type, data] pairs, read back from the SSE records.
function parseEvents(records) {
  return records.map((record) => {
    const match = /^event: (\S+)\ndata: (.*)\n\n$/s.exec(record);
    assert.ok(match, `not a full SSE record: ${JSON.stringify(record)}`);
    return [match[1], JSON.parse(match[2])];
  });
}

function textChunk(text, extra = {}) {
  const choices = [{ index: 0, delta: { content: text } }];
  return { id: 'chatcmpl-1', model: 'm', choices, ...extra };
}

describe('anthropicToOpenAIRequest', () => {
  it('maps the plain fields and drops the ones OpenAI has no slot for', () => {
    const out = anthropicToOpenAIRequest({
      model: 'm',
      max_tokens: 100,
      temperature: 0.5,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['END'],
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 1000 },
      metadata: { user_id: 'u' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.deepStrictEqual(out, {
      model: 'm',
      max_tokens: 100,
      temperature: 0.5,
      top_p: 0.9,
      stop: ['END'],
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('omits the optional fields that are absent', () => {
    const out = anthropicToOpenAIRequest({ model: 'm', messages: [] });
    assert.deepStrictEqual(out, { model: 'm', messages: [] });
  });

  it('turns a system string into a leading system message', () => {
    const out = anthropicToOpenAIRequest({
      model: 'm', system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }],
    });
    assert.deepStrictEqual(out.messages[0], { role: 'system', content: 'Be brief.' });
    assert.strictEqual(out.messages.length, 2);
  });

  it('joins the text blocks of a system list with line breaks', () => {
    const out = anthropicToOpenAIRequest({
      model: 'm',
      system: [
        { type: 'text', text: 'One.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Two.' },
      ],
      messages: [],
    });
    assert.deepStrictEqual(out.messages, [{ role: 'system', content: 'One.\nTwo.' }]);
  });

  it('keeps string content and joins text blocks', () => {
    const out = anthropicToOpenAIRequest({
      model: 'm',
      messages: [
        { role: 'user', content: 'plain' },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      ],
    });
    assert.deepStrictEqual(out.messages, [
      { role: 'user', content: 'plain' },
      { role: 'assistant', content: 'a\nb' },
    ]);
  });

  it('maps text plus a base64 image to an OpenAI content list', () => {
    const out = anthropicToOpenAIRequest({
      model: 'm',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      }],
    });
    assert.deepStrictEqual(out.messages, [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }]);
  });

  it('maps an image with a url source', () => {
    const out = anthropicToOpenAIRequest({
      model: 'm',
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'https://x.example/a.png' } }],
      }],
    });
    assert.deepStrictEqual(out.messages[0].content, [
      { type: 'image_url', image_url: { url: 'https://x.example/a.png' } },
    ]);
  });

  it('maps tool_use to tool_calls and tool_result to a separate tool message', () => {
    const out = anthropicToOpenAIRequest({
      model: 'm',
      messages: [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'toolu_1', name: 'ls', input: { path: '/tmp' } },
            { type: 'tool_use', id: 'toolu_2', name: 'pwd', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: [{ type: 'text', text: '/tmp' }, { type: 'text', text: 'ok' }],
            },
            { type: 'text', text: 'now summarize' },
          ],
        },
      ],
    });
    assert.deepStrictEqual(out.messages, [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [
          { id: 'toolu_1', type: 'function',
            function: { name: 'ls', arguments: '{"path":"/tmp"}' } },
          { id: 'toolu_2', type: 'function', function: { name: 'pwd', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'a.txt' },
      { role: 'tool', tool_call_id: 'toolu_2', content: '/tmp\nok' },
      { role: 'user', content: 'now summarize' },
    ]);
  });

  it('gives an assistant message that only calls a tool a null content', () => {
    const out = anthropicToOpenAIRequest({
      model: 'm',
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't', name: 'f', input: { a: 1 } }],
      }],
    });
    assert.strictEqual(out.messages[0].content, null);
    assert.strictEqual(out.messages[0].tool_calls.length, 1);
  });

  it('sends no user message when a user turn holds only tool results', () => {
    const out = anthropicToOpenAIRequest({
      model: 'm',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }],
      }],
    });
    assert.deepStrictEqual(out.messages, [{ role: 'tool', tool_call_id: 't', content: 'x' }]);
  });

  it('drops thinking blocks of earlier assistant turns', () => {
    const out = anthropicToOpenAIRequest({
      model: 'm',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 's' },
          { type: 'text', text: 'answer' },
        ],
      }],
    });
    assert.deepStrictEqual(out.messages, [{ role: 'assistant', content: 'answer' }]);
  });

  it('maps tools and each tool_choice variant', () => {
    const base = {
      model: 'm',
      messages: [],
      tools: [
        { name: 'ls', description: 'List files', input_schema: { type: 'object', properties: {} } },
        { name: 'bare', input_schema: { type: 'object', properties: { a: { type: 'string' } } } },
      ],
    };
    const noChoice = anthropicToOpenAIRequest(base);
    assert.deepStrictEqual(noChoice.tools, [
      { type: 'function', function: {
        name: 'ls', description: 'List files', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: {
        name: 'bare',
        parameters: { type: 'object', properties: { a: { type: 'string' } } } } },
    ]);
    assert.strictEqual('tool_choice' in noChoice, false);

    const cases = [
      [{ type: 'auto' }, 'auto'],
      [{ type: 'any' }, 'required'],
      [{ type: 'none' }, 'none'],
      [{ type: 'tool', name: 'ls' }, { type: 'function', function: { name: 'ls' } }],
    ];
    for (const [choice, expected] of cases) {
      const out = anthropicToOpenAIRequest({ ...base, tool_choice: choice });
      assert.deepStrictEqual(out.tool_choice, expected);
    }
    const serial = anthropicToOpenAIRequest({
      ...base, tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    });
    assert.strictEqual(serial.parallel_tool_calls, false);
  });

  it('omits tool_choice when there are no tools', () => {
    const out = anthropicToOpenAIRequest({
      model: 'm', messages: [], tool_choice: { type: 'auto' },
    });
    assert.strictEqual('tool_choice' in out, false);
    assert.strictEqual('tools' in out, false);
  });

  it('throws on a body or message of the wrong shape', () => {
    assert.throws(() => anthropicToOpenAIRequest(null), /JSON object/);
    assert.throws(() => anthropicToOpenAIRequest({ model: 'm' }), /messages/);
    assert.throws(() => anthropicToOpenAIRequest({ model: 'm', messages: [5] }), /role/);
    assert.throws(
      () => anthropicToOpenAIRequest({ model: 'm', messages: [{ role: 'user', content: 5 }] }),
      /content/,
    );
  });

  it('does not change its input', () => {
    const input = Object.freeze({
      model: 'm',
      system: 'x',
      messages: Object.freeze([{ role: 'user', content: 'hi' }]),
    });
    assert.doesNotThrow(() => anthropicToOpenAIRequest(input));
  });
});

describe('openAIToAnthropicResponse', () => {
  it('maps a text answer with usage', () => {
    const out = openAIToAnthropicResponse({
      id: 'chatcmpl-9',
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' },
        finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
    assert.deepStrictEqual(out, {
      id: 'chatcmpl-9',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 3 },
    });
  });

  it('maps tool calls to tool_use blocks, and omits empty text', () => {
    const out = openAIToAnthropicResponse({
      id: 'x',
      model: 'm',
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function',
              function: { name: 'ls', arguments: '{"path":"/tmp"}' } },
            { id: 'call_2', type: 'function', function: { name: 'pwd', arguments: '' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });
    assert.deepStrictEqual(out.content, [
      { type: 'tool_use', id: 'call_1', name: 'ls', input: { path: '/tmp' } },
      { type: 'tool_use', id: 'call_2', name: 'pwd', input: {} },
    ]);
    assert.strictEqual(out.stop_reason, 'tool_use');
    assert.deepStrictEqual(out.usage, { input_tokens: 0, output_tokens: 0 });
  });

  it('keeps text and tool calls together, text first', () => {
    const out = openAIToAnthropicResponse({
      model: 'm',
      choices: [{
        message: {
          content: 'Let me look.',
          tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    assert.deepStrictEqual(out.content.map((block) => block.type), ['text', 'tool_use']);
  });

  it('maps every finish_reason', () => {
    const cases = [
      ['stop', 'end_turn'], ['length', 'max_tokens'], ['tool_calls', 'tool_use'],
      ['content_filter', 'end_turn'], [null, 'end_turn'], [undefined, 'end_turn'],
    ];
    for (const [finish, expected] of cases) {
      const out = openAIToAnthropicResponse({
        model: 'm', choices: [{ message: { content: 'x' }, finish_reason: finish }],
      });
      assert.strictEqual(out.stop_reason, expected, String(finish));
    }
  });

  it('throws when there is no message or the arguments are not JSON', () => {
    assert.throws(() => openAIToAnthropicResponse({ choices: [] }), /no message/);
    assert.throws(() => openAIToAnthropicResponse(null), /no message/);
    assert.throws(() => openAIToAnthropicResponse({
      model: 'm',
      choices: [{
        message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{' } }] },
      }],
    }), /not valid JSON/);
  });
});

describe('createStreamTranslator', () => {
  it('translates a text answer in order', () => {
    const t = createStreamTranslator();
    const records = [
      ...t.push({ id: 'chatcmpl-1', model: 'm',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
      ...t.push(textChunk('Hel')),
      ...t.push(textChunk('lo')),
      ...t.push({ id: 'chatcmpl-1', model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ...t.push({ id: 'chatcmpl-1', model: 'm', choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 2 } }),
      ...t.end(),
    ];
    const events = parseEvents(records);
    assert.deepStrictEqual(events.map(([type]) => type), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    assert.deepStrictEqual(events[0][1].message, {
      id: 'chatcmpl-1', type: 'message', role: 'assistant', model: 'm', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    });
    assert.deepStrictEqual(events[1][1], {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    });
    assert.deepStrictEqual(events[2][1].delta, { type: 'text_delta', text: 'Hel' });
    assert.deepStrictEqual(events[3][1].delta, { type: 'text_delta', text: 'lo' });
    assert.deepStrictEqual(events[4][1], { type: 'content_block_stop', index: 0 });
    assert.deepStrictEqual(events[5][1], {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    });
    assert.deepStrictEqual(events[6][1], { type: 'message_stop' });
  });

  it('translates a tool call with argument fragments', () => {
    const t = createStreamTranslator();
    const chunk = (delta, finish) => ({
      id: 'c1', model: 'm', choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    });
    const records = [
      ...t.push(chunk({ role: 'assistant', content: null })),
      ...t.push(chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function',
        function: { name: 'ls', arguments: '' } }] })),
      ...t.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] })),
      ...t.push(chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"/"}' } }] })),
      ...t.push(chunk({}, 'tool_calls')),
      ...t.end(),
    ];
    const events = parseEvents(records);
    assert.deepStrictEqual(events.map(([type]) => type), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    assert.deepStrictEqual(events[1][1], {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_a', name: 'ls', input: {} },
    });
    assert.deepStrictEqual(events[2][1].delta, { type: 'input_json_delta', partial_json: '{"pa' });
    assert.deepStrictEqual(
      events[3][1].delta, { type: 'input_json_delta', partial_json: 'th":"/"}' },
    );
    const joined = events[2][1].delta.partial_json + events[3][1].delta.partial_json;
    assert.deepStrictEqual(JSON.parse(joined), { path: '/' });
    assert.strictEqual(events[5][1].delta.stop_reason, 'tool_use');
  });

  it('closes the text block before a tool block, and numbers the blocks', () => {
    const t = createStreamTranslator();
    const toolChunk = (index, id, name, args) => ({
      id: 'c', model: 'm',
      choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }],
    });
    const records = [
      ...t.push(textChunk('Looking.')),
      ...t.push(toolChunk(0, 'call_1', 'a', '{"x":1}')),
      ...t.push(toolChunk(1, 'call_2', 'b', '{}')),
      ...t.push({ id: 'c', model: 'm', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ...t.end(),
    ];
    const events = parseEvents(records);
    assert.deepStrictEqual(events.map(([type, data]) => `${type}:${data.index ?? ''}`), [
      'message_start:', 'content_block_start:0', 'content_block_delta:0', 'content_block_stop:0',
      'content_block_start:1', 'content_block_delta:1', 'content_block_stop:1',
      'content_block_start:2', 'content_block_delta:2', 'content_block_stop:2',
      'message_delta:', 'message_stop:',
    ]);
    assert.strictEqual(events[4][1].content_block.name, 'a');
    assert.strictEqual(events[7][1].content_block.name, 'b');
  });

  it('starts a tool block for a call that has no id', () => {
    const t = createStreamTranslator();
    const events = parseEvents(t.push({
      model: 'm',
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { name: 'f', arguments: '{}' } }] },
      }],
    }));
    assert.strictEqual(events[1][1].content_block.id, 'call_0');
  });

  it('puts the prompt token count of a first chunk in message_start', () => {
    const t = createStreamTranslator();
    const events = parseEvents(t.push(textChunk('a', { usage: { prompt_tokens: 5 } })));
    assert.strictEqual(events[0][1].message.usage.input_tokens, 5);
  });

  it('maps finish_reason length to max_tokens', () => {
    const t = createStreamTranslator();
    t.push(textChunk('a'));
    t.push({ choices: [{ delta: {}, finish_reason: 'length' }] });
    const events = parseEvents(t.end());
    const messageDelta = events.find(([type]) => type === 'message_delta');
    assert.strictEqual(messageDelta[1].delta.stop_reason, 'max_tokens');
  });

  it('gives a full valid stream even when nothing came, and end() twice is empty', () => {
    const t = createStreamTranslator();
    const events = parseEvents(t.end());
    assert.deepStrictEqual(events.map(([type]) => type), [
      'message_start', 'message_delta', 'message_stop',
    ]);
    assert.deepStrictEqual(t.end(), []);
    assert.deepStrictEqual(t.push(textChunk('late')), []);
  });

  it('ignores a chunk that is not an object', () => {
    const t = createStreamTranslator();
    assert.deepStrictEqual(t.push(null), []);
    assert.deepStrictEqual(t.push('x'), []);
  });
});
