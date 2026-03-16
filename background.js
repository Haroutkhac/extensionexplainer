// Extension Explainer - Background Service Worker
// Handles AI API calls (Claude / Ollama), streams responses to content script,
// and manages the user's knowledge profile.

const DEFAULT_SETTINGS = {
  provider: "claude",
  apiKey: "",
  model: "claude-sonnet-4-20250514",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "llama3.2",
  maxTokens: 150,
  temperature: 0.3,
};

// ---------------------------------------------------------------------------
// Settings & Knowledge Profile helpers
// ---------------------------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function getKnowledgeProfile() {
  const { knowledgeProfile } = await chrome.storage.local.get({
    knowledgeProfile: {},
  });
  return knowledgeProfile;
}

async function saveKnowledgeProfile(profile) {
  await chrome.storage.local.set({ knowledgeProfile: profile });
}

// ---------------------------------------------------------------------------
// Knowledge profile context builder
// ---------------------------------------------------------------------------

function buildKnowledgeContext(profile) {
  const entries = Object.entries(profile);
  if (entries.length === 0) return "";

  // Only include the 10 most recent topics to keep context small
  const recent = entries
    .sort((a, b) => (b[1].lastSeen || "").localeCompare(a[1].lastSeen || ""))
    .slice(0, 10);

  const familiar = recent.filter(([, d]) => d.confidence >= 0.5).map(([t]) => t);
  const learning = recent.filter(([, d]) => d.confidence >= 0.2 && d.confidence < 0.5).map(([t]) => t);

  const parts = [];
  if (familiar.length > 0) parts.push(`Knows: ${familiar.join(", ")}`);
  if (learning.length > 0) parts.push(`Learning: ${learning.join(", ")}`);
  return parts.length > 0 ? `\nUser profile: ${parts.join(". ")}` : "";
}

// ---------------------------------------------------------------------------
// System prompt construction
// ---------------------------------------------------------------------------

function buildSystemPrompt(knowledgeContext) {
  return `You explain highlighted text so the user can keep reading the page they're on. Answer ONLY what's needed to understand this term in this specific context — nothing more.

1-3 sentences max. No greetings, no filler, no "Why it matters" sections. If the surrounding text already implies something, don't repeat it. Skip links unless the user asks.${knowledgeContext}`;
}

// ---------------------------------------------------------------------------
// User message construction
// ---------------------------------------------------------------------------

function buildUserMessage(selectedText, pageContext) {
  // Keep the user message lean — only include what helps the LLM
  // understand the context. URL and meta description are noise.
  let message = `"${selectedText}"`;

  if (pageContext) {
    const ctx = [];
    if (pageContext.title) ctx.push(`Page: ${pageContext.title}`);
    if (pageContext.headings && pageContext.headings.length > 0)
      ctx.push(`Section: ${pageContext.headings.slice(-2).join(" > ")}`);
    if (pageContext.surroundingText) {
      // Limit to 300 chars to reduce input tokens
      let surrounding = pageContext.surroundingText;
      if (surrounding.length > 300) {
        surrounding = surrounding.substring(0, 300).trimEnd() + "\u2026";
      }
      ctx.push(`Around it: ${surrounding}`);
    }
    if (ctx.length > 0) message += `\n${ctx.join("\n")}`;
  }

  return message;
}

// ---------------------------------------------------------------------------
// Knowledge profile update
// ---------------------------------------------------------------------------

async function updateKnowledgeProfile(selectedText) {
  const profile = await getKnowledgeProfile();

  // Extract the topic: use the selected text directly if short,
  // otherwise take the first meaningful phrase (up to ~60 chars).
  let topic = selectedText.trim().toLowerCase();
  if (topic.length > 60) {
    // Take the first clause / sentence fragment
    const cut = topic.substring(0, 60);
    const lastSpace = cut.lastIndexOf(" ");
    topic = lastSpace > 20 ? cut.substring(0, lastSpace) : cut;
  }

  if (!topic) return;

  const existing = profile[topic] || { confidence: 0, lookups: 0 };
  existing.lookups += 1;
  existing.lastSeen = new Date().toISOString();
  // Confidence grows with lookups but caps at 0.8
  existing.confidence = Math.min(0.8, existing.lookups * 0.15);
  profile[topic] = existing;

  await saveKnowledgeProfile(profile);
}

// ---------------------------------------------------------------------------
// Claude streaming
// ---------------------------------------------------------------------------

async function streamClaude(settings, systemPrompt, messages, port) {
  if (!settings.apiKey) {
    port.postMessage({ type: "error", message: "Anthropic API key not set. Open the extension options to configure it." });
    return;
  }

  const body = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    temperature: settings.temperature,
    stream: true,
    // Use structured system prompt with cache_control for prompt caching.
    // The system prompt is stable across requests, so caching saves input tokens.
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages,
  };

  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("Extension Explainer: network error calling Claude API", err);
    port.postMessage({ type: "error", message: "Network error reaching Claude API. Check your connection." });
    return;
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.json();
      detail = errBody.error?.message || JSON.stringify(errBody);
    } catch {
      detail = response.statusText;
    }
    const msg =
      response.status === 401
        ? "Invalid Anthropic API key. Check your settings."
        : `Claude API error (${response.status}): ${detail}`;
    console.error("Extension Explainer:", msg);
    port.postMessage({ type: "error", message: msg });
    return;
  }

  // Read SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines from buffer
      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        if (event.type === "content_block_delta" && event.delta?.text) {
          fullText += event.delta.text;
          try {
            port.postMessage({ type: "chunk", text: event.delta.text });
          } catch {
            // Port disconnected mid-stream; abort reading
            reader.cancel();
            return;
          }
        }

        if (event.type === "message_stop") {
          break;
        }
      }
    }
  } catch (err) {
    console.error("Extension Explainer: error reading Claude stream", err);
    port.postMessage({ type: "error", message: "Error reading response stream." });
    return;
  }

  try {
    port.postMessage({ type: "done", fullText });
  } catch {
    // Port already disconnected
  }
}

// ---------------------------------------------------------------------------
// Ollama streaming
// ---------------------------------------------------------------------------

async function streamOllama(settings, systemPrompt, messages, port) {
  const ollamaMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const body = {
    model: settings.ollamaModel,
    messages: ollamaMessages,
    stream: true,
  };

  let response;
  try {
    response = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("Extension Explainer: network error calling Ollama", err);
    port.postMessage({
      type: "error",
      message: `Cannot reach Ollama at ${settings.ollamaUrl}. Is it running?`,
    });
    return;
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = response.statusText;
    }
    console.error("Extension Explainer: Ollama error", detail);
    port.postMessage({
      type: "error",
      message: `Ollama error (${response.status}): ${detail}`,
    });
    return;
  }

  // Read NDJSON stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (parsed.message?.content) {
          fullText += parsed.message.content;
          try {
            port.postMessage({ type: "chunk", text: parsed.message.content });
          } catch {
            reader.cancel();
            return;
          }
        }

        if (parsed.done) {
          break;
        }
      }
    }
  } catch (err) {
    console.error("Extension Explainer: error reading Ollama stream", err);
    port.postMessage({ type: "error", message: "Error reading Ollama response stream." });
    return;
  }

  try {
    port.postMessage({ type: "done", fullText });
  } catch {
    // Port already disconnected
  }
}

// ---------------------------------------------------------------------------
// Request handler (shared by "explain" and "followup" actions)
// ---------------------------------------------------------------------------

async function handleRequest(msg, port) {
  const settings = await getSettings();
  const profile = await getKnowledgeProfile();
  const knowledgeContext = buildKnowledgeContext(profile);
  const systemPrompt = buildSystemPrompt(knowledgeContext);

  // Build the messages array
  let messages = [];

  if (msg.action === "explain") {
    const userContent = buildUserMessage(msg.selectedText, msg.pageContext);
    messages = [{ role: "user", content: userContent }];
  } else if (msg.action === "followup") {
    // Carry forward conversation history from the content script
    if (Array.isArray(msg.conversationHistory) && msg.conversationHistory.length > 0) {
      messages = [...msg.conversationHistory];
    }
    // Follow-ups don't need page context again — it's in the conversation history
    messages.push({ role: "user", content: msg.message });
  }

  // Dispatch to the appropriate provider
  if (settings.provider === "ollama") {
    await streamOllama(settings, systemPrompt, messages, port);
  } else {
    await streamClaude(settings, systemPrompt, messages, port);
  }

  // Update knowledge profile after a successful explanation
  if (msg.action === "explain" && msg.selectedText) {
    try {
      await updateKnowledgeProfile(msg.selectedText);
    } catch (err) {
      console.error("Extension Explainer: failed to update knowledge profile", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Port connection listener
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "explain") return;

  let disconnected = false;

  port.onDisconnect.addListener(() => {
    disconnected = true;
  });

  port.onMessage.addListener((msg) => {
    if (disconnected) return;

    if (msg.action === "explain" || msg.action === "followup") {
      // Wrap the port to silently swallow postMessage errors after disconnect
      const safePort = {
        postMessage(data) {
          if (disconnected) return;
          try {
            port.postMessage(data);
          } catch (err) {
            console.warn("Extension Explainer: port disconnected, dropping message");
            disconnected = true;
          }
        },
      };

      handleRequest(msg, safePort).catch((err) => {
        console.error("Extension Explainer: unhandled error in handleRequest", err);
        safePort.postMessage({
          type: "error",
          message: "An unexpected error occurred. Check the service worker console for details.",
        });
      });
    }
  });
});
