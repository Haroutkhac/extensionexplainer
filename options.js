document.addEventListener('DOMContentLoaded', () => {
  const providerSelect = document.getElementById('provider');
  const apiKeyInput = document.getElementById('api-key');
  const toggleKeyBtn = document.getElementById('toggle-key');
  const eyeIcon = document.getElementById('eye-icon');
  const eyeOffIcon = document.getElementById('eye-off-icon');
  const modelInput = document.getElementById('model');
  const ollamaUrlInput = document.getElementById('ollama-url');
  const ollamaModelInput = document.getElementById('ollama-model');
  const claudeFields = document.getElementById('claude-fields');
  const ollamaFields = document.getElementById('ollama-fields');
  const maxTokensInput = document.getElementById('max-tokens');
  const maxTokensValue = document.getElementById('max-tokens-value');
  const temperatureInput = document.getElementById('temperature');
  const temperatureValue = document.getElementById('temperature-value');
  const saveBtn = document.getElementById('save-btn');
  const saveMessage = document.getElementById('save-message');
  const topicCount = document.getElementById('topic-count');
  const lookupCount = document.getElementById('lookup-count');
  const topicsList = document.getElementById('topics-list');
  const clearProfileBtn = document.getElementById('clear-profile');

  const defaults = {
    provider: 'claude',
    apiKey: '',
    model: 'claude-sonnet-4-20250514',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'llama3.2',
    maxTokens: 500,
    temperature: 0.3
  };

  function updateFieldVisibility(provider) {
    if (provider === 'claude') {
      claudeFields.style.display = 'block';
      ollamaFields.style.display = 'none';
    } else {
      claudeFields.style.display = 'none';
      ollamaFields.style.display = 'block';
    }
  }

  // Load saved settings
  chrome.storage.sync.get(defaults, (settings) => {
    providerSelect.value = settings.provider;
    apiKeyInput.value = settings.apiKey;
    modelInput.value = settings.model;
    ollamaUrlInput.value = settings.ollamaUrl;
    ollamaModelInput.value = settings.ollamaModel;
    maxTokensInput.value = settings.maxTokens;
    maxTokensValue.textContent = settings.maxTokens;
    temperatureInput.value = settings.temperature;
    temperatureValue.textContent = settings.temperature;
    updateFieldVisibility(settings.provider);
  });

  // Provider change
  providerSelect.addEventListener('change', () => {
    updateFieldVisibility(providerSelect.value);
  });

  // Toggle API key visibility
  toggleKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    eyeIcon.style.display = isPassword ? 'none' : 'block';
    eyeOffIcon.style.display = isPassword ? 'block' : 'none';
  });

  // Range input live updates
  maxTokensInput.addEventListener('input', () => {
    maxTokensValue.textContent = maxTokensInput.value;
  });

  temperatureInput.addEventListener('input', () => {
    temperatureValue.textContent = temperatureInput.value;
  });

  // Save settings
  saveBtn.addEventListener('click', () => {
    const settings = {
      provider: providerSelect.value,
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim() || defaults.model,
      ollamaUrl: ollamaUrlInput.value.trim() || defaults.ollamaUrl,
      ollamaModel: ollamaModelInput.value.trim() || defaults.ollamaModel,
      maxTokens: parseInt(maxTokensInput.value, 10),
      temperature: parseFloat(temperatureInput.value)
    };

    chrome.storage.sync.set(settings, () => {
      if (chrome.runtime.lastError) {
        showMessage('Error saving settings: ' + chrome.runtime.lastError.message, true);
        return;
      }
      showMessage('Settings saved successfully');
    });
  });

  function showMessage(text, isError) {
    saveMessage.textContent = text;
    saveMessage.className = 'save-message' + (isError ? ' error' : ' success');
    setTimeout(() => {
      saveMessage.textContent = '';
      saveMessage.className = 'save-message';
    }, 3000);
  }

  // Load knowledge profile
  function loadKnowledgeProfile() {
    chrome.storage.local.get({ knowledgeProfile: {} }, (data) => {
      const profile = data.knowledgeProfile;
      const topics = Object.entries(profile);

      // Calculate stats
      const totalTopics = topics.length;
      const totalLookups = topics.reduce((sum, [, info]) => sum + (info.lookups || 0), 0);

      topicCount.textContent = totalTopics;
      lookupCount.textContent = totalLookups;

      if (topics.length === 0) {
        topicsList.innerHTML = '<p class="empty-state">No topics tracked yet.</p>';
        return;
      }

      // Sort by lookups descending and take top 10
      const topTopics = topics
        .sort((a, b) => (b[1].lookups || 0) - (a[1].lookups || 0))
        .slice(0, 10);

      topicsList.innerHTML = topTopics.map(([topic, info]) => {
        const confidence = Math.min(Math.max(info.confidence || 0, 0), 1);
        const confidencePercent = Math.round(confidence * 100);
        const barColor = getConfidenceColor(confidence);
        const lookups = info.lookups || 0;

        return `
          <div class="topic-item">
            <div class="topic-header">
              <span class="topic-name">${escapeHtml(topic)}</span>
              <span class="topic-lookups">${lookups} lookup${lookups !== 1 ? 's' : ''}</span>
            </div>
            <div class="confidence-bar-track">
              <div class="confidence-bar-fill" style="width: ${confidencePercent}%; background: ${barColor};"></div>
            </div>
          </div>
        `;
      }).join('');
    });
  }

  function getConfidenceColor(confidence) {
    if (confidence >= 0.7) return '#22c55e';
    if (confidence >= 0.4) return '#f59e0b';
    return '#ef4444';
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Clear knowledge profile
  clearProfileBtn.addEventListener('click', () => {
    if (!confirm('Are you sure you want to clear your knowledge profile? This will remove all tracked topics and cannot be undone.')) {
      return;
    }

    chrome.storage.local.set({ knowledgeProfile: {} }, () => {
      if (chrome.runtime.lastError) {
        showMessage('Error clearing profile: ' + chrome.runtime.lastError.message, true);
        return;
      }
      loadKnowledgeProfile();
      showMessage('Knowledge profile cleared');
    });
  });

  // Initial load of knowledge profile
  loadKnowledgeProfile();
});
