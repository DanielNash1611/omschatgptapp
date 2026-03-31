import { FormEvent, useMemo, useState } from "react";
import { deriveOmsToolUi, OmsToolUiCard } from "./omsToolUi";

// Frontend quickstart:
// 1) cd frontend
// 2) npm install
// 3) npm run dev
// 4) Open http://localhost:5173

const API_BASE =
  import.meta.env.VITE_BACKEND_URL ??
  (import.meta.env.DEV ? "http://localhost:3001" : undefined);

if (!API_BASE) {
  throw new Error("Missing VITE_BACKEND_URL in production build");
}

console.log("API_BASE:", API_BASE);

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolResult?: unknown;
};

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const placeholder = useMemo(
    () =>
      "Ask about an order, e.g. \"Where is order 1002?\" or \"Cancel order 1002\".",
    []
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: input.trim()
    };
    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage.content })
      });

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = await response.json();
      const assistantText =
        typeof data.assistantMessage === "string"
          ? data.assistantMessage
          : "Sorry, I could not generate a response right now.";

      const assistantMessage: ChatMessage = {
        id: createId(),
        role: "assistant",
        content: assistantText,
        toolResult: data.toolResult ?? data.debug?.toolResult
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error(error);
      const assistantMessage: ChatMessage = {
        id: createId(),
        role: "assistant",
        content: "Something went wrong. Please try again or check the backend."
      };
      setMessages(prev => [...prev, assistantMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="hero">
        <div>
          <p className="eyebrow">OMS assistant prototype</p>
          <h1>OMS ChatGPT Mock Assistant</h1>
          <p className="lede">
            Ask natural questions to check order status or request a
            cancellation. Everything runs against mock OMS data so you can swap
            in real APIs later.
          </p>
        </div>
        <div className="quickstart">
          <p className="quickstart-title">Run locally</p>
          <ol>
            <li>Backend: cd backend · npm install · npm run dev</li>
            <li>Frontend: cd frontend · npm install · npm run dev</li>
          </ol>
          <p className="quickstart-note">
            Backend listens on http://localhost:3001 · Frontend on
            http://localhost:5173
          </p>
        </div>
      </div>

      <main className="app">
        <section className="chat-window" aria-live="polite">
          {messages.map(message => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {isLoading && (
            <div className="message message--assistant">
              <span className="message-author">Assistant</span>
              <p className="message-text">Thinking...</p>
            </div>
          )}
        </section>

        <form className="chat-input" onSubmit={handleSubmit}>
          <label htmlFor="chat-input" className="sr-only">
            Chat message
          </label>
          <textarea
            id="chat-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={placeholder}
            rows={3}
          />
          <div className="actions">
            <button type="submit" disabled={!input.trim() || isLoading}>
              {isLoading ? "Sending..." : "Send"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const toolUi =
    message.role === "assistant" ? deriveOmsToolUi(message.toolResult) : null;
  const hasVisual = toolUi !== null;

  return (
    <div
      className={`message message--${message.role}${hasVisual ? " message--visual" : ""}`}
    >
      <span className="message-author">
        {message.role === "user" ? "You" : "Assistant"}
      </span>
      {toolUi ? (
        <div className="message-visual">
          <OmsToolUiCard ui={toolUi} />
        </div>
      ) : null}
      {message.content ? <p className="message-text">{message.content}</p> : null}
    </div>
  );
}

export default App;
