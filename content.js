(function () {
  "use strict";

  // Prevent duplicate injection
  if (document.getElementById("extension-explainer-host")) return;
  // Skip extension's own pages
  if (location.protocol === "chrome-extension:" || location.protocol === "moz-extension:") return;

  // ─── State ───────────────────────────────────────────────────────────
  let port = null;
  let conversationHistory = [];
  let selectedText = "";
  let pageContext = null;
  let isLoading = false;
  let isMinimized = false;
  let streamBuffer = "";
  let activeStreamEl = null;
  let typingIndicator = null;
  let dragState = null;

  // ─── Shadow DOM Setup ────────────────────────────────────────────────
  const host = document.createElement("div");
  host.id = "extension-explainer-host";
  host.style.cssText = "all:initial;position:absolute;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });

  const darkMQ = window.matchMedia("(prefers-color-scheme: dark)");

  // ─── Styles ──────────────────────────────────────────────────────────
  const styleEl = document.createElement("style");
  styleEl.textContent = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
.ee-explain-btn {
  position: fixed; z-index: 2147483647; background: #2563eb; color: white;
  border: none; border-radius: 8px; padding: 6px 14px; font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-weight: 500; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  display: none; align-items: center; gap: 4px;
  transition: opacity 150ms ease, transform 150ms ease;
  opacity: 0; transform: translateY(4px); user-select: none; line-height: 1;
  pointer-events: auto;
}
.ee-explain-btn.visible { display: flex; opacity: 1; transform: translateY(0); }
.ee-explain-btn:hover { background: #1d4ed8; }
.ee-panel {
  position: fixed; z-index: 2147483647; width: 400px; max-height: 500px;
  border-radius: 12px; overflow: hidden; display: none; flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  pointer-events: auto; transition: opacity 150ms ease, transform 150ms ease;
  opacity: 0; transform: scale(0.95);
  background: #fff; border: 1px solid #e5e7eb; color: #1a1a1a;
  box-shadow: 0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08);
}
.ee-panel.visible { display: flex; opacity: 1; transform: scale(1); }
.ee-panel.minimized .ee-panel-body, .ee-panel.minimized .ee-panel-input-area { display: none; }
.ee-panel.minimized { max-height: none; }
.ee-panel.dark { background: #1f2937; color: #f3f4f6; border-color: #374151; }
.ee-panel.dark .ee-panel-header { background: #111827; border-bottom-color: #374151; }
.ee-panel.dark .ee-quote { background: #1e3a5f; border-left-color: #3b82f6; color: #d1d5db; }
.ee-panel.dark .ee-panel-input-area { border-top-color: #374151; }
.ee-panel.dark .ee-input { background: #374151; color: #f3f4f6; border-color: #4b5563; }
.ee-panel.dark .ee-input::placeholder { color: #9ca3af; }
.ee-panel.dark .ee-msg-user { background: #1e40af; }
.ee-panel.dark .ee-msg-ai { color: #e5e7eb; }
.ee-panel.dark .ee-msg-ai code { background: #374151; }
.ee-panel.dark .ee-msg-ai a { color: #60a5fa; }
.ee-panel.dark .ee-header-btn { color: #9ca3af; }
.ee-panel.dark .ee-header-btn:hover { color: #f3f4f6; background: #374151; }
.ee-panel.dark .ee-error { background: #7f1d1d; color: #fca5a5; border-left-color: #dc2626; }
.ee-panel.dark .ee-divider { background: #374151; }
.ee-panel.dark .ee-panel-body::-webkit-scrollbar-thumb { background: #4b5563; }
.ee-panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; background: #f8fafc; border-bottom: 1px solid #e5e7eb;
  cursor: grab; user-select: none; flex-shrink: 0;
}
.ee-panel-header:active { cursor: grabbing; }
.ee-panel-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.ee-header-actions { display: flex; gap: 2px; }
.ee-header-btn {
  background: none; border: none; cursor: pointer; width: 28px; height: 28px;
  border-radius: 6px; display: flex; align-items: center; justify-content: center;
  font-size: 16px; color: #6b7280; transition: background 100ms ease, color 100ms ease; line-height: 1;
}
.ee-header-btn:hover { background: #e5e7eb; color: #1a1a1a; }
.ee-panel-body { flex: 1; overflow-y: auto; padding: 14px; min-height: 60px; max-height: 370px; }
.ee-panel-body::-webkit-scrollbar { width: 6px; }
.ee-panel-body::-webkit-scrollbar-track { background: transparent; }
.ee-panel-body::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
.ee-quote {
  background: #eff6ff; border-left: 3px solid #2563eb; padding: 8px 12px;
  font-style: italic; font-size: 13px; line-height: 1.5; margin-bottom: 12px;
  border-radius: 0 6px 6px 0; word-break: break-word; color: #374151;
}
.ee-messages { display: flex; flex-direction: column; gap: 10px; }
.ee-msg-ai { font-size: 14px; line-height: 1.6; color: #1a1a1a; }
.ee-msg-ai p { margin-bottom: 8px; }
.ee-msg-ai p:last-child { margin-bottom: 0; }
.ee-msg-ai strong { font-weight: 600; }
.ee-msg-ai em { font-style: italic; }
.ee-msg-ai code {
  background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
}
.ee-msg-ai a { color: #2563eb; text-decoration: underline; text-underline-offset: 2px; }
.ee-msg-user {
  align-self: flex-end; background: #2563eb; color: white; padding: 8px 12px;
  border-radius: 12px 12px 4px 12px; font-size: 14px; line-height: 1.5;
  max-width: 85%; word-break: break-word;
}
.ee-divider { height: 1px; background: #e5e7eb; margin: 4px 0; }
.ee-typing { display: flex; gap: 4px; padding: 4px 0; align-items: center; }
.ee-typing-dot {
  width: 6px; height: 6px; background: #94a3b8; border-radius: 50%;
  animation: ee-pulse 1.2s ease-in-out infinite;
}
.ee-typing-dot:nth-child(2) { animation-delay: 0.15s; }
.ee-typing-dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes ee-pulse {
  0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
  30% { opacity: 1; transform: scale(1); }
}
.ee-error {
  background: #fef2f2; border-left: 3px solid #ef4444; padding: 8px 12px;
  font-size: 13px; line-height: 1.5; border-radius: 0 6px 6px 0; color: #991b1b;
}
.ee-panel-input-area {
  display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid #e5e7eb; flex-shrink: 0;
}
.ee-input {
  flex: 1; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 12px;
  font-size: 13px; font-family: inherit; resize: none; outline: none;
  line-height: 1.4; min-height: 36px; max-height: 80px;
  background: #fff; color: #1a1a1a; transition: border-color 150ms ease;
}
.ee-input:focus { border-color: #2563eb; }
.ee-input:disabled { opacity: 0.5; cursor: not-allowed; }
.ee-send-btn {
  background: #2563eb; color: white; border: none; border-radius: 8px;
  padding: 0 14px; font-size: 13px; font-weight: 500; cursor: pointer;
  font-family: inherit; white-space: nowrap; transition: background 100ms ease; flex-shrink: 0;
}
.ee-send-btn:hover { background: #1d4ed8; }
.ee-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ee-more-btn {
  background: none; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px 12px;
  font-size: 12px; font-family: inherit; color: #6b7280; cursor: pointer;
  transition: border-color 100ms ease, color 100ms ease; margin-top: 6px; display: inline-flex; align-items: center; gap: 4px;
}
.ee-more-btn:hover { border-color: #2563eb; color: #2563eb; }
.ee-more-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ee-more-btn kbd {
  font-size: 10px; background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 3px;
  padding: 0 4px; font-family: inherit; line-height: 1.6;
}
.ee-panel.dark .ee-more-btn { border-color: #4b5563; color: #9ca3af; }
.ee-panel.dark .ee-more-btn:hover { border-color: #60a5fa; color: #60a5fa; }
.ee-panel.dark .ee-more-btn kbd { background: #374151; border-color: #4b5563; }
`;
  shadow.appendChild(styleEl);

  // ─── Explain Button ──────────────────────────────────────────────────
  const explainBtn = document.createElement("button");
  explainBtn.className = "ee-explain-btn";
  explainBtn.innerHTML = "\u{1F4D6} Explain";
  shadow.appendChild(explainBtn);

  explainBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
  explainBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onExplainClick(); });

  // ─── Chat Panel ──────────────────────────────────────────────────────
  const panel = document.createElement("div");
  panel.className = "ee-panel";
  panel.innerHTML = `
    <div class="ee-panel-header">
      <span class="ee-panel-title">\u{1F4D6} Explainer</span>
      <div class="ee-header-actions">
        <button class="ee-header-btn ee-minimize-btn" title="Minimize">\u2014</button>
        <button class="ee-header-btn ee-close-btn" title="Close">\u00D7</button>
      </div>
    </div>
    <div class="ee-panel-body">
      <div class="ee-quote"></div>
      <div class="ee-messages"></div>
    </div>
    <div class="ee-panel-input-area">
      <textarea class="ee-input" placeholder="Ask a follow-up\u2026" rows="1"></textarea>
      <button class="ee-send-btn">Send</button>
    </div>`;
  shadow.appendChild(panel);

  const panelHeader = panel.querySelector(".ee-panel-header");
  const minimizeBtn = panel.querySelector(".ee-minimize-btn");
  const closeBtn = panel.querySelector(".ee-close-btn");
  const panelBody = panel.querySelector(".ee-panel-body");
  const quoteEl = panel.querySelector(".ee-quote");
  const messagesEl = panel.querySelector(".ee-messages");
  const inputEl = panel.querySelector(".ee-input");
  const sendBtn = panel.querySelector(".ee-send-btn");

  panel.addEventListener("mousedown", (e) => e.stopPropagation());

  // ─── Panel Dragging ──────────────────────────────────────────────────
  panelHeader.addEventListener("mousedown", (e) => {
    if (e.target.closest(".ee-header-btn")) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    dragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
    document.addEventListener("mousemove", onDragMove, true);
    document.addEventListener("mouseup", onDragEnd, true);
  });

  function onDragMove(e) {
    if (!dragState) return;
    e.preventDefault();
    let newLeft = dragState.origLeft + (e.clientX - dragState.startX);
    let newTop = dragState.origTop + (e.clientY - dragState.startY);
    newLeft = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, newLeft));
    newTop = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, newTop));
    panel.style.left = newLeft + "px";
    panel.style.top = newTop + "px";
  }

  function onDragEnd() {
    dragState = null;
    document.removeEventListener("mousemove", onDragMove, true);
    document.removeEventListener("mouseup", onDragEnd, true);
  }

  // ─── Panel Controls ──────────────────────────────────────────────────
  minimizeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    isMinimized = !isMinimized;
    panel.classList.toggle("minimized", isMinimized);
    minimizeBtn.textContent = isMinimized ? "+" : "\u2014";
    minimizeBtn.title = isMinimized ? "Expand" : "Minimize";
  });

  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); hidePanel(); });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFollowup(); }
  });
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + "px";
  });
  sendBtn.addEventListener("click", sendFollowup);

  // ─── Page Context Extraction ─────────────────────────────────────────
  function getPageContext(selection) {
    const ctx = {
      title: document.title,
      url: window.location.href,
      metaDescription: document.querySelector('meta[name="description"]')?.content || "",
      surroundingText: "",
      headings: [],
    };
    if (!selection || selection.rangeCount === 0) return ctx;

    const range = selection.getRangeAt(0);

    // Walk up to a block-level parent for surrounding text
    let block = range.startContainer;
    if (block.nodeType === Node.TEXT_NODE) block = block.parentElement;
    const blockTags = new Set([
      "P","DIV","SECTION","ARTICLE","LI","TD","TH","BLOCKQUOTE",
      "DD","DT","FIGCAPTION","MAIN","ASIDE","HEADER","FOOTER","PRE",
    ]);
    while (block && block !== document.body) {
      if (blockTags.has(block.tagName)) break;
      block = block.parentElement;
    }
    if (block) {
      let text = (block.textContent || "").trim();
      if (text.length > 300) text = text.substring(0, 300) + "\u2026";
      ctx.surroundingText = text;
    }

    // Collect headings that appear before the selection in DOM order
    const allHeadings = document.querySelectorAll("h1, h2, h3");
    const before = [];
    for (const h of allHeadings) {
      // If the heading comes before the selection start in document order
      const pos = range.startContainer.compareDocumentPosition(h);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
        const hText = (h.textContent || "").trim();
        if (hText) before.push(hText);
      }
    }
    ctx.headings = before.slice(-3);
    return ctx;
  }

  // ─── Markdown Rendering ──────────────────────────────────────────────
  function renderMarkdown(text) {
    let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.split(/\n{2,}/).map((p) => "<p>" + p.replace(/\n/g, "<br>") + "</p>").join("");
    return html;
  }

  // ─── Typing Indicator ────────────────────────────────────────────────
  function createTypingIndicator() {
    const el = document.createElement("div");
    el.className = "ee-typing";
    el.innerHTML = '<div class="ee-typing-dot"></div><div class="ee-typing-dot"></div><div class="ee-typing-dot"></div>';
    return el;
  }

  // ─── Port Management ─────────────────────────────────────────────────
  function ensurePort() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: "explain" });
      port.onMessage.addListener(onPortMessage);
      port.onDisconnect.addListener(() => { port = null; });
    } catch (e) {
      port = null;
    }
    return port;
  }

  function onPortMessage(msg) {
    if (msg.type === "chunk") onChunk(msg.text);
    else if (msg.type === "done") onDone(msg.fullText);
    else if (msg.type === "error") onError(msg.message);
  }

  // ─── Streaming Handlers ──────────────────────────────────────────────
  function onChunk(text) {
    if (typingIndicator && typingIndicator.parentNode) {
      typingIndicator.remove();
      typingIndicator = null;
    }
    streamBuffer += text;
    if (!activeStreamEl) {
      activeStreamEl = document.createElement("div");
      activeStreamEl.className = "ee-msg-ai";
      messagesEl.appendChild(activeStreamEl);
    }
    activeStreamEl.textContent = streamBuffer;
    scrollToBottom();
  }

  function onDone(fullText) {
    if (typingIndicator && typingIndicator.parentNode) {
      typingIndicator.remove();
      typingIndicator = null;
    }
    const finalText = fullText || streamBuffer;
    if (activeStreamEl) {
      activeStreamEl.innerHTML = renderMarkdown(finalText);
    } else {
      const el = document.createElement("div");
      el.className = "ee-msg-ai";
      el.innerHTML = renderMarkdown(finalText);
      messagesEl.appendChild(el);
    }
    conversationHistory.push({ role: "assistant", content: finalText });
    isLoading = false;
    activeStreamEl = null;
    streamBuffer = "";
    inputEl.disabled = false;
    sendBtn.disabled = false;
    // Add "More" button after each AI response
    addMoreButton();
    inputEl.focus();
    scrollToBottom();
  }

  function addMoreButton() {
    // Remove any existing More button
    const old = messagesEl.querySelector(".ee-more-btn");
    if (old) old.remove();
    const btn = document.createElement("button");
    btn.className = "ee-more-btn";
    btn.innerHTML = 'More <kbd>Tab</kbd>';
    btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("click", (e) => { e.stopPropagation(); triggerMore(); });
    messagesEl.appendChild(btn);
  }

  function triggerMore() {
    if (isLoading) return;
    // Remove the More button
    const btn = messagesEl.querySelector(".ee-more-btn");
    if (btn) btn.remove();
    // Send "Elaborate further" as a follow-up (no visible user bubble — feels like a continuation)
    const divider = document.createElement("div");
    divider.className = "ee-divider";
    messagesEl.appendChild(divider);

    conversationHistory.push({ role: "user", content: "Elaborate further." });

    typingIndicator = createTypingIndicator();
    messagesEl.appendChild(typingIndicator);
    scrollToBottom();

    isLoading = true;
    streamBuffer = "";
    activeStreamEl = null;
    inputEl.disabled = true;
    sendBtn.disabled = true;

    const p = ensurePort();
    if (!p) { onError("Could not connect to extension. Try reloading the page."); return; }
    p.postMessage({
      action: "followup",
      message: "Elaborate further.",
      conversationHistory: conversationHistory.slice(0, -1),
      pageContext,
    });
  }

  function onError(message) {
    if (typingIndicator && typingIndicator.parentNode) {
      typingIndicator.remove();
      typingIndicator = null;
    }
    const el = document.createElement("div");
    el.className = "ee-error";
    el.textContent = message;
    messagesEl.appendChild(el);
    isLoading = false;
    activeStreamEl = null;
    streamBuffer = "";
    inputEl.disabled = false;
    sendBtn.disabled = false;
    scrollToBottom();
  }

  function scrollToBottom() { panelBody.scrollTop = panelBody.scrollHeight; }

  // ─── Show / Hide Helpers ─────────────────────────────────────────────
  function showExplainBtn(x, y) {
    const left = Math.max(0, Math.min(x, window.innerWidth - 108));
    const top = Math.max(0, Math.min(y, window.innerHeight - 40));
    explainBtn.style.left = left + "px";
    explainBtn.style.top = top + "px";
    explainBtn.style.display = "flex";
    explainBtn.classList.remove("visible");
    requestAnimationFrame(() => requestAnimationFrame(() => explainBtn.classList.add("visible")));
  }

  function hideExplainBtn() {
    explainBtn.classList.remove("visible");
    setTimeout(() => { if (!explainBtn.classList.contains("visible")) explainBtn.style.display = "none"; }, 160);
  }

  function showPanel(anchorX, anchorY) {
    applyTheme();
    let left = anchorX + 10;
    let top = anchorY + 10;
    if (left + 400 > window.innerWidth - 12) left = Math.max(12, window.innerWidth - 412);
    if (top + 400 > window.innerHeight - 12) top = Math.max(12, window.innerHeight - 412);
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    isMinimized = false;
    panel.classList.remove("minimized");
    minimizeBtn.textContent = "\u2014";
    minimizeBtn.title = "Minimize";
    panel.style.display = "flex";
    panel.classList.remove("visible");
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add("visible")));
  }

  function hidePanel() {
    panel.classList.remove("visible");
    setTimeout(() => { if (!panel.classList.contains("visible")) panel.style.display = "none"; }, 160);
    if (port && !isLoading) { try { port.disconnect(); } catch {} port = null; }
    conversationHistory = [];
    selectedText = "";
    pageContext = null;
    isLoading = false;
    activeStreamEl = null;
    streamBuffer = "";
  }

  function isPanelOpen() {
    return panel.classList.contains("visible") || panel.style.display === "flex";
  }

  function applyTheme() {
    panel.classList.toggle("dark", darkMQ.matches);
  }

  darkMQ.addEventListener("change", () => { if (isPanelOpen()) applyTheme(); });

  // ─── Explain Action ──────────────────────────────────────────────────
  function onExplainClick() {
    const sel = window.getSelection();
    const text = (sel ? sel.toString() : "").trim();
    if (text.length < 2) return;

    hideExplainBtn();
    selectedText = text;
    pageContext = getPageContext(sel);

    // Reset conversation for new explain
    conversationHistory = [];
    messagesEl.innerHTML = "";
    streamBuffer = "";
    activeStreamEl = null;

    let displayText = selectedText;
    if (displayText.length > 200) displayText = displayText.substring(0, 200) + "\u2026";
    quoteEl.textContent = "\u201C" + displayText + "\u201D";

    let anchorX = 0, anchorY = 0;
    if (sel.rangeCount > 0) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      anchorX = rect.left;
      anchorY = rect.bottom + 8;
    }

    showPanel(anchorX, anchorY);

    typingIndicator = createTypingIndicator();
    messagesEl.appendChild(typingIndicator);
    scrollToBottom();

    conversationHistory.push({ role: "user", content: `Explain this highlighted text: "${selectedText}"` });
    isLoading = true;
    inputEl.disabled = true;
    sendBtn.disabled = true;

    const p = ensurePort();
    if (!p) { onError("Could not connect to extension. Try reloading the page."); return; }
    p.postMessage({ action: "explain", selectedText, pageContext, conversationHistory: [] });
  }

  // ─── Follow-up ───────────────────────────────────────────────────────
  function sendFollowup() {
    const text = inputEl.value.trim();
    if (!text || isLoading) return;

    const userBubble = document.createElement("div");
    userBubble.className = "ee-msg-user";
    userBubble.textContent = text;
    messagesEl.appendChild(userBubble);

    const divider = document.createElement("div");
    divider.className = "ee-divider";
    messagesEl.appendChild(divider);

    conversationHistory.push({ role: "user", content: text });
    inputEl.value = "";
    inputEl.style.height = "auto";

    typingIndicator = createTypingIndicator();
    messagesEl.appendChild(typingIndicator);
    scrollToBottom();

    isLoading = true;
    streamBuffer = "";
    activeStreamEl = null;
    inputEl.disabled = true;
    sendBtn.disabled = true;

    const p = ensurePort();
    if (!p) { onError("Could not connect to extension. Try reloading the page."); return; }
    p.postMessage({
      action: "followup",
      message: text,
      conversationHistory: conversationHistory.slice(0, -1),
      pageContext,
    });
  }

  // ─── Document Event Listeners ────────────────────────────────────────
  document.addEventListener("mouseup", (e) => {
    if (host.contains(e.target) || e.target === host) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = (sel ? sel.toString() : "").trim();
      if (text.length >= 2) {
        let x = e.clientX, y = e.clientY + 8;
        if (sel.rangeCount > 0) {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          x = rect.right;
          y = rect.bottom + 8;
        }
        showExplainBtn(x, y);
      } else {
        hideExplainBtn();
      }
    }, 10);
  }, { passive: true });

  document.addEventListener("mousedown", (e) => {
    if (host.contains(e.target) || e.target === host) return;
    hideExplainBtn();
    // Click outside the panel dismisses it
    if (isPanelOpen()) hidePanel();
  }, { passive: true });

  document.addEventListener("scroll", () => { hideExplainBtn(); }, { passive: true });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isPanelOpen()) hidePanel();
    if (e.key === "Tab" && isPanelOpen() && !isLoading) {
      e.preventDefault();
      triggerMore();
    }
  });

  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    const text = (sel ? sel.toString() : "").trim();
    if (text.length < 2) hideExplainBtn();
  }, { passive: true });
})();
