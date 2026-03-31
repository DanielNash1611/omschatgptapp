import "dotenv/config";
import OpenAI from "openai";
import {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from "openai/resources/chat/completions";
import { FUNCTION_DEFINITIONS } from "./prompts";

let openai: OpenAI | null = null;

const getClient = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing. Set it in your .env file.");
  }

  if (!openai) {
    openai = new OpenAI({ apiKey });
  }

  return openai;
};

export async function callAssistant(
  messages: ChatCompletionMessageParam[]
) {
  const tools: ChatCompletionTool[] = FUNCTION_DEFINITIONS.map(tool => ({ ...tool }));
  const client = getClient();

  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages,
    tools,
    tool_choice: "auto"
  });

  return response;
}
