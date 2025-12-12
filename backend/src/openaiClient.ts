import "dotenv/config";
import OpenAI from "openai";
import {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from "openai/resources/chat/completions";
import { FUNCTION_DEFINITIONS } from "./prompts";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("OPENAI_API_KEY is missing. Set it in your .env file.");
}

const openai = new OpenAI({
  apiKey
});

export async function callAssistant(
  messages: ChatCompletionMessageParam[]
) {
  const tools: ChatCompletionTool[] = FUNCTION_DEFINITIONS.map(tool => ({ ...tool }));

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages,
    tools,
    tool_choice: "auto"
  });

  return response;
}
