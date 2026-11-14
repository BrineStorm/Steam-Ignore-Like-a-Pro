// SPDX-License-Identifier: GPL-3.0-or-later
// Reads a game's AI Generated Content Disclosure (the developers' own words on
// the store page, results.jsonl field `text`) for the two exclusions of the AI
// tab: games that use AI only for translation, and games with live AI inside
// the game. Both are word rules, tuned against a hand-labelled sample of the
// scan (precision first: a game kept by mistake is an AI game left in the store).
//
//   translationOnly(text, name)  every AI use the text describes is translation
//                                or localization (of the game or its store page)
//   liveAI(text)                 the game runs AI while it is played (an LLM
//                                behind the dialogue, voices made at runtime...),
//                                whatever else the text says AI made
//
//   fromPage(doc)                the disclosure block on a store page, null for none
//   counts(game, keep)           whether a game counts as AI under the AI tab's boxes
//   pageVerdict(page, keep)      the same for the game of an open store page
//
// Two worlds: build-presets.js requires it in Node, and on a store page the
// Classic Discovery Queue and the game page's AI note read a game newer than
// the built-in lists with it (window.ILAP.AiDisclosure).
(function () {
    'use strict';

    // Steam's heading over a store page's AI Generated Content Disclosure, in
    // every store language (read from the pages with ?l=<language>). The block
    // shares its id and markup with the Mature Content Description, so only the
    // heading tells the two apart.
    var HEADINGS = new Set([
        'AI Generated Content Disclosure',
        'تنويه بأن هذا محتوى مولد بالذكاء الاصطناعي',
        'Оповестяване за съдържание, генерирано от ИИ',
        'AI 生成内容披露',
        'AI 生成內容聲明',
        'Informace o obsahu vytvářeném AI',
        'Meddelelse om AI-genereret indhold',
        'Informatie over door AI gegenereerde inhoud',
        'Tiedote tekoälysisällöstä',
        'Notification de contenu généré par IA',
        'Offenlegung von KI-generierten Inhalten',
        'Γνωστοποίηση περιεχομένου που δημιουργήθηκε από τεχνητή νοημοσύνη (AI)',
        'Nyilatkozat MI generálta tartalomról',
        'Pernyataan Konten Buatan AI',
        "Divulgazione dei contenuti generati dall'IA",
        'AI生成コンテンツの開示',
        'AI 생성 콘텐츠 사용 공개',
        'Opplysning om AI-generert innhold',
        'Oświadczenie w sprawie treści generowanych przez SI',
        'Divulgação de conteúdo gerado por IA',
        'Informații despre conținutul generat de IA',
        'Информация об ИИ-контенте',
        'Información sobre contenido generado por IA',
        'Upplysning om AI-genererat innehåll',
        'การเปิดเผยข้อมูลเกี่ยวกับเนื้อหาที่สร้างด้วย AI',
        'Yapay Zekâ İçeriği Açıklaması',
        'Розкриття інформації щодо вмісту, згенерованого ШІ',
        'Công bố về nội dung tạo bởi AI',
    ]);

    // The game's AI Generated Content Disclosure on a store page:
    // { block, heading, text }, text '' for a block with none, or null when the
    // page shows no such block. A game with both blocks has two of the same id.
    function fromPage(doc) {
        var blocks = doc.querySelectorAll('[id="game_area_content_descriptors"]');
        for (var n = 0; n < blocks.length; n++) {
            var h2 = blocks[n].querySelector('h2');
            if (!h2 || !HEADINGS.has(h2.textContent.trim())) continue;
            var text = blocks[n].querySelector('i');
            return { block: blocks[n], heading: h2.textContent.trim(), text: text ? text.textContent.trim() : '' };
        }
        return null;
    }

    var TR = /\b(translat\w*|locali[sz]\w*|subtitl\w*)\b/i;
    var NEG = /\b(no|not|never|none|nothing|without|nor)\b|n't\b/i;
    // A negation about AI use ("no AI was used for art"), unlike "assets that don't
    // affect gameplay were made with AI".
    var NONUSE = /\b(no|not|never|none|nothing|without|nor)\b[^.]{0,40}?\b(ai|a\.i\.|artificial|generat\w*|used?|made|created|involved)\b|n't\b[^.]{0,40}?\b(ai|generat\w*|use|used|made|created|involve)\b/i;
    var AIUSE = /\b(ai|a\.i\.|artificial intelligence|generative|machine|llms?|gpt\w*|chat ?gpt|deepl|tools?|generat\w*|automatic\w*)\b/i;
    // The words a sentence about AI translation may use. Any other word in such a
    // sentence is read as another use of AI, so the game is not translation only.
    var ALLOW = new Set(('a able about accessible accuracy adapt adaptation adapting additional adjusted advanced after ai ai-assisted '
        + 'ai-generated ai-translated aid all allow allowed also am an and any approved are artificial as assist assistance assistant '
        + 'assisted assisting at audience automatic automatically based be been before being besides both by can caption captions '
        + 'chatgpt checked checks claude coaching committed consistency contact content contents correct corrected correctly create '
        + 'created creating cutscenes deepl description descriptions developer developers development dialog dialogs dialogue '
        + 'dialogues did do does done during each edited editing editor encounter english enjoyable entire etc everything exclusively '
        + 'execution feel few final first first-pass following for free from future game game\'s games gemini gen genai generate '
        + 'generated generating generation generative gpt grammar has have help helped helping human humans i if in in-game include '
        + 'included includes including incorporates initial integration intelligence interface into is issues it its itself just kind '
        + 'know langauges language languages layer let listing llm llms locale locales localisation localisations localise localised '
        + 'localization localizations localize localized localizing machine machine-translated made make making manual manually marking '
        + 'may me menu menus messages mistakes mistranslations more most multilingual multiple my native naturally non-english of on '
        + 'only or order original originally other our overall overseen own page pages part partially parts plan players please polish '
        + 'polished polishing possible post-edited post-editing power powered preparation process produce produced professional '
        + 'proofread proofreading provide provided purposes qa quality range refined regions release released relied rely remain '
        + 'remains replace retranslated review reviewed revised shipping small so some source speaker steam store store\'s storepage '
        + 'strings student subtitle subtitles support supported supporting syntax team temporarily temporary text texts than that the '
        + 'their them then there these they this those to tool tools translate translated translates translating translation '
        + 'translations tutorial ui until update updated updates updating us used uses using utilize utilized utilizing various ver via '
        + 'vision was we were when whenever where which who wider with within wording').split(' '));
    var LANGS = /^(arabic|bashkir|brazilian|bulgarian|cantonese|chinese|czech|danish|dutch|finnish|french|german|greek|hindi|hungarian|indonesian|italian|japanese|korean|latin|america|mandarin|norwegian|polish|portuguese|romanian|russian|simplified|spanish|swedish|tatar|thai|traditional|turkish|ukrainian|vietnamese|non-\w+)$/;
    // The game's own text written with AI, next to its translation.
    var WRITING = /\b(texts?|copy|descriptions?|store page)\b[^.]*?\band\s+(its\s+|their\s+|the\s+)?(translat|locali)|\b(wr[io]te|written|writing|draft\w*)\b/i;
    // A sentence about the people's own work ("All art is drawn by our team").
    var HUMAN = /\b(we|our|us|i|my|team|developers?|author|artists?|human\w*|hand[- ]?\w*|manual\w*|written by|drawn|licensed|captured)\b/i;

    // Sentences, list items and "label: value" parts each on their own.
    function sentences(text) {
        return String(text || '').split(/(?<=[.!?;\n；])\s*|\n+|\s+-\s+|\s*[•・]\s*|(?:^|\s)\d\.\s+|[:：]\s+/)
            .map(function (s) { return s && s.trim(); }).filter(Boolean);
    }

    function words(s) { return s.toLowerCase().match(/[a-z][a-z'-]*/g) || []; }

    function translationOnly(text, name) {
        if (!TR.test(text || '')) return false;
        var own = new Set(words(String(name || '')));   // the game's name may come up
        return sentences(text).every(function (s) {
            if (NEG.test(s)) {
                if (!TR.test(s) && NONUSE.test(s)) return true;   // "no AI was used for art"
                if (TR.test(s)) s = s.slice(0, s.search(NEG));    // what comes before the negation
                if (!TR.test(s) && !AIUSE.test(s)) return true;
            } else if (!TR.test(s) && !AIUSE.test(s) && HUMAN.test(s)) return true;
            if (WRITING.test(s)) return false;
            return words(s).every(function (w) { return ALLOW.has(w) || LANGS.test(w) || own.has(w.replace(/'s$/, '')); });
        });
    }

    var AI = /\b(ai|llms?|large language models?|language models?|generative|neural|chat ?gpt|gpt-?\d\w*|openai|ollama|llama|gemini|claude|deepseek|local model|vision-language model)\b/i;
    var WHEN = /\b(real[- ]?time|at run[- ]?time|runtime|during (game)?play|while (you|the player|players) (are )?play\w*|while the game is running|on the fly|live(?![- ](action|voice|actors?|acting|music|recordings?|performances?|footage|streams?|orchestra))|live[- ]generat\w*|generated live|dynamic(ally)? generat\w*|generates? dynamic|dynamic (npc|narrative|dialog\w*|conversation\w*|story)|personali[sz]ed|in response to (the )?players?|based on (the )?players?'? (input|prompts?|choices|actions)|player (input|prompts?))\b/i;
    // Live AI named outright: talking with characters, an LLM behind an NPC, a model
    // that runs on the player's machine.
    var CHAT = new RegExp([
        /\b(chat|talk|convers\w*|speak|interact)\w* (freely |naturally )?with\b[^.]*\b(characters?|npcs?|ai|companion|llm)\b/.source,
        /\b(power|drive|run)s? (an? |the )?(npc|character|companion|game ?master|narrator)s?\b/.source,
        /\bai[- ](powered|driven)\s+(conversation|npc|character|dialog\w*|companion|chat|response|narrat\w*|game ?master|story ?teller)/.source,
        /\b(npc|character|companion)s?\b[^.]*\b(llm|language model|ai[- ]driven|ai[- ]powered|powered by (an? )?ai|driven by (an? )?ai)\b/.source,
        /\b(embedded|local|on-device|external|locally running) (generative )?(ai|llms?|model|ai service|ai model|text generation model)\b/.source,
        /\btext[- ]to[- ]speech\b[^.]*\b(custom names|player names?|typed|entered)\b/.source,
        /\b(llm|language model)\b[^.]*\b(game ?master|narrat\w*|judg\w*|story of your|respond\w*)/.source,
        /\bresponds? to (your|the player)/.source,
    ].join('|'), 'i');
    // Made ahead of time, during development.
    var DEV = /\b(during|in) (the )?(development|production)\b|\bpre-?generated\b|(?<!-)\b(draft\w*|wr[io]te|written|refin\w*|translat\w*|locali[sz]\w*)\b/i;
    // "Nothing is generated while you play", "icons shown during gameplay".
    var NOTLIVE = /\b(no|nothing|none|never|not|without|non-ai)\b|n't\b|\brather than\b|\b(fixed|static|pre-?made|pre-?rendered|in advance|footage|procedural\w*)\b|\b(shown|displayed|used|appear\w*|seen|featured|visible) (during|in) (the )?(gameplay|game ?play|play|game)\b/i;

    function liveAI(text) {
        return sentences(text).some(function (s) {
            if (NOTLIVE.test(s)) return false;
            if (CHAT.test(s) && !/\btranslat/i.test(s)) return true;
            return AI.test(s) && WHEN.test(s) && !DEV.test(s);
        });
    }

    // Whether a game counts as AI for the AI tab, keep = its boxes
    // ({ translation, ingame }). A game the built-in lists name goes by their
    // verdicts (`listed`, and `kept` when a ticked box keeps it), any other by
    // its page's disclosure `text` and the word rules above (`name` is the
    // game's, which its text may mention).
    function counts(game, keep) {
        if (game.listed) return !game.kept;
        if (!game.text) return false;
        if (keep.translation && translationOnly(game.text, game.name)) return false;
        return !(keep.ingame && liveAI(game.text));
    }

    // Whether the game of an open store page counts as AI under the AI tab's
    // boxes, and what decided it: { listed, name, ai }. `page`:
    //   id      the game's appid number
    //   all     every AI game of the built-in lists (ILAP.aiGames with no keep)
    //   left    the ones the ticked boxes leave (ILAP.aiGames with `keep`)
    //   text    the page's disclosure text, '' for none
    //   nameOf  () → the game's name, read only when the text decides
    // The one rule the Classic DQ ignores by (AiVerdict) and the game page's
    // AI note shows by (AiPageNote).
    function pageVerdict(page, keep) {
        var listed = page.all.has(page.id);
        var text = listed ? '' : String(page.text || '');
        var name = text ? page.nameOf() : '';
        var game = { listed: listed, kept: listed && !page.left.has(page.id), text: text, name: name };
        return { listed: listed, name: name, ai: counts(game, keep) };
    }

    var api = {
        translationOnly: translationOnly, liveAI: liveAI, fromPage: fromPage, counts: counts, pageVerdict: pageVerdict,
        HEADINGS: HEADINGS,
    };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        window.ILAP = window.ILAP || {};
        window.ILAP.AiDisclosure = api;
    }
})();
