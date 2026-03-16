document.addEventListener('DOMContentLoaded', () => {
  const providerSelect = document.getElementById('provider');
  const apiKeyInput = document.getElementById('api-key');
  const apiKeyGroup = document.getElementById('api-key-group');
  const toggleKeyBtn = document.getElementById('toggle-key');
  const eyeIcon = document.getElementById('eye-icon');
  const eyeOffIcon = document.getElementById('eye-off-icon');
  const saveBtn = document.getElementById('save-btn');
  const saveMessage = document.getElementById('save-message');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const openOptions = document.getElementById('open-options');

  const defaults = {
    provider: 'claude',
    apiKey: '',
    model: 'claude-sonnet-4-20250514',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'llama3.2',
    maxTokens: 500,
    temperature: 0.3
  };

  function updateStatus(settings) {
    const provider = settings.provider || defaults.provider;
    let configured = false;

    if (provider === 'claude') {
      configured = !!(settings.apiKey && settings.apiKey.trim());
    } else if (provider === 'ollama') {
      configured = !!(settings.ollamaUrl && settings.ollamaUrl.trim());
    }

    statusDot.className = 'status-dot ' + (configured ? 'configured' : 'not-configured');
    statusText.textContent = configured
      ? `${provider === 'claude' ? 'Claude' : 'Ollama'} configured`
      : `${provider === 'claude' ? 'API key' : 'Ollama URL'} not set`;
  }

  function updateFieldVisibility(provider) {
    if (provider === 'claude') {
      apiKeyGroup.style.display = 'block';
    } else {
      apiKeyGroup.style.display = 'none';
    }
  }

  // Load saved settings
  chrome.storage.sync.get(defaults, (settings) => {
    providerSelect.value = settings.provider;
    apiKeyInput.value = settings.apiKey;
    updateFieldVisibility(settings.provider);
    updateStatus(settings);
  });

  // Provider change
  providerSelect.addEventListener('change', () => {
    const provider = providerSelect.value;
    updateFieldVisibility(provider);

    chrome.storage.sync.get(defaults, (settings) => {
      settings.provider = provider;
      updateStatus(settings);
    });
  });

  // Toggle API key visibility
  toggleKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    eyeIcon.style.display = isPassword ? 'none' : 'block';
    eyeOffIcon.style.display = isPassword ? 'block' : 'none';
  });

  // Save settings
  saveBtn.addEventListener('click', () => {
    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();

    chrome.storage.sync.get(defaults, (existing) => {
      const updated = {
        ...existing,
        provider: provider,
        apiKey: apiKey
      };

      chrome.storage.sync.set(updated, () => {
        if (chrome.runtime.lastError) {
          showMessage('Error saving settings', true);
          return;
        }
        showMessage('Settings saved');
        updateStatus(updated);
      });
    });
  });

  function showMessage(text, isError) {
    saveMessage.textContent = text;
    saveMessage.className = 'save-message' + (isError ? ' error' : '');
    setTimeout(() => {
      saveMessage.textContent = '';
      saveMessage.className = 'save-message';
    }, 2000);
  }

  // Open full options page
  openOptions.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});
