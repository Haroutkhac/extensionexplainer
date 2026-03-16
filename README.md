# Extension Explainer

Highlight any text on a web page and get instant, contextual AI explanations without leaving the page.

## Features

- **Instant explanations** - Select text, click "Explain", get a concise answer in a floating panel
- **Streaming responses** - Answers appear in real-time with low latency
- **Follow-up chat** - Ask deeper questions without leaving the page
- **Knowledge profile** - The extension learns what you know and adjusts explanation depth
- **Multi-provider** - Works with Claude (Anthropic) and Ollama (local open models like Llama)
- **Non-intrusive** - Shadow DOM isolation ensures the UI never conflicts with websites
- **Dark mode** - Automatically matches your system theme

## Install (Development)

1. Clone this repo
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this project folder
5. Click the extension icon in the toolbar and enter your API key

## Install (Chrome Web Store)

Coming soon.

## Configuration

### Claude (default)
1. Get an API key from [console.anthropic.com](https://console.anthropic.com/)
2. Click the extension icon, paste your key, and click Save

### Ollama (local models)
1. Install [Ollama](https://ollama.com/) and pull a model: `ollama pull llama3.2`
2. Click the extension icon, switch provider to "Ollama", and save
3. Open full settings to change the Ollama URL/model if needed

## Usage

1. Navigate to any web page
2. Highlight any text you want explained
3. Click the blue "Explain" button that appears
4. Read the concise explanation in the floating panel
5. Type follow-up questions to go deeper
6. Press Escape or click X to close

## How It Works

- **Context extraction** - Captures page title, URL, surrounding text, and heading hierarchy to give the AI full context
- **Streaming** - Uses SSE (Claude) or NDJSON (Ollama) streaming for instant first-token delivery
- **Knowledge profile** - Tracks what you look up to adjust future explanation depth. Topics you look up frequently get shorter, more advanced explanations over time
- **Shadow DOM** - All UI is injected via a closed Shadow DOM so it never interferes with page styles

## Project Structure

```
manifest.json        Chrome extension manifest (v3)
background.js        Service worker - API calls, streaming, knowledge profile
content.js           Content script - selection detection, chat UI (shadow DOM)
popup.html/js/css    Extension popup - quick settings
options.html/js/css  Options page - full settings, knowledge profile viewer
icons/               Extension icons
```

## Privacy

- Your API key is stored locally in Chrome's secure storage
- No data is sent anywhere except to your chosen AI provider
- The knowledge profile is stored locally and never uploaded
- No analytics or tracking

## License

MIT
