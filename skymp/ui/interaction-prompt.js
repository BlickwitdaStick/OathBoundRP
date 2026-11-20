/**
 * Interaction Framework visual prompt.
 *
 * This layer only displays the label approved by the server. The E key is
 * handled by the exact-target event source; it re-reads the crosshair and
 * requests an inspection from the server. After validation, `browserModal`
 * opens the existing menu. The CEF never reuses the visual target as an
 * authority.
 */

(function () {
  'use strict';

  function handleInteractionPrompt(payload) {
    const data = normalizePayload(payload);
    const root = document.getElementById('interaction-prompt');
    if (!root) return;

    if (!data || data.targetId === null || data.targetId === undefined) {
      root.classList.remove('visible');
      root.setAttribute('aria-hidden', 'true');
      return;
    }

    document.getElementById('interaction-prompt-label').textContent = data.label || 'Interact';
    root.classList.add('visible');
    root.setAttribute('aria-hidden', 'false');
  }

  window.handleInteractionPrompt = handleInteractionPrompt;
})();