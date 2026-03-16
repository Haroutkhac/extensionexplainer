// Extension Explainer - Background Service Worker
// Handles AI API calls (Claude / Ollama), streams responses to content script,
// and manages the user's knowledge profile.

const DEFAULT_SETTINGS = {
  provider: "claude",
  apiKey: "",
  model: "claude-sonnet-4-20250514",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "llama3.2",
  maxTokens: 500,
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
  if (entries.length === 0) {
    return "The user has not looked up any topics yet. Assume they are a general audience reader.";
  }

  // Group topics by confidence band
  const familiar = []; // confidence >= 0.5
  const learning = []; // 0.2 <= confidence < 0.5
  const novice = [];   // confidence < 0.2

  for (const [topic, data] of entries) {
    if (data.confidence >= 0.5) {
      familiar.push(topic);
    } else if (data.confidence >= 0.2) {
      learning.push(topic);
    } else {
      novice.push(topic);
    }
  }

  const parts = [];
  if (familiar.length > 0) {
    parts.push(
      `The user is fairly familiar with: ${familiar.join(", ")}. You can use these terms without much explanation.`
    );
  }
  if (learning.length > 0) {
    parts.push(
      `The user is currently learning about: ${learning.join(", ")}. Give brief clarifications when referencing these.`
    );
  }
  if (novice.length > 0) {
    parts.push(
      `The user is new to: ${novice.join(", ")}. Explain these from scratch when relevant.`
    );
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt construction
// ---------------------------------------------------------------------------

function buildSystemPrompt(knowledgeContext) {
  return `You are a concise, contextual explainer. The user highlighted text on a web page and wants a quick explanation so they can keep reading without going down a rabbit hole.

Rules:
- Lead with a 1-2 sentence explanation of what the highlighted text means IN THE CONTEXT of the page
- If helpful, add a brief "Why it matters here:" line
- Include 1-2 markdown links for deeper reading (Wikipedia, MDN, official docs, etc) when relevant
- Keep total response under 100 words for simple concepts, under 200 for complex ones
- Use bold for key terms, but keep formatting minimal
- Never start with "Sure!" or "Great question!" - just explain directly
- Adjust depth based on the user's knowledge profile

${knowledgeContext}`;
}

// ---------------------------------------------------------------------------
// User message construction
// ---------------------------------------------------------------------------

function buildUserMessage(selectedText, pageContext) {
  let message = `Explain this highlighted text: "${selectedText}"`;

  if (pageContext) {
    const ctx = [];
    if (pageContext.title) ctx.push(`Page title: ${pageContext.title}`);
    if (pageContext.url) ctx.push(`URL: ${pageContext.url}`);
    if (pageContext.metaDescription)
      ctx.push(`Page description: ${pageContext.metaDescription}`);
    if (pageContext.headings && pageContext.headings.length > 0)
      ctx.push(`Nearby headings: ${pageContext.headings.join(" > ")}`);
    if (pageContext.surroundingText)
      ctx.push(`Surrounding paragraph: ${pageContext.surroundingText}`);

    if (ctx.length > 0) {
      message += `\n\nPage context:\n${ctx.join("\n")}`;
    }
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
    system: systemPrompt,
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
    // Append the new follow-up message with page context for grounding
    let followupContent = msg.message;
    if (msg.pageContext) {
      const ctx = [];
      if (msg.pageContext.title) ctx.push(`Page: ${msg.pageContext.title}`);
      if (msg.pageContext.url) ctx.push(`URL: ${msg.pageContext.url}`);
      if (ctx.length > 0) {
        followupContent += `\n\n(Context: ${ctx.join(", ")})`;
      }
    }
    messages.push({ role: "user", content: followupContent });
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
