// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The gear of the settings tab: eight teeth that narrow to flat tips, with
    // gaps wider than the teeth.
    const GEAR_D = 'M10.3 3.98L10.54 0.9L13.46 0.9L13.7 3.98A8.2 8.2 0 0 1 16.47 5.12L18.82 3.11L20.89 5.18L18.88 7.53A8.2 8.2 0 0 1 20.02 10.3L23.1 10.54L23.1 13.46L20.02 13.7A8.2 8.2 0 0 1 18.88 16.47L20.89 18.82L18.82 20.89L16.47 18.88A8.2 8.2 0 0 1 13.7 20.02L13.46 23.1L10.54 23.1L10.3 20.02A8.2 8.2 0 0 1 7.53 18.88L5.18 20.89L3.11 18.82L5.12 16.47A8.2 8.2 0 0 1 3.98 13.7L0.9 13.46L0.9 10.54L3.98 10.3A8.2 8.2 0 0 1 5.12 7.53L3.11 5.18L5.18 3.11L7.53 5.12A8.2 8.2 0 0 1 10.3 3.98Z M15.8 12A3.8 3.8 0 1 0 8.2 12A3.8 3.8 0 1 0 15.8 12Z';
    const GEAR = '<svg class="tab-ico gear-ico" viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">'
        + `<path fill="currentColor" stroke="currentColor" stroke-width=".9" stroke-linejoin="round" fill-rule="evenodd" d="${GEAR_D}"/></svg>`;

    // The language tab's globe, before the panel's language code (drawn in the
    // AI tab's letters by TabBar.relabel, the code as text out of sight) and
    // the panel's caret after it.
    const GLOBE = '<svg class="tab-ico globe-ico" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"'
        + ' fill="none" stroke="currentColor" stroke-width="1.8">'
        + '<circle cx="12" cy="12" r="9.2"/><ellipse cx="12" cy="12" rx="4.1" ry="9.2"/>'
        + '<path d="M2.8 12H21.2M4.4 7.4H19.6M4.4 16.6H19.6"/></svg>';

    // The AI tab's glyph: the word AI with a filter funnel right of it, a
    // frame round the word and a strike through it. Which of the frame and
    // the strike shows, and in what colour, follows the level the AI tab's
    // slider shows (popup.css #tab-ai). The word comes first and the
    // language tab's code after its globe, so the two never read alike.
    const AI_LETTERS = 'M5.17 16.5 7.25 5.5H10.02L12.07 16.5H9.83L9.46 14.18H7.85L7.47 16.5ZM8.06 12.72H9.23L8.65 8.43ZM14.4 16.5V5.5H16.83V16.5Z';
    const AI_SLASH = '<polygon points="2.88,15.02 20.04,9.52 18.88,6.32 2.2,13.14"/>';
    const AI_FRAME = 'x="3.2" y="3.4" width="15.6" height="15.2" rx="2.4" pathLength="1"';
    const AI_FUNNEL = 'M22.6 5.5H32.2L28.5 10.6V15.3L26.3 16.5V10.6Z';
    const AI_GLYPH = '<svg class="ai-glyph" viewBox="0 0 33 22" width="33" height="22" aria-hidden="true">'
        + `<rect class="ai-frame" ${AI_FRAME} fill="none" stroke-width="1.4"/>`
        + `<path class="ai-letters" d="${AI_LETTERS}"/>`
        + `<g class="ai-slash">${AI_SLASH}<circle cx="2.54" cy="14.08" r="1"/><circle cx="19.46" cy="7.92" r="1.7"/></g>`
        + `<path class="ai-funnel" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round" d="${AI_FUNNEL}"/>`
        + '</svg>';

    // Single source of truth for the popup body markup. Mounted into the popup
    // window (ui/popup.html) AND into the on-page shadow-DOM widget, so both
    // surfaces render the identical component. The header icon src is left blank
    // and set at init via chrome.runtime.getURL (works in both contexts).
    // The ignore queue and the built-in lists slide out of the panel's left
    // side (ui/popup_queue.js, ui/popup_presets.js), the queue against the
    // panel's top, the lists against its bottom: the shell lays the drawers and
    // the panel side by side, and the window (or the widget, anchored on its
    // right) grows left.
    window.ILAP_PopupMarkup = `
    <div id="ilap-shell">
    <aside id="queue-drawer" data-master-exempt>
      <div class="drawer-inner">
        <div class="list-title queue-title"><svg class="queue-ico" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="2" y="3" width="20" height="5.5" rx="1.6" fill="currentColor"/><rect x="4.5" y="10.5" width="15" height="4.5" rx="1.4" fill="currentColor" opacity=".7"/><rect x="7" y="17" width="10" height="4" rx="1.3" fill="currentColor" opacity=".45"/></svg><span data-i18n="ignore_queue">Ignore Tasks Queue</span></div>
        <div id="queue-list"></div>
      </div>
    </aside>
    <aside id="lists-drawer" data-master-exempt>
      <div class="drawer-inner">
        <div id="ai-pane" class="list-pane"></div>
        <div id="lists-pane" class="list-pane"></div>
      </div>
    </aside>
    <div id="popup-root" class="no-transition">
      <h3>
        <span class="header-title-wrapper">
          <!-- The extension's icon opens the queue. The job count sits on its
               lower right corner in a square whose outline traces the queue's
               progress, and a barber pole runs round the icon while a job
               runs (ui/popup_queue.js). Its name is its aria-label. -->
            <button type="button" id="queue-btn" aria-expanded="false" aria-controls="queue-drawer" aria-describedby="queue-jobs-chip">
              <img id="ilap-header-icon" width="30" height="30" alt="">
              <span class="queue-barber" aria-hidden="true"></span>
              <span class="queue-badge"><span class="queue-jobs-chip" id="queue-jobs-chip">0</span><svg class="queue-ring" aria-hidden="true"><rect class="queue-ring-track" width="100%" height="100%" rx="4" pathLength="100"/><rect class="queue-ring-fill" width="100%" height="100%" rx="4" pathLength="100"/></svg></span>
            </button>
          <span id="ilap-title">Steam Ignore Like a Pro</span>
        </span>
        <!-- The switch turns the whole extension on and off, so its name is the
             extension's own (aria-labelledby). -->
        <label class="switch">
          <input type="checkbox" id="master-toggle" aria-labelledby="ilap-title">
          <span class="slider"></span>
        </label>
      </h3>

      <div id="ui-wrapper">
          <!-- The Undo button (⟲) and its droplist moved into the "Total Ignored" row:
               the button sits left of the total count (a small gap), the menu
               anchors to #total-row (position: relative). -->
          <div class="stat-row" id="total-row">
            <span class="stat-label" id="total-label" data-i18n="total_ignored">Total Ignored:</span>
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
            <a id="count-link" href="https://store.steampowered.com/account/notinterested/" target="_blank" aria-labelledby="total-label count-link" aria-describedby="count-tip">—</a>
            <!-- Own tooltip for the count (Steam's whole list): renderTotal in popup_main.js fills it. -->
            <span class="count-tip" id="count-tip" role="tooltip"></span>

            <!-- Undo droplist. Games: "un-ignore the last X" (by count) or "over the
                 last X hours/days" (by time), each row picked by its radio mark (the
                 row last typed in or clicked), one Un-ignore in the menu's lower right
                 corner for the picked row (the panel has no room for a row of its own). The
                 count row is a -[ ]+ stepper whose field has the undoable total as
                 its pale hint (double-click the empty field to take all of it).
                 Creators: the ignored creators in a droplist and their Un-ignore;
                 the tab line shows only while the account ignores a creator. -->
            <div id="undo-menu" class="undo-menu">
              <div class="undo-tabs" id="undo-tabs" role="tablist" hidden>
                <button type="button" class="undo-tab" id="undo-tab-games" role="tab" aria-selected="true" aria-controls="undo-pane-games" data-i18n="undo_tab_games">Games</button>
                <button type="button" class="undo-tab" id="undo-tab-creators" role="tab" aria-selected="false" aria-controls="undo-pane-creators" tabindex="-1" data-i18n="undo_tab_creators">Creators</button>
              </div>
              <div id="undo-pane-games" role="tabpanel" aria-labelledby="undo-tab-games">
                <label class="undo-pick">
                  <input type="radio" name="undo-scope" id="undo-pick-count" value="count" checked>
                  <span class="undo-title" id="undo-count-title" data-i18n="undo_menu_title">Un-ignore the last N games</span>
                </label>
                <div class="undo-row">
                  <button type="button" class="undo-chip undo-step" id="undo-minus">−</button>
                  <input id="undo-count" inputmode="numeric" maxlength="6" autocomplete="off">
                  <button type="button" class="undo-chip undo-step" id="undo-plus">+</button>
                </div>
                <label class="undo-pick undo-time-title">
                  <input type="radio" name="undo-scope" id="undo-pick-time" value="time">
                  <span class="undo-title" id="undo-time-title" data-i18n="undo_time_title">Un-ignore games ignored within the last N</span>
                </label>
                <div class="undo-row">
                  <input id="undo-time" inputmode="numeric" maxlength="4" autocomplete="off" aria-labelledby="undo-time-title">
                  <button type="button" class="undo-chip undo-unit selected" id="undo-unit-h" data-i18n="undo_hours" aria-pressed="true">hours</button>
                  <button type="button" class="undo-chip undo-unit" id="undo-unit-d" data-i18n="undo_days" aria-pressed="false">days</button>
                  <button type="button" class="undo-go" id="undo-go" data-i18n="undo_go" disabled>Un-ignore</button>
                </div>
              </div>
              <div id="undo-pane-creators" role="tabpanel" aria-labelledby="undo-tab-creators" hidden>
                <div class="undo-title" id="undo-creator-title" data-i18n="undo_creators_title">Un-ignore a creator</div>
                <div class="undo-row">
                  <div class="select-shell undo-creator-shell"><span class="select-display" id="undo-creator-display"></span><select id="undo-creator" aria-labelledby="undo-creator-title"></select></div>
                  <button type="button" class="undo-go" id="undo-go-creator" data-i18n="undo_go" disabled>Un-ignore</button>
                </div>
              </div>
              <div class="undo-msg" id="undo-msg" hidden></div>
            </div>
          </div>

          <div class="history-trigger">
            <div class="stat-row" style="flex-direction: column; align-items: flex-start; gap: 4px;">
              <span class="stat-label" data-i18n="last_ignored">Recent:</span>
              <!-- Drawn like a closed droplist: the last entry's name, its source
                   icon and a caret that turns down while the history shows.
                   Keyboard focus shows the history as hover does; the row and an
                   entry that opens a page are links then (popup_main.js). -->
              <div id="last-ignored-row" tabindex="0">
                <span id="last-game">None</span>
                <span class="hist-src" id="last-src"></span>
                <span class="last-chevron" aria-hidden="true"></span>
              </div>
            </div>

            <div class="history-tooltip" id="history-list"></div>
          </div>

          <div id="dynamic-hint" class="hint"></div>

          <!-- The tab line and the panel that drops down under it (ui/popup_tabs.js).
               One tab open or none. Four equal cells: in the line's left corner,
               before the tabs, the button that slides the built-in lists out
               (ui/popup_presets.js), then the AI filters, the language (a globe and
               the panel's language code, its grid opens as the tab's pane) and the settings gear. A
               button's name is its own tooltip and its aria-label (TabBar.relabel).
               The tabs stay live while the extension is off: settings has the
               language and the surface picker. The lists button goes dead then
               (ListPanes.setMasterOff). -->
          <div id="tabline" data-master-exempt>
            <button type="button" class="tab" id="lists-btn" aria-expanded="false" aria-controls="lists-drawer">${window.ILAP_Icons.PRESETS}<svg class="lists-back" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M12 5.5 5.5 12l6.5 6.5M19 5.5 12.5 12l6.5 6.5"/></svg></button>
            <div id="tabbar" role="tablist">
              <button type="button" role="tab" class="tab" id="tab-ai" data-tab="ai" aria-controls="tab-panel" aria-selected="false" tabindex="-1"><span class="ai-ico">${AI_GLYPH}<span class="tab-word">AI</span></span></button>
              <button type="button" role="tab" class="tab" id="tab-lang" data-tab="lang" aria-controls="tab-panel" aria-selected="false" tabindex="-1">${GLOBE}<svg class="lang-glyph" id="lang-glyph" height="22" aria-hidden="true"></svg><span class="lang-caret" aria-hidden="true"></span><span class="tab-word" id="lang-code">EN</span></button>
              <button type="button" role="tab" class="tab" id="tab-settings" data-tab="settings" aria-controls="tab-panel" aria-selected="false" tabindex="-1">${GEAR}</button>
            </div>
            <span class="tab-tip" id="tab-tip" role="tooltip"></span>
          </div>
          <div id="tab-panel" role="tabpanel" data-master-exempt>
            <div class="tab-pane" data-pane="ai" id="ai-tab-pane" hidden></div>
            <div class="tab-pane" data-pane="lang" id="lang-pane" data-master-exempt hidden></div>
            <div class="tab-pane settings-content" data-pane="settings" id="settings-placeholder" hidden></div>
          </div>
      </div>
    </div>
    </div>`;
})();
