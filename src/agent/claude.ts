// The ONE place that talks to the Claude API (scripts/checks.sh enforces it).
// Pattern pre-existing from the author's earlier edge code: forced tool_use via
// tool_choice, strict Zod on the tool input, timeout on the call.
import { z } from "zod";

export const ANTHROPIC_MODEL = "claude-sonnet-5";
const ANTHROPIC_API_VERSION = "2023-06-01";
const MODEL_TIMEOUT_MS = 60_000;

export class ClaudeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ClaudeError";
  }
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
/** Any block we do not act on (thinking, redacted_thinking, future types): kept verbatim
 *  so it can be echoed back in the next turn (the API requires thinking + signature intact). */
export type OpaqueBlock = { type: string } & Record<string, unknown>;
export type ContentBlock =
  | { type: "text"; text: string }
  | ToolUseBlock
  | { type: "tool_result"; tool_use_id: string; content: string }
  | OpaqueBlock;

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

const ResponseSchema = z.object({
  stop_reason: z.string().nullable(),
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
      // thinking / redacted_thinking / unknown: never read, never dropped (passthrough keeps `signature`).
      z.object({ type: z.string().refine((t) => t !== "text" && t !== "tool_use") }).passthrough(),
    ]),
  ),
});
export type ClaudeResponse = z.infer<typeof ResponseSchema>;

export interface AskClaudeInput {
  system: string;
  messages: ClaudeMessage[];
  tools?: ToolDef[];
  toolChoice?: { type: "tool"; name: string } | { type: "auto" };
  maxTokens: number;
}

export async function askClaude(
  fetchImpl: typeof fetch,
  apiKey: string,
  input: AskClaudeInput,
): Promise<ClaudeResponse> {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: input.messages,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.toolChoice ? { tool_choice: input.toolChoice } : {}),
    }),
  });
  if (!res.ok) throw new ClaudeError("claude call failed", res.status);
  return ResponseSchema.parse(await res.json());
}
