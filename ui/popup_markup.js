// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Single source of truth for the popup body markup. Mounted into the popup
    // window (ui/popup.html) AND into the on-page shadow-DOM widget, so both
    // surfaces render the identical component. The header icon src is left blank
    // and set at init via chrome.runtime.getURL (works in both contexts).
    window.ILAP_PopupMarkup = `
    <div id="popup-root" class="no-transition">
      <h3>
        <span class="header-title-wrapper">
          <img id="ilap-header-icon" width="36" height="36" alt="Icon">
          Steam Ignore Like A Pro
        </span>
        <label class="switch">
          <input type="checkbox" id="master-toggle">
          <span class="slider"></span>
        </label>
      </h3>

      <div id="ui-wrapper">
          <div class="stat-row">
            <span class="stat-label" data-i18n="total_ignored">Total Ignored:</span>
            <a id="count-link" href="https://store.steampowered.com/account/notinterested/" target="_blank">0</a>
          </div>

          <div class="history-trigger">
            <div class="stat-row" style="flex-direction: column; align-items: flex-start; gap: 4px;">
              <span class="stat-label" data-i18n="last_ignored">Last Ignored:</span>
              <span id="last-game" style="background: #4a5e73; padding: 4px 8px; border-radius: 3px; font-size: 11px; display: block; width: 100%; box-sizing: border-box; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">None</span>
            </div>

            <div class="history-tooltip" id="history-list"></div>
          </div>

          <div id="dynamic-hint" class="hint"></div>

          <!-- Curator ignore queue applet — sits ABOVE the SETTINGS applet. Stays
               [hidden] whenever the queue is empty, so it never shows even when locked. -->
          <details id="queue-accordion" hidden>
            <summary><span data-i18n="ignore_queue">IGNORE QUEUE</span><span class="queue-summary-right"><span class="queue-running-bar" aria-hidden="true"></span><span class="queue-jobs-chip" id="queue-jobs-chip">0</span></span></summary>
            <div class="settings-content" id="queue-list"></div>
          </details>

          <details id="settings-accordion">
            <summary><span style="display: flex; align-items: center; gap: 8px;">⚙ <span data-i18n="settings">SETTINGS</span></span><span class="lang-chip" data-i18n-title="language" title="Language:"><span class="lang-chip-code" id="lang-quick-code">EN</span><select id="lang-quick" aria-label="Language"></select></span></summary>
            <div class="settings-content" id="settings-placeholder"></div>
          </details>
      </div>
    </div>`;
})();
