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
          <!-- The Undo button (⟲) and its droplist moved into the "Total Ignored" row:
               the button sits left of the total count (a small gap), the menu
               anchors to #total-row (position: relative). -->
          <div class="stat-row" id="total-row">
            <span class="stat-label" data-i18n="total_ignored">Total Ignored:</span>
            <!-- Own tooltip (not the browser title): popup_undo.js render sets the
                 text in #undo-tip, the wrapper catches hover even when the button is
                 disabled. The tip is a sibling of the wrapper, not a child: it anchors
                 to #total-row so it can be clamped to the row's width (see popup.css). -->
            <span class="undo-btn-wrap">
              <button type="button" id="undo-btn" aria-haspopup="true" aria-expanded="false">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5V1.8L6.5 6.5 12 11.2V8c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/></svg>
              </button>
            </span>
            <span class="undo-tip" id="undo-tip" role="tooltip"></span>
            <a id="count-link" href="https://store.steampowered.com/account/notinterested/" target="_blank">0</a>

            <!-- Undo droplist: "un-ignore the last X" (by count) / "over the last X
                 hours/days" (by time). Chips fill the number field; each row has
                 its own Go. -->
            <div id="undo-menu" class="undo-menu">
              <div class="undo-title" data-i18n="undo_menu_title">Un-ignore the last…</div>
              <div class="undo-row">
                <button type="button" class="undo-chip" data-n="10">10</button>
                <button type="button" class="undo-chip" data-n="25">25</button>
                <button type="button" class="undo-chip" data-n="100">100</button>
                <input id="undo-count" inputmode="numeric" maxlength="6" autocomplete="off">
                <span class="undo-of" id="undo-of"></span>
                <button type="button" class="undo-go" id="undo-go-count" data-i18n="undo_go" disabled>Un-ignore</button>
              </div>
              <div class="undo-title undo-time-title" data-i18n="undo_time_title">…or ignored within the last</div>
              <div class="undo-row">
                <input id="undo-time" inputmode="numeric" maxlength="4" autocomplete="off">
                <button type="button" class="undo-chip undo-unit selected" id="undo-unit-h" data-i18n="undo_hours">hours</button>
                <button type="button" class="undo-chip undo-unit" id="undo-unit-d" data-i18n="undo_days">days</button>
                <button type="button" class="undo-go" id="undo-go-time" data-i18n="undo_go" disabled>Un-ignore</button>
              </div>
              <div class="undo-msg" id="undo-msg" hidden></div>
            </div>
          </div>

          <div class="history-trigger">
            <div class="stat-row" style="flex-direction: column; align-items: flex-start; gap: 4px;">
              <span class="stat-label" data-i18n="last_ignored">Last Ignored:</span>
              <div id="last-ignored-row">
                <span id="last-game" style="background: #4a5e73; padding: 4px 8px; border-radius: 3px; font-size: 11px; display: block; flex: 1; min-width: 0; box-sizing: border-box; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">None</span>
              </div>
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
            <summary><span style="display: flex; align-items: center; gap: 8px;">⚙ <span data-i18n="settings">SETTINGS</span></span><span class="lang-chip"><span class="lang-chip-code" id="lang-quick-code">EN</span><select id="lang-quick" aria-label="Language"></select></span><span class="lang-tip" id="lang-tip" role="tooltip" data-i18n="language">Language:</span></summary>
            <div class="settings-content" id="settings-placeholder"></div>
          </details>
      </div>
    </div>`;
})();
