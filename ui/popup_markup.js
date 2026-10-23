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
            <a id="count-link" href="https://store.steampowered.com/account/notinterested/" target="_blank">—</a>
            <!-- Own tooltip for the count (Steam's whole list): renderTotal in popup_main.js fills it. -->
            <span class="count-tip" id="count-tip" role="tooltip"></span>

            <!-- Undo droplist: "un-ignore the last X" (by count) / "over the last X
                 hours/days" (by time). The count row is a -[ ]+ stepper whose
                 field carries the undoable total as its pale hint (double-click
                 the empty field to take all of it); each row has its own Go. -->
            <div id="undo-menu" class="undo-menu">
              <div class="undo-title" data-i18n="undo_menu_title">Un-ignore the last N games</div>
              <div class="undo-row">
                <button type="button" class="undo-chip undo-step" id="undo-minus">−</button>
                <input id="undo-count" inputmode="numeric" maxlength="6" autocomplete="off">
                <button type="button" class="undo-chip undo-step" id="undo-plus">+</button>
                <button type="button" class="undo-go" id="undo-go-count" data-i18n="undo_go" disabled>Un-ignore</button>
              </div>
              <div class="undo-title undo-time-title" data-i18n="undo_time_title">Un-ignore games ignored within the last N</div>
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
              <span class="stat-label" data-i18n="last_ignored">Recent:</span>
              <!-- Drawn like a closed droplist: the last entry's name, its source
                   icon and a chevron that turns up while the history shows. -->
              <div id="last-ignored-row">
                <span id="last-game">None</span>
                <span class="hist-src" id="last-src"></span>
                <span class="last-chevron" aria-hidden="true"></span>
              </div>
            </div>

            <div class="history-tooltip" id="history-list"></div>
          </div>

          <div id="dynamic-hint" class="hint"></div>

          <!-- Curator ignore queue applet — sits ABOVE the SETTINGS applet. Always
               shown, for the built-in lists icon on its bar; while the queue is empty
               (.is-empty) it opens on a hint that says where jobs come from.
               The icon opens the lists menu (ui/popup_presets.js), and its tip is a
               sibling for the same reason as the language chip's. -->
          <details id="queue-accordion" class="is-empty" data-master-exempt>
            <summary><span class="summary-title"><svg class="summary-ico queue-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="2" y="3" width="20" height="5.5" rx="1.6" fill="currentColor"/><rect x="4.5" y="10.5" width="15" height="4.5" rx="1.4" fill="currentColor" opacity=".7"/><rect x="7" y="17" width="10" height="4" rx="1.3" fill="currentColor" opacity=".45"/></svg><span data-i18n="ignore_queue">IGNORE QUEUE</span></span><span class="queue-summary-right"><span class="preset-chip" id="preset-chip" role="button" tabindex="0">${window.ILAP_Icons.PRESETS}<div class="select-menu preset-menu" id="preset-menu"></div></span><span class="preset-tip" id="preset-tip" role="tooltip" data-i18n="presets_title">Built-in ignore lists</span><span class="queue-jobs-chip" id="queue-jobs-chip">0</span></span></summary>
            <div class="settings-content" id="queue-list"></div>
          </details>

          <details id="settings-accordion" data-master-exempt>
            <summary><span class="summary-title"><svg class="summary-ico gear-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill-rule="evenodd" d="M10.66 4.32L10.94 1.65A10.4 10.4 0 0 1 13.06 1.65L13.34 4.32A7.8 7.8 0 0 1 16.49 5.62L18.57 3.93A10.4 10.4 0 0 1 20.07 5.43L18.38 7.51A7.8 7.8 0 0 1 19.68 10.66L22.35 10.94A10.4 10.4 0 0 1 22.35 13.06L19.68 13.34A7.8 7.8 0 0 1 18.38 16.49L20.07 18.57A10.4 10.4 0 0 1 18.57 20.07L16.49 18.38A7.8 7.8 0 0 1 13.34 19.68L13.06 22.35A10.4 10.4 0 0 1 10.94 22.35L10.66 19.68A7.8 7.8 0 0 1 7.51 18.38L5.43 20.07A10.4 10.4 0 0 1 3.93 18.57L5.62 16.49A7.8 7.8 0 0 1 4.32 13.34L1.65 13.06A10.4 10.4 0 0 1 1.65 10.94L4.32 10.66A7.8 7.8 0 0 1 5.62 7.51L3.93 5.43A10.4 10.4 0 0 1 5.43 3.93L7.51 5.62A7.8 7.8 0 0 1 10.66 4.32Z M17.6 12A5.6 5.6 0 1 0 6.4 12A5.6 5.6 0 1 0 17.6 12Z"/><path fill="currentColor" opacity=".45" fill-rule="evenodd" d="M17.6 12A5.6 5.6 0 1 0 6.4 12A5.6 5.6 0 1 0 17.6 12Z M14.6 12A2.6 2.6 0 1 0 9.4 12A2.6 2.6 0 1 0 14.6 12Z"/></svg><span data-i18n="settings">SETTINGS</span></span><span class="lang-chip" data-master-exempt><span class="lang-chip-code" id="lang-quick-code">EN</span><select id="lang-quick" aria-label="Language"></select></span><span class="lang-tip" id="lang-tip" data-master-exempt role="tooltip" data-i18n="language">Language:</span></summary>
            <div class="settings-content" id="settings-placeholder"></div>
          </details>
      </div>
    </div>`;
})();
