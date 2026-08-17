'use strict';

// Answers natural-language questions about insurance claims by giving the
// model a fixed toolset of safe aggregate queries (claimsAnalyticsTools.js)
// rather than letting it write its own SQL. See that file's header for why.

const Anthropic = require('@anthropic-ai/sdk');
const { TOOLS, runTool } = require('./claimsAnalyticsTools');

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const MODEL = 'claude-sonnet-5';
const MAX_TOOL_ROUNDS = 4;

async function askQuestion(question) {
  if (!isConfigured()) throw new Error('AI is not configured — set ANTHROPIC_API_KEY');

  const messages = [{ role: 'user', content: question }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: 'You are a data analyst answering questions about insurance claims for a South African '
        + 'rent-to-own delivery-bike platform, using ONLY the tools provided — you have no other access to '
        + 'the database and must not invent numbers. If a question cannot be answered with the available '
        + 'tools, say so plainly rather than guessing. Cite the actual figures the tools return in your answer.',
      messages,
      tools: TOOLS,
    });

    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason !== 'tool_use') {
      const textBlock = res.content.find((b) => b.type === 'text');
      return { answer: textBlock?.text || '', rounds: round + 1 };
    }

    const toolResults = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      try {
        const result = await runTool(block.name, block.input || {});
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      } catch (e) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${e.message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { answer: "I wasn't able to fully answer this within the available analysis steps — try narrowing the question.", rounds: MAX_TOOL_ROUNDS };
}

module.exports = { isConfigured, askQuestion };
