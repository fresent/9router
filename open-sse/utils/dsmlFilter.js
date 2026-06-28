/**
 * DSML (DeepSeek Markup Language) Artifact Handler
 *
 * DeepSeek models emit tool-call blocks as text/reasoning content
 * using fullwidth pipe (U+FF5C |) delimiters instead of proper
 * structured tool_calls. These blocks span multiple streaming chunks.
 *
 * Strategy: Convert DSML tool calls into real OpenAI tool_calls and
 * set finish_reason="tool_calls" so clients execute them instead of stopping.
 * DSML blocks are stripped from text content and from reasoning content.
 */

import { COLORS } from "./usageTracking.js";

// ── Patterns ────────────────────────────────────────────────────────────────

const FF5C = /\uFF5C/;
const SUFFIX_RE = /\uFF5C[\s\S]*$/u;

const OPEN_TC_RE = /<[^>]*tool_calls[^>]*>/i;
const CLOSE_TC_RE = /<\/[^>]*tool_calls[^>]*>/i;
const BLOCK_RE = /<[^>]*tool_calls[^>]*>[\s\S]*?<\/[^>]*tool_calls[^>]*>/gi;

const INVOKE_OPEN_RE = /<[^>]*invoke[^>]*\s+name\s*=\s*["']([^"']+)["'][^>]*>/i;
const PARAM_RE = /<[^>]*parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/[^>]*parameter[^>]*>/ig;
const INVOKE_CLOSE_RE = /<\/[^>]*invoke[^>]*>/i;

// ── Detection ────────────────────────────────────────────────────────────────

export function hasDsmlMarker(text) {
  return typeof text === "string" && text.length > 0 && FF5C.test(text);
}

export function hasXmlToolCallText(text) {
  if (typeof text !== "string") return false;
  return /<tool_calls?[^>]*>[\s\S]*?<invoke\s+name=/i.test(text);
}

function isContaminated(text) {
  return hasDsmlMarker(text) || hasXmlToolCallText(text);
}

// ── DSML Parser ─────────────────────────────────────────────────────────────

export function parseDsmlBlock(blockText) {
  if (!blockText || typeof blockText !== "string") return [];

  const toolCalls = [];
  let callIndex = 0;
  let match;

  const re = new RegExp(INVOKE_OPEN_RE.source, "gi");
  while ((match = re.exec(blockText)) !== null) {
    const toolName = match[1];
    const afterOpenTag = re.lastIndex;

    const closeRe = new RegExp(INVOKE_CLOSE_RE.source, "gi");
    closeRe.lastIndex = afterOpenTag;
    const closeMatch = closeRe.exec(blockText);
    if (!closeMatch) break;

    const invokeContent = blockText.slice(afterOpenTag, closeMatch.index);

    const args = {};
    let paramMatch;
    const paramRe = new RegExp(PARAM_RE.source, "gi");
    while ((paramMatch = paramRe.exec(invokeContent)) !== null) {
      args[paramMatch[1]] = coerceParam(paramMatch[2].trim());
    }

    toolCalls.push({
      index: callIndex,
      id: "call_dsml_" + callIndex + "_" + Date.now(),
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(args)
      }
    });
    callIndex++;
    re.lastIndex = closeMatch.index + closeMatch[0].length;
  }
  return toolCalls;
}

function coerceParam(value) {
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== "") return num;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

// ── Text cleaners ───────────────────────────────────────────────────────────

export function stripDsmlSuffix(text) {
  if (typeof text !== "string") return text;
  return text.replace(SUFFIX_RE, "").trimEnd();
}

export function stripDsmlBlocks(text) {
  if (typeof text !== "string") return text;
  return text.replace(BLOCK_RE, "").trimEnd();
}

export function cleanDsmlText(text) {
  return stripDsmlSuffix(stripDsmlBlocks(text));
}

// ── Stateful stream filter ─────────────────────────────────────────────────

export function createDsmlStreamFilter() {
  let buf = "";
  let blocked = false;
  let accumulatedBlock = "";
  let pendingToolCalls = null;

  function feed(deltaContent, deltaReasoning) {
    let outContent = deltaContent;
    let outReasoning = deltaReasoning;
    pendingToolCalls = null;

    // Clean text content (suffix-only, no state needed)
    if (typeof outContent === "string" && outContent.length > 0 && isContaminated(outContent)) {
      const before = outContent.length;
      outContent = stripDsmlSuffix(outContent);
      console.log(COLORS.yellow + "[DSML] text content (" + (before - outContent.length) + " chars)" + COLORS.reset);
    }

    // Clean reasoning_content (stateful)
    if (typeof deltaReasoning === "string" && deltaReasoning.length > 0) {
      buf += deltaReasoning;

      if (blocked) {
        accumulatedBlock += deltaReasoning;

        const cm = buf.match(CLOSE_TC_RE);
        if (cm) {
          // Parse the complete DSML block into tool calls
          pendingToolCalls = parseDsmlBlock(accumulatedBlock);
          if (pendingToolCalls && pendingToolCalls.length > 0) {
            const names = pendingToolCalls.map(function(t) { return t.function.name; }).join(", ");
            console.log(COLORS.yellow + "[DSML] converted " + pendingToolCalls.length + " tool call(s) (" + names + ")" + COLORS.reset);
          }
          // Strip the DSML block from reasoning
          accumulatedBlock = "";
          buf = "";
          blocked = false;
          outReasoning = null;
        } else {
          outReasoning = null;
        }
      } else {
        const om = buf.match(OPEN_TC_RE);
        if (om) {
          const safe = buf.slice(0, om.index);
          accumulatedBlock = buf.slice(om.index);
          buf = buf.slice(om.index);
          blocked = true;
          outReasoning = safe.length > 0 ? safe : null;

          const cm = buf.match(CLOSE_TC_RE);
          if (cm) {
            pendingToolCalls = parseDsmlBlock(accumulatedBlock);
            if (pendingToolCalls && pendingToolCalls.length > 0) {
              const names = pendingToolCalls.map(function(t) { return t.function.name; }).join(", ");
              console.log(COLORS.yellow + "[DSML] converted " + pendingToolCalls.length + " tool call(s) (" + names + ")" + COLORS.reset);
            }
            accumulatedBlock = "";
            const after = buf.slice(cm.index + cm[0].length);
            buf = "";
            blocked = false;
            outReasoning = (outReasoning || "") + after;
          }
        }
      }
    }

    if (pendingToolCalls && pendingToolCalls.length > 0) {
      return { content: outContent, reasoning: outReasoning, toolCalls: pendingToolCalls };
    }
    if ((!outContent || outContent === "") && (!outReasoning || outReasoning === "")) {
      return null;
    }
    return { content: outContent, reasoning: outReasoning, toolCalls: null };
  }

  function flush() {
    const cleaned = buf.length > 0 && isContaminated(buf) ? stripDsmlBlocks(stripDsmlSuffix(buf)) : buf;
    if (cleaned.length < buf.length) {
      console.log(COLORS.yellow + "[DSML] flush stripped (" + (buf.length - cleaned.length) + " chars)" + COLORS.reset);
    }
    buf = "";
    blocked = false;
    return { content: null, reasoning: cleaned.length > 0 ? cleaned : null, toolCalls: null, totalStripped: 0 };
  }

  return { feed: feed, flush: flush };
}

// ── Non-streaming message cleaner ───────────────────────────────────────────

export function cleanOpenAIMessage(message) {
  if (!message) return message;
  const cleaned = Object.assign({}, message);

  if (typeof message.content === "string" && isContaminated(message.content)) {
    cleaned.content = stripDsmlSuffix(message.content);
    console.log(COLORS.yellow + "[DSML] non-streaming content (" + (message.content.length - cleaned.content.length) + " chars)" + COLORS.reset);
  }
  if (typeof message.reasoning_content === "string" && isContaminated(message.reasoning_content)) {
    // Extract DSML tool calls into proper tool_calls
    const dsmlBlocks = message.reasoning_content.match(BLOCK_RE);
    if (dsmlBlocks && dsmlBlocks.length > 0) {
      var allToolCalls = [];
      for (var bi = 0; bi < dsmlBlocks.length; bi++) {
        var parsed = parseDsmlBlock(dsmlBlocks[bi]);
        allToolCalls = allToolCalls.concat(parsed);
      }
      if (allToolCalls.length > 0) {
        cleaned.tool_calls = allToolCalls.map(function(tc, i) {
          return {
            id: tc.id || "call_dsml_" + i + "_" + Date.now(),
            type: "function",
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments
            }
          };
        });
        var toolNames = allToolCalls.map(function(tc) { return tc.function.name; }).join(", ");
        console.log(COLORS.yellow + "[DSML] non-streaming: extracted " + allToolCalls.length + " tool call(s) (" + toolNames + ")" + COLORS.reset);
      }
    }
    // Strip DSML blocks from reasoning
    var before = message.reasoning_content.length;
    cleaned.reasoning_content = stripDsmlBlocks(stripDsmlSuffix(message.reasoning_content));
    if (cleaned.reasoning_content.length < before) {
      console.log(COLORS.yellow + "[DSML] non-streaming reasoning (" + (before - cleaned.reasoning_content.length) + " chars)" + COLORS.reset);
    }
  }

  return cleaned;
}
