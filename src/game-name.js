// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // A game's display name, read from the store page around one of its links:
    // a chain of DOM strategies, then the appdetails endpoint when all of them miss.

    class NameCleaner {
        static cleanUp(name) {
            return name.replace(/\s*-?\s*screenshot\s*\d*$/i, '').trim();
        }
        static cleanText(text) {
            return text ? text.trim() : "";
        }
    }

    // Steam's hover-preview applet (Labs) renders action buttons — "Ignore game",
    // "Add to wishlist", "Add to cart" — as plain text inside the same popover as
    // the capsule. These labels must never be mistaken for a game's name.
    const ACTION_LABEL = /^(ignore( game)?|ignored|add to wishlist|on wishlist|wishlist|add to cart|in cart|follow(ing)?|play( now)?|install|buy now|buy)$/i;

    class PageTitleStrategy {
        extract(appid, contextElement, root) {
            if (root === document.body || root.id === 'page_root') {
                const pageTitle = document.getElementById('appHubAppName') || document.querySelector('.apphub_AppName');
                if (pageTitle && NameCleaner.cleanText(pageTitle.textContent)) {
                    return NameCleaner.cleanText(pageTitle.textContent);
                }
            }
            return null;
        }
    }

    class CssClassesStrategy {
        extract(appid, contextElement, root) {
            const titleSelectors = [
                '[class*="GameName"]', '[class*="AppName"]', '[class*="AppTitle"]',
                '.app_name', '.tab_item_name', '.capsule_name', '.home_smallcap_title',
                '[class*="StoreSaleWidgetTitle"]', '[class*="Hover_Title"]', 'h4', '.title'
            ];

            for (let s of titleSelectors) {
                const el = root.querySelector(s);
                const text = el && NameCleaner.cleanText(el.textContent);
                if (text && text.length > 1 && text.length < 80 && !/^\d/.test(text) && !ACTION_LABEL.test(text)) {
                    return text;
                }
            }
            return null;
        }
    }

    class AltTagsStrategy {
        extract(appid, contextElement, root) {
            const JUNK_PATTERNS = /^(capsule|header|image|cover|artwork|screenshot|review|logo|\d+)$/i;
            const imgs = root.querySelectorAll('img[alt]');
            for (const img of imgs) {
                const alt = NameCleaner.cleanText(img.alt);
                if (alt && alt.length > 2 && !JUNK_PATTERNS.test(alt) && !alt.toLowerCase().includes('screenshot') && !ACTION_LABEL.test(alt)) {
                    return alt;
                }
            }
            return null;
        }
    }

    class GenericTextStrategy {
        extract(appid, contextElement, root) {
            const links = root.querySelectorAll(`a[href*="/app/${appid}"]`);
            for (const link of links) {
                if (link.querySelector('img')) continue;
                const text = NameCleaner.cleanText(link.textContent);
                if (text && text.length > 1 && text.length < 80) return text;
            }

            const candidates = root.querySelectorAll('div, span, p');
            for (const el of candidates) {
                if (el.children.length > 0) continue;
                if (el === contextElement || el.contains(contextElement)) continue;
                if (el.closest('.ilap-ignored-overlay')) continue;

                const selfCls = (el.className || "").toLowerCase();
                const parentCls = (el.parentElement?.className || "").toLowerCase();
                const ancestorCls = selfCls + " " + parentCls;

                if (ancestorCls.match(/discount|price|currency|review|wishlist|btn|button|tag|badge|flag|rating|screenshot|release|date|platform|os_/)) continue;

                const text = NameCleaner.cleanText(el.textContent);
                if (!text || text.length <= 1 || text.length >= 80) continue;
                if (text.includes('%')) continue;
                if (ACTION_LABEL.test(text)) continue;

                return text;
            }
            return null;
        }
    }

    class UrlPathStrategy {
        extract(appid, contextElement, root) {
            const linkSelector = `a[href*="/app/${appid}"]`;
            const link = root.matches?.(linkSelector) ? root :
                         root.querySelector(linkSelector) ||
                         (contextElement && contextElement.closest ? contextElement.closest(linkSelector) : null);

            if (link) {
                const url = link.getAttribute('href');
                const match = url.match(new RegExp(`/app/${appid}/([^/?]+)`));
                if (match && match[1]) {
                    // A stray '%' in the slug makes decodeURIComponent throw, and
                    // a throw here would end the whole chain, appdetails included.
                    let extracted;
                    try { extracted = decodeURIComponent(match[1]); } catch (e) { return null; }
                    extracted = extracted.replace(/_/g, ' ');
                    extracted = NameCleaner.cleanText(extracted);
                    if (extracted.length > 1) return extracted;
                }
            }
            return null;
        }
    }

    class NameExtractionStrategyProvider {
        constructor(strategies) {
            this.strategies = strategies;
        }

        // The first strategy's name, or null when every one of them misses.
        find(appid, contextElement) {
            const root = this._findRoot(contextElement);

            for (const strategy of this.strategies) {
                const name = strategy.extract(appid, contextElement, root);
                if (name) return NameCleaner.cleanUp(name);
            }

            return null;
        }

        _findRoot(el) {
            if (!el) return document.body;

            const reactPanelWrapper = el.closest('div[class*="Panel"][role="button"]');
            if (reactPanelWrapper && reactPanelWrapper.querySelector('a[href*="/app/"]')) {
                return reactPanelWrapper;
            }

            const structuralRoot = el.closest('a[href*="/app/"], [data-ds-appid], [data-ds-itemkey]');
            if (structuralRoot) return structuralRoot;

            const legacyRoot = el.closest(`
                .tab_item, .game_capsule, .store_main_capsule, .dailydeal_cap,
                [class*="ImpressionTrackedElement"], div[class*="StoreSaleWidget"],
                [class*="SaleSectionCtn"]
            `);
            if (legacyRoot) return legacyRoot;

            return el.parentElement?.parentElement || el.parentElement || el;
        }
    }

    const extractorProvider = new NameExtractionStrategyProvider([
        new PageTitleStrategy(),
        new CssClassesStrategy(),
        new AltTagsStrategy(),
        // The href slug is canonical and language-independent, so it wins over
        // scanning arbitrary text, which can pick up localized button labels.
        new UrlPathStrategy(),
        new GenericTextStrategy()
    ]);

    const Net = window.ILAP.SteamNet;
    const placeholder = (appid) => `AppID ${appid}`;

    window.ILAP = window.ILAP || {};
    window.ILAP.getGameName = (appid, el) => extractorProvider.find(appid, el) || placeholder(appid);
    // Async flavour: the DOM strategies first, synchronously, before the caller
    // mutates the container; appdetails only when they all miss (a bare
    // <a><img></a> capsule carries no name at all).
    window.ILAP.resolveGameName = async (appid, el) => {
        const name = extractorProvider.find(appid, el);
        if (name) return name;
        return (await Net.fetchAppName(appid)) || placeholder(appid);
    };
})();
