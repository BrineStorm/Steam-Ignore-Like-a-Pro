(function() {
    'use strict';

    window.ILAP = window.ILAP || {};

    const LANGUAGES = [
        { code: 'zh-TW', name: '繁體中文',   beta: true },
        { code: 'ja',    name: '日本語',     beta: true },
        { code: 'ko',    name: '한국어',     beta: true },
        { code: 'th',    name: 'ไทย',        beta: true },
        { code: 'cs',    name: 'Čeština' },
        { code: 'de',    name: 'Deutsch' },
        { code: 'en',    name: 'English' },
        { code: 'es',    name: 'Español' },
        { code: 'el',    name: 'Ελληνικά' },
        { code: 'fr',    name: 'Français' },
        { code: 'it',    name: 'Italiano' },
        { code: 'hu',    name: 'Magyar' },
        { code: 'pl',    name: 'Polski' },
        { code: 'pt-BR', name: 'Português (BR)' },
        { code: 'ro',    name: 'Română' },
        { code: 'ru',    name: 'Русский' },
        { code: 'sr',    name: 'Srpski' },
        { code: 'tr',    name: 'Türkçe' },
        { code: 'uk',    name: 'Українська' }
    ];

    const DICT = {
        en: {
            total_ignored: "Total Ignored:",
            last_ignored: "Last Ignored:",
            none: "None",
            settings: "SETTINGS",
            hint_ignore: "Ignore:",
            hint_already_played: "Already played:",
            no_recent_history: "No recent history",
            hold_and_swipe_right: "Hold & Swipe →",
            hold_and_swipe_left: "Hold & Swipe ←",
            left_click: "L-Click",

            your_discovery_queue: "Your Discovery Queue",
            section_manual_ignore: "Manual Ignore",
            click_next_after_ignore: "Click Next after applied ignore",
            ignore_mode: "Ignore Mode:",
            mode_bad_reviews: "Bad Reviews",
            mode_every_game: "Every Game",
            default_ignore: "Default Ignore:",
            already_played: "Already Played:",
            off: "Off",
            language: "Language:",
            tooltip_dq_master: "Master toggle for Discovery Queue automation.",
            tooltip_dq_next: "Enable automatic transition ONLY when a game is successfully ignored.",
            shortcut_swipe_right: "Right-Click + Swipe →",
            shortcut_swipe_left: "Right-Click + Swipe ←",
            shortcut_ctrl_left: "Ctrl + Left-Click",
            shortcut_shift_left: "Shift + Left-Click",
            shortcut_alt_left: "Alt + Left-Click",

            keep_high_score: "Keep High Score",
            start_auto_ignore: "Start Auto Ignore",
            stop_with_count: "Stop ({count})",

            queue_helper: "Queue Helper",
            disable: "Disable",
            run_auto_ignore: "Run Auto Ignore",
            fast_forward_no_ignore: "Fast Forward (No Ignore)",
            skipping: "Skipping...",
            toast_stop: "STOP",
            toast_stopped: "STOPPED",
            fast_forwarding: "Fast Forwarding...",
            ignored_moving_next: "ignored. Moving next...",

            ignored_by: "Ignored",
            not_auto_ignored_by: "Not auto-ignored",
            ignore_criteria: "Ignore criteria",
            no_reviews_explanation: "Ignore isn't applied for games without or with insufficient reviews.",

            ignore_applied_by: "Ignore applied",
            ignored_already_played_applied_by: "Ignored (Already Played) applied"
        },

        de: {
            total_ignored: "Insgesamt ignoriert:",
            last_ignored: "Zuletzt:",
            none: "Keine",
            settings: "EINSTELLUNGEN",
            hint_ignore: "Ignorieren:",
            hint_already_played: "Bereits gespielt:",
            no_recent_history: "Kein Verlauf",
            hold_and_swipe_right: "Halten & Wischen →",
            hold_and_swipe_left: "Halten & Wischen ←",
            left_click: "L-Klick",

            your_discovery_queue: "Entdeckungsliste",
            section_manual_ignore: "Manuelles Ignorieren",
            click_next_after_ignore: "Nach Ignorieren weiter",
            ignore_mode: "Ignorier-Modus:",
            mode_bad_reviews: "Schlechte Bewertungen",
            mode_every_game: "Alle Spiele",
            default_ignore: "Standard-Geste:",
            already_played: "Bereits gespielt:",
            off: "Aus",
            language: "Sprache:",
            tooltip_dq_master: "Hauptschalter für die Automatisierung der Entdeckungsliste.",
            tooltip_dq_next: "Automatischer Übergang NUR bei erfolgreich ignoriertem Spiel.",
            shortcut_swipe_right: "Rechtsklick + Wischen →",
            shortcut_swipe_left: "Rechtsklick + Wischen ←",
            shortcut_ctrl_left: "Strg + Linksklick",
            shortcut_shift_left: "Umschalt + Linksklick",
            shortcut_alt_left: "Alt + Linksklick",

            keep_high_score: "Top-Bewertete behalten",
            start_auto_ignore: "Auto-Ignorieren starten",
            stop_with_count: "Stopp ({count})",

            queue_helper: "Listen-Helfer",
            disable: "Deaktivieren",
            run_auto_ignore: "Auto-Ignorieren ausführen",
            fast_forward_no_ignore: "Vorspulen (ohne Ignorieren)",
            skipping: "Überspringe...",
            toast_stop: "STOPP",
            toast_stopped: "GESTOPPT",
            fast_forwarding: "Spule vor...",
            ignored_moving_next: "ignoriert. Weiter...",

            ignored_by: "Ignoriert",
            not_auto_ignored_by: "Nicht automatisch ignoriert",
            ignore_criteria: "Ignorier-Kriterium",
            no_reviews_explanation: "Wird nicht auf Spiele ohne oder mit zu wenigen Reviews angewendet.",

            ignore_applied_by: "Ignoriert",
            ignored_already_played_applied_by: "Ignoriert (Gespielt)"
        },

        fr: {
            total_ignored: "Total ignorés :",
            last_ignored: "Dernier :",
            none: "Aucun",
            settings: "PARAMÈTRES",
            hint_ignore: "Ignorer :",
            hint_already_played: "Déjà joué :",
            no_recent_history: "Aucun historique",
            hold_and_swipe_right: "Maintenir + Glisser →",
            hold_and_swipe_left: "Maintenir + Glisser ←",
            left_click: "Clic G.",

            your_discovery_queue: "File de découvertes",
            section_manual_ignore: "Ignorer manuel",
            click_next_after_ignore: "Suivant après ignorer",
            ignore_mode: "Mode d'exclusion :",
            mode_bad_reviews: "Avis négatifs",
            mode_every_game: "Tous les jeux",
            default_ignore: "Action par défaut :",
            already_played: "Déjà joué :",
            off: "Désactivé",
            language: "Langue :",
            tooltip_dq_master: "Interrupteur principal de l'automatisation de la file de découvertes.",
            tooltip_dq_next: "Transition automatique UNIQUEMENT si le jeu est ignoré avec succès.",
            shortcut_swipe_right: "Clic D. + Glisser →",
            shortcut_swipe_left: "Clic D. + Glisser ←",
            shortcut_ctrl_left: "Ctrl + Clic G.",
            shortcut_shift_left: "Maj + Clic G.",
            shortcut_alt_left: "Alt + Clic G.",

            keep_high_score: "Garder les bien notés",
            start_auto_ignore: "Démarrer auto-ignore",
            stop_with_count: "Arrêter ({count})",

            queue_helper: "Assistant de file",
            disable: "Désactiver",
            run_auto_ignore: "Lancer auto-ignore",
            fast_forward_no_ignore: "Avance rapide (sans ignorer)",
            skipping: "Saut...",
            toast_stop: "ARRÊT",
            toast_stopped: "ARRÊTÉ",
            fast_forwarding: "Avance rapide...",
            ignored_moving_next: "ignoré. Suivant...",

            ignored_by: "Ignoré",
            not_auto_ignored_by: "Non auto-ignoré",
            ignore_criteria: "Critère d'exclusion",
            no_reviews_explanation: "L'exclusion ne s'applique pas aux jeux sans avis ou avec trop peu d'avis.",

            ignore_applied_by: "Ignoré",
            ignored_already_played_applied_by: "Ignoré (Déjà joué)"
        },

        es: {
            total_ignored: "Total ignorados:",
            last_ignored: "Último:",
            none: "Ninguno",
            settings: "AJUSTES",
            hint_ignore: "Ignorar:",
            hint_already_played: "Ya jugado:",
            no_recent_history: "Sin historial",
            hold_and_swipe_right: "Mantener + Deslizar →",
            hold_and_swipe_left: "Mantener + Deslizar ←",
            left_click: "Clic Izq.",

            your_discovery_queue: "Cola de descubrimiento",
            section_manual_ignore: "Ignorar manual",
            click_next_after_ignore: "Siguiente tras ignorar",
            ignore_mode: "Modo de ignorar:",
            mode_bad_reviews: "Reseñas negativas",
            mode_every_game: "Todos los juegos",
            default_ignore: "Acción por defecto:",
            already_played: "Ya jugado:",
            off: "Apagado",
            language: "Idioma:",
            tooltip_dq_master: "Interruptor maestro de la automatización de la cola de descubrimiento.",
            tooltip_dq_next: "Transición automática SOLO si el juego se ignora con éxito.",
            shortcut_swipe_right: "Clic Der. + Deslizar →",
            shortcut_swipe_left: "Clic Der. + Deslizar ←",
            shortcut_ctrl_left: "Ctrl + Clic Izq.",
            shortcut_shift_left: "Mayús + Clic Izq.",
            shortcut_alt_left: "Alt + Clic Izq.",

            keep_high_score: "Mantener los bien valorados",
            start_auto_ignore: "Iniciar auto-ignorar",
            stop_with_count: "Detener ({count})",

            queue_helper: "Asistente de cola",
            disable: "Desactivar",
            run_auto_ignore: "Ejecutar auto-ignorar",
            fast_forward_no_ignore: "Avance rápido (sin ignorar)",
            skipping: "Saltando...",
            toast_stop: "PARAR",
            toast_stopped: "DETENIDO",
            fast_forwarding: "Avance rápido...",
            ignored_moving_next: "ignorado. Siguiente...",

            ignored_by: "Ignorado",
            not_auto_ignored_by: "No auto-ignorado",
            ignore_criteria: "Criterio de ignorar",
            no_reviews_explanation: "No se ignoran los juegos sin reseñas o con insuficientes reseñas.",

            ignore_applied_by: "Ignorado",
            ignored_already_played_applied_by: "Ignorado (Ya jugado)"
        },

        el: {
            total_ignored: "Σύνολο αγνοημένων:",
            last_ignored: "Τελευταίο:",
            none: "Κανένα",
            settings: "ΡΥΘΜΙΣΕΙΣ",
            hint_ignore: "Αγνόηση:",
            hint_already_played: "Έχω παίξει:",
            no_recent_history: "Χωρίς ιστορικό",
            hold_and_swipe_right: "Κράτα + σύρε →",
            hold_and_swipe_left: "Κράτα + σύρε ←",
            left_click: "Αρ. κλικ",

            your_discovery_queue: "Ουρά ανακαλύψεων",
            section_manual_ignore: "Χειροκίνητη αγνόηση",
            click_next_after_ignore: "Επόμενο μετά την αγνόηση",
            ignore_mode: "Λειτουργία αγνόησης:",
            mode_bad_reviews: "Κακές κριτικές",
            mode_every_game: "Όλα τα παιχνίδια",
            default_ignore: "Προεπιλεγμένη ενέργεια:",
            already_played: "Έχω παίξει:",
            off: "Ανενεργό",
            language: "Γλώσσα:",
            tooltip_dq_master: "Κύριος διακόπτης για την αυτοματοποίηση της ουράς ανακαλύψεων.",
            tooltip_dq_next: "Αυτόματη μετάβαση ΜΟΝΟ όταν ένα παιχνίδι αγνοηθεί με επιτυχία.",
            shortcut_swipe_right: "Δεξί κλικ + σύρε →",
            shortcut_swipe_left: "Δεξί κλικ + σύρε ←",
            shortcut_ctrl_left: "Ctrl + αρ. κλικ",
            shortcut_shift_left: "Shift + αρ. κλικ",
            shortcut_alt_left: "Alt + αρ. κλικ",

            keep_high_score: "Διατήρηση των υψηλά βαθμολογημένων",
            start_auto_ignore: "Έναρξη αυτόματης αγνόησης",
            stop_with_count: "Διακοπή ({count})",

            queue_helper: "Βοηθός ουράς",
            disable: "Απενεργοποίηση",
            run_auto_ignore: "Εκτέλεση αυτόματης αγνόησης",
            fast_forward_no_ignore: "Γρήγορη προώθηση (χωρίς αγνόηση)",
            skipping: "Παράλειψη...",
            toast_stop: "ΣΤΟΠ",
            toast_stopped: "ΣΤΑΜΑΤΗΣΕ",
            fast_forwarding: "Γρήγορη προώθηση...",
            ignored_moving_next: "αγνοήθηκε. Επόμενο...",

            ignored_by: "Αγνοήθηκε",
            not_auto_ignored_by: "Δεν αγνοήθηκε αυτόματα",
            ignore_criteria: "Κριτήριο αγνόησης",
            no_reviews_explanation: "Η αγνόηση δεν εφαρμόζεται σε παιχνίδια χωρίς ή με ανεπαρκείς κριτικές.",

            ignore_applied_by: "Αγνοήθηκε",
            ignored_already_played_applied_by: "Αγνοήθηκε (Έχω παίξει)"
        },

        it: {
            total_ignored: "Totale ignorati:",
            last_ignored: "Ultimo:",
            none: "Nessuno",
            settings: "IMPOSTAZIONI",
            hint_ignore: "Ignora:",
            hint_already_played: "Già giocato:",
            no_recent_history: "Cronologia vuota",
            hold_and_swipe_right: "Tieni + Scorri →",
            hold_and_swipe_left: "Tieni + Scorri ←",
            left_click: "Clic Sx.",

            your_discovery_queue: "Coda di scoperta",
            section_manual_ignore: "Ignora manuale",
            click_next_after_ignore: "Avanti dopo aver ignorato",
            ignore_mode: "Modalità ignora:",
            mode_bad_reviews: "Recensioni negative",
            mode_every_game: "Tutti i giochi",
            default_ignore: "Azione predefinita:",
            already_played: "Già giocato:",
            off: "Off",
            language: "Lingua:",
            tooltip_dq_master: "Interruttore principale dell'automazione della coda di scoperta.",
            tooltip_dq_next: "Transizione automatica SOLO se il gioco viene ignorato con successo.",
            shortcut_swipe_right: "Clic Dx. + Scorri →",
            shortcut_swipe_left: "Clic Dx. + Scorri ←",
            shortcut_ctrl_left: "Ctrl + Clic Sx.",
            shortcut_shift_left: "Maiusc + Clic Sx.",
            shortcut_alt_left: "Alt + Clic Sx.",

            keep_high_score: "Mantieni i ben valutati",
            start_auto_ignore: "Avvia auto-ignora",
            stop_with_count: "Stop ({count})",

            queue_helper: "Assistente coda",
            disable: "Disabilita",
            run_auto_ignore: "Esegui auto-ignora",
            fast_forward_no_ignore: "Avanti veloce (senza ignorare)",
            skipping: "Saltando...",
            toast_stop: "STOP",
            toast_stopped: "FERMATO",
            fast_forwarding: "Avanti veloce...",
            ignored_moving_next: "ignorato. Avanti...",

            ignored_by: "Ignorato",
            not_auto_ignored_by: "Non auto-ignorato",
            ignore_criteria: "Criterio di ignora",
            no_reviews_explanation: "L'ignora non si applica ai giochi senza o con poche recensioni.",

            ignore_applied_by: "Ignorato",
            ignored_already_played_applied_by: "Ignorato (Già giocato)"
        },

        'pt-BR': {
            total_ignored: "Total ignorado:",
            last_ignored: "Último:",
            none: "Nenhum",
            settings: "CONFIGURAÇÕES",
            hint_ignore: "Ignorar:",
            hint_already_played: "Já joguei:",
            no_recent_history: "Sem histórico",
            hold_and_swipe_right: "Segurar + Arrastar →",
            hold_and_swipe_left: "Segurar + Arrastar ←",
            left_click: "Clique Esq.",

            your_discovery_queue: "Fila de descobertas",
            section_manual_ignore: "Ignorar manual",
            click_next_after_ignore: "Próximo após ignorar",
            ignore_mode: "Modo de ignorar:",
            mode_bad_reviews: "Análises ruins",
            mode_every_game: "Todos os jogos",
            default_ignore: "Ação padrão:",
            already_played: "Já joguei:",
            off: "Desligado",
            language: "Idioma:",
            tooltip_dq_master: "Interruptor principal da automação da fila de descobertas.",
            tooltip_dq_next: "Transição automática APENAS se o jogo for ignorado com sucesso.",
            shortcut_swipe_right: "Clique Dir. + Arrastar →",
            shortcut_swipe_left: "Clique Dir. + Arrastar ←",
            shortcut_ctrl_left: "Ctrl + Clique Esq.",
            shortcut_shift_left: "Shift + Clique Esq.",
            shortcut_alt_left: "Alt + Clique Esq.",

            keep_high_score: "Manter os bem avaliados",
            start_auto_ignore: "Iniciar auto-ignorar",
            stop_with_count: "Parar ({count})",

            queue_helper: "Ajudante de fila",
            disable: "Desativar",
            run_auto_ignore: "Executar auto-ignorar",
            fast_forward_no_ignore: "Avanço rápido (sem ignorar)",
            skipping: "Pulando...",
            toast_stop: "PARAR",
            toast_stopped: "PARADO",
            fast_forwarding: "Avanço rápido...",
            ignored_moving_next: "ignorado. Próximo...",

            ignored_by: "Ignorado",
            not_auto_ignored_by: "Não auto-ignorado",
            ignore_criteria: "Critério de ignorar",
            no_reviews_explanation: "Ignorar não se aplica a jogos sem análises ou com poucas análises.",

            ignore_applied_by: "Ignorado",
            ignored_already_played_applied_by: "Ignorado (Já joguei)"
        },

        tr: {
            total_ignored: "Toplam yoksayılan:",
            last_ignored: "Sonuncu:",
            none: "Yok",
            settings: "AYARLAR",
            hint_ignore: "Yoksay:",
            hint_already_played: "Zaten oynadım:",
            no_recent_history: "Geçmiş yok",
            hold_and_swipe_right: "Basılı tut + Sağa kaydır",
            hold_and_swipe_left: "Basılı tut + Sola kaydır",
            left_click: "Sol Tık",

            your_discovery_queue: "Keşif Sıranız",
            section_manual_ignore: "Manuel Yoksayma",
            click_next_after_ignore: "Yoksaydıktan sonra İleri",
            ignore_mode: "Yoksayma modu:",
            mode_bad_reviews: "Kötü incelemeler",
            mode_every_game: "Tüm oyunlar",
            default_ignore: "Varsayılan eylem:",
            already_played: "Zaten oynadım:",
            off: "Kapalı",
            language: "Dil:",
            tooltip_dq_master: "Keşif sırası otomasyonu için ana anahtar.",
            tooltip_dq_next: "Otomatik geçiş SADECE oyun başarıyla yoksayılırsa.",
            shortcut_swipe_right: "Sağ Tık + Sağa kaydır",
            shortcut_swipe_left: "Sağ Tık + Sola kaydır",
            shortcut_ctrl_left: "Ctrl + Sol Tık",
            shortcut_shift_left: "Shift + Sol Tık",
            shortcut_alt_left: "Alt + Sol Tık",

            keep_high_score: "Yüksek puanlıları tut",
            start_auto_ignore: "Otomatik yoksaymayı başlat",
            stop_with_count: "Durdur ({count})",

            queue_helper: "Sıra Yardımcısı",
            disable: "Devre dışı bırak",
            run_auto_ignore: "Oto yoksaymayı çalıştır",
            fast_forward_no_ignore: "İleri sar (yoksaymadan)",
            skipping: "Atlanıyor...",
            toast_stop: "DUR",
            toast_stopped: "DURDU",
            fast_forwarding: "İleri sarılıyor...",
            ignored_moving_next: "yoksayıldı. Sonraki...",

            ignored_by: "Yoksayıldı",
            not_auto_ignored_by: "Otomatik yoksayılmadı",
            ignore_criteria: "Yoksayma kriteri",
            no_reviews_explanation: "İncelemesi olmayan veya yetersiz olan oyunlar yoksayılmaz.",

            ignore_applied_by: "Yoksayıldı",
            ignored_already_played_applied_by: "Yoksayıldı (Oynadım)"
        },

        ru: {
            total_ignored: "Всего скрыто:",
            last_ignored: "Последняя:",
            none: "Нет",
            settings: "НАСТРОЙКИ",
            hint_ignore: "Скрыть:",
            hint_already_played: "Уже играли:",
            no_recent_history: "История пуста",
            hold_and_swipe_right: "Удерж. + свайп →",
            hold_and_swipe_left: "Удерж. + свайп ←",
            left_click: "ЛКМ",

            your_discovery_queue: "Очередь рекомендаций",
            section_manual_ignore: "Ручное скрытие",
            click_next_after_ignore: "Далее после скрытия",
            ignore_mode: "Режим скрытия:",
            mode_bad_reviews: "Плохие отзывы",
            mode_every_game: "Все игры",
            default_ignore: "Основное действие:",
            already_played: "Уже играли:",
            off: "Откл.",
            language: "Язык:",
            tooltip_dq_master: "Главный переключатель автоматизации очереди рекомендаций.",
            tooltip_dq_next: "Автопереход ТОЛЬКО при успешном скрытии игры.",
            shortcut_swipe_right: "ПКМ + свайп →",
            shortcut_swipe_left: "ПКМ + свайп ←",
            shortcut_ctrl_left: "Ctrl + ЛКМ",
            shortcut_shift_left: "Shift + ЛКМ",
            shortcut_alt_left: "Alt + ЛКМ",

            keep_high_score: "Оставлять топовые",
            start_auto_ignore: "Старт автоскрытия",
            stop_with_count: "Стоп ({count})",

            queue_helper: "Помощник очереди",
            disable: "Отключить",
            run_auto_ignore: "Запустить автоскрытие",
            fast_forward_no_ignore: "Промотать (без скрытия)",
            skipping: "Пропуск...",
            toast_stop: "СТОП",
            toast_stopped: "ОСТАНОВЛЕНО",
            fast_forwarding: "Промотка...",
            ignored_moving_next: "— скрыто. Дальше...",

            ignored_by: "Скрыто",
            not_auto_ignored_by: "Автоскрытие не применено",
            ignore_criteria: "Критерий скрытия",
            no_reviews_explanation: "Скрытие не работает для игр без/с малым числом отзывов.",

            ignore_applied_by: "Скрыто",
            ignored_already_played_applied_by: "Скрыто (Уже играли)"
        },

        uk: {
            total_ignored: "Усього приховано:",
            last_ignored: "Останнє:",
            none: "Немає",
            settings: "НАЛАШТУВАННЯ",
            hint_ignore: "Приховати:",
            hint_already_played: "Вже грали:",
            no_recent_history: "Історія порожня",
            hold_and_swipe_right: "Утримуй + свайп →",
            hold_and_swipe_left: "Утримуй + свайп ←",
            left_click: "ЛКМ",

            your_discovery_queue: "Черга рекомендацій",
            section_manual_ignore: "Ручне приховування",
            click_next_after_ignore: "Далі після приховування",
            ignore_mode: "Режим приховування:",
            mode_bad_reviews: "Погані відгуки",
            mode_every_game: "Усі ігри",
            default_ignore: "Основна дія:",
            already_played: "Вже грали:",
            off: "Вимк.",
            language: "Мова:",
            tooltip_dq_master: "Головний перемикач автоматизації черги рекомендацій.",
            tooltip_dq_next: "Автоперехід ЛИШЕ при успішному прихованні гри.",
            shortcut_swipe_right: "ПКМ + свайп →",
            shortcut_swipe_left: "ПКМ + свайп ←",
            shortcut_ctrl_left: "Ctrl + ЛКМ",
            shortcut_shift_left: "Shift + ЛКМ",
            shortcut_alt_left: "Alt + ЛКМ",

            keep_high_score: "Залишати топові",
            start_auto_ignore: "Старт автоприховування",
            stop_with_count: "Стоп ({count})",

            queue_helper: "Помічник черги",
            disable: "Вимкнути",
            run_auto_ignore: "Запустити автоприховування",
            fast_forward_no_ignore: "Промотати (без приховування)",
            skipping: "Пропуск...",
            toast_stop: "СТОП",
            toast_stopped: "ЗУПИНЕНО",
            fast_forwarding: "Промотування...",
            ignored_moving_next: "— приховано. Далі...",

            ignored_by: "Приховано",
            not_auto_ignored_by: "Автоприховування не застосовано",
            ignore_criteria: "Критерій приховування",
            no_reviews_explanation: "Приховування не діє для ігор без/з малою кількістю відгуків.",

            ignore_applied_by: "Приховано",
            ignored_already_played_applied_by: "Приховано (Вже грали)"
        },

        pl: {
            total_ignored: "Łącznie ukryto:",
            last_ignored: "Ostatnio:",
            none: "Brak",
            settings: "USTAWIENIA",
            hint_ignore: "Ukryj:",
            hint_already_played: "Ograne:",
            no_recent_history: "Brak historii",
            hold_and_swipe_right: "Przytrzymaj + przesuń →",
            hold_and_swipe_left: "Przytrzymaj + przesuń ←",
            left_click: "LPM",

            your_discovery_queue: "Kolejka odkryć",
            section_manual_ignore: "Ukrywanie ręczne",
            click_next_after_ignore: "Dalej po ukryciu",
            ignore_mode: "Tryb ukrywania:",
            mode_bad_reviews: "Złe recenzje",
            mode_every_game: "Wszystkie gry",
            default_ignore: "Domyślna akcja:",
            already_played: "Ograne:",
            off: "Wył.",
            language: "Język:",
            tooltip_dq_master: "Główny przełącznik automatyzacji kolejki odkryć.",
            tooltip_dq_next: "Przejście automatyczne TYLKO przy pomyślnym ukryciu gry.",
            shortcut_swipe_right: "PPM + przesuń →",
            shortcut_swipe_left: "PPM + przesuń ←",
            shortcut_ctrl_left: "Ctrl + LPM",
            shortcut_shift_left: "Shift + LPM",
            shortcut_alt_left: "Alt + LPM",

            keep_high_score: "Zachowaj wysoko oceniane",
            start_auto_ignore: "Start auto-ukrywania",
            stop_with_count: "Stop ({count})",

            queue_helper: "Pomocnik kolejki",
            disable: "Wyłącz",
            run_auto_ignore: "Uruchom auto-ukrywanie",
            fast_forward_no_ignore: "Przewiń (bez ukrywania)",
            skipping: "Pomijanie...",
            toast_stop: "STOP",
            toast_stopped: "ZATRZYMANO",
            fast_forwarding: "Przewijanie...",
            ignored_moving_next: "— ukryto. Dalej...",

            ignored_by: "Ukryto",
            not_auto_ignored_by: "Nie ukryto automatycznie",
            ignore_criteria: "Kryterium ukrywania",
            no_reviews_explanation: "Ukrywanie nie działa dla gier bez lub z małą liczbą recenzji.",

            ignore_applied_by: "Ukryto",
            ignored_already_played_applied_by: "Ukryto (Ograne)"
        },

        cs: {
            total_ignored: "Celkem skryto:",
            last_ignored: "Poslední:",
            none: "Žádná",
            settings: "NASTAVENÍ",
            hint_ignore: "Skrýt:",
            hint_already_played: "Už jste hráli:",
            no_recent_history: "Historie prázdná",
            hold_and_swipe_right: "Drž + táhni →",
            hold_and_swipe_left: "Drž + táhni ←",
            left_click: "LTM",

            your_discovery_queue: "Fronta objevů",
            section_manual_ignore: "Ruční skrytí",
            click_next_after_ignore: "Další po skrytí",
            ignore_mode: "Režim skrývání:",
            mode_bad_reviews: "Špatné recenze",
            mode_every_game: "Všechny hry",
            default_ignore: "Výchozí akce:",
            already_played: "Už jste hráli:",
            off: "Vyp.",
            language: "Jazyk:",
            tooltip_dq_master: "Hlavní přepínač automatizace fronty objevů.",
            tooltip_dq_next: "Automatický přechod POUZE při úspěšném skrytí hry.",
            shortcut_swipe_right: "PTM + táhni →",
            shortcut_swipe_left: "PTM + táhni ←",
            shortcut_ctrl_left: "Ctrl + LTM",
            shortcut_shift_left: "Shift + LTM",
            shortcut_alt_left: "Alt + LTM",

            keep_high_score: "Zachovat vysoce hodnocené",
            start_auto_ignore: "Spustit auto-skrývání",
            stop_with_count: "Stop ({count})",

            queue_helper: "Pomocník fronty",
            disable: "Zakázat",
            run_auto_ignore: "Provést auto-skrývání",
            fast_forward_no_ignore: "Přeskočit (bez skrývání)",
            skipping: "Přeskakuji...",
            toast_stop: "STOP",
            toast_stopped: "ZASTAVENO",
            fast_forwarding: "Rychlé přetáčení...",
            ignored_moving_next: "— skryto. Další...",

            ignored_by: "Skryto",
            not_auto_ignored_by: "Automaticky neskryto",
            ignore_criteria: "Kritérium skrývání",
            no_reviews_explanation: "Skrývání se nevztahuje na hry bez recenzí nebo s nedostatkem recenzí.",

            ignore_applied_by: "Skryto",
            ignored_already_played_applied_by: "Skryto (Už jste hráli)"
        },

        hu: {
            total_ignored: "Összesen mellőzve:",
            last_ignored: "Legutóbbi:",
            none: "Nincs",
            settings: "BEÁLLÍTÁSOK",
            hint_ignore: "Mellőzés:",
            hint_already_played: "Már játszottam:",
            no_recent_history: "Nincs előzmény",
            hold_and_swipe_right: "Tartsd + húzd →",
            hold_and_swipe_left: "Tartsd + húzd ←",
            left_click: "Bal klikk",

            your_discovery_queue: "Felfedező lista",
            section_manual_ignore: "Kézi mellőzés",
            click_next_after_ignore: "Tovább a mellőzés után",
            ignore_mode: "Mellőzési mód:",
            mode_bad_reviews: "Rossz értékelések",
            mode_every_game: "Minden játék",
            default_ignore: "Alapértelmezett művelet:",
            already_played: "Már játszottam:",
            off: "Ki",
            language: "Nyelv:",
            tooltip_dq_master: "A felfedező lista automatizálásának főkapcsolója.",
            tooltip_dq_next: "Automatikus továbblépés CSAK sikeres mellőzés esetén.",
            shortcut_swipe_right: "Jobb klikk + húzás →",
            shortcut_swipe_left: "Jobb klikk + húzás ←",
            shortcut_ctrl_left: "Ctrl + bal klikk",
            shortcut_shift_left: "Shift + bal klikk",
            shortcut_alt_left: "Alt + bal klikk",

            keep_high_score: "Magas pontszámúak megtartása",
            start_auto_ignore: "Auto-mellőzés indítása",
            stop_with_count: "Leállítás ({count})",

            queue_helper: "Lista-segéd",
            disable: "Letiltás",
            run_auto_ignore: "Auto-mellőzés futtatása",
            fast_forward_no_ignore: "Előretekerés (mellőzés nélkül)",
            skipping: "Kihagyás...",
            toast_stop: "STOP",
            toast_stopped: "LEÁLLÍTVA",
            fast_forwarding: "Előretekerés...",
            ignored_moving_next: "mellőzve. Tovább...",

            ignored_by: "Mellőzve",
            not_auto_ignored_by: "Nincs automatikusan mellőzve",
            ignore_criteria: "Mellőzési feltétel",
            no_reviews_explanation: "A mellőzés nem vonatkozik értékelés nélküli vagy kevés értékelésű játékokra.",

            ignore_applied_by: "Mellőzve",
            ignored_already_played_applied_by: "Mellőzve (Már játszottam)"
        },

        sr: {
            total_ignored: "Ukupno ignorisano:",
            last_ignored: "Poslednje:",
            none: "Nema",
            settings: "PODEŠAVANJA",
            hint_ignore: "Ignoriši:",
            hint_already_played: "Već igrano:",
            no_recent_history: "Nema istorije",
            hold_and_swipe_right: "Drži + prevuci →",
            hold_and_swipe_left: "Drži + prevuci ←",
            left_click: "Levi klik",

            your_discovery_queue: "Red otkrića",
            section_manual_ignore: "Ručno ignorisanje",
            click_next_after_ignore: "Dalje nakon ignorisanja",
            ignore_mode: "Režim ignorisanja:",
            mode_bad_reviews: "Loše recenzije",
            mode_every_game: "Sve igre",
            default_ignore: "Podrazumevana akcija:",
            already_played: "Već igrano:",
            off: "Isključeno",
            language: "Jezik:",
            tooltip_dq_master: "Glavni prekidač za automatizaciju reda otkrića.",
            tooltip_dq_next: "Automatski prelaz SAMO kada je igra uspešno ignorisana.",
            shortcut_swipe_right: "Desni klik + prevuci →",
            shortcut_swipe_left: "Desni klik + prevuci ←",
            shortcut_ctrl_left: "Ctrl + levi klik",
            shortcut_shift_left: "Shift + levi klik",
            shortcut_alt_left: "Alt + levi klik",

            keep_high_score: "Zadrži visoko ocenjene",
            start_auto_ignore: "Pokreni auto-ignorisanje",
            stop_with_count: "Zaustavi ({count})",

            queue_helper: "Pomoćnik reda",
            disable: "Onemogući",
            run_auto_ignore: "Izvrši auto-ignorisanje",
            fast_forward_no_ignore: "Premotaj (bez ignorisanja)",
            skipping: "Preskakanje...",
            toast_stop: "STOP",
            toast_stopped: "ZAUSTAVLJENO",
            fast_forwarding: "Premotavanje...",
            ignored_moving_next: "ignorisano. Dalje...",

            ignored_by: "Ignorisano",
            not_auto_ignored_by: "Nije automatski ignorisano",
            ignore_criteria: "Kriterijum ignorisanja",
            no_reviews_explanation: "Ignorisanje se ne primenjuje na igre bez ili sa nedovoljno recenzija.",

            ignore_applied_by: "Ignorisano",
            ignored_already_played_applied_by: "Ignorisano (Već igrano)"
        },

        ro: {
            total_ignored: "Total ignorate:",
            last_ignored: "Ultimul:",
            none: "Niciunul",
            settings: "SETĂRI",
            hint_ignore: "Ignoră:",
            hint_already_played: "Deja jucat:",
            no_recent_history: "Fără istoric",
            hold_and_swipe_right: "Ține + glisează →",
            hold_and_swipe_left: "Ține + glisează ←",
            left_click: "Clic stâng",

            your_discovery_queue: "Coada de descoperiri",
            section_manual_ignore: "Ignorare manuală",
            click_next_after_ignore: "Următorul după ignorare",
            ignore_mode: "Mod de ignorare:",
            mode_bad_reviews: "Recenzii proaste",
            mode_every_game: "Toate jocurile",
            default_ignore: "Acțiune implicită:",
            already_played: "Deja jucat:",
            off: "Oprit",
            language: "Limbă:",
            tooltip_dq_master: "Comutator principal pentru automatizarea cozii de descoperiri.",
            tooltip_dq_next: "Tranziție automată DOAR când jocul este ignorat cu succes.",
            shortcut_swipe_right: "Clic dreapta + glisează →",
            shortcut_swipe_left: "Clic dreapta + glisează ←",
            shortcut_ctrl_left: "Ctrl + clic stâng",
            shortcut_shift_left: "Shift + clic stâng",
            shortcut_alt_left: "Alt + clic stâng",

            keep_high_score: "Păstrează cele bine notate",
            start_auto_ignore: "Pornește auto-ignorarea",
            stop_with_count: "Oprește ({count})",

            queue_helper: "Asistent coadă",
            disable: "Dezactivează",
            run_auto_ignore: "Rulează auto-ignorarea",
            fast_forward_no_ignore: "Derulare rapidă (fără ignorare)",
            skipping: "Se omite...",
            toast_stop: "STOP",
            toast_stopped: "OPRIT",
            fast_forwarding: "Derulare rapidă...",
            ignored_moving_next: "ignorat. Următorul...",

            ignored_by: "Ignorat",
            not_auto_ignored_by: "Neignorat automat",
            ignore_criteria: "Criteriu de ignorare",
            no_reviews_explanation: "Ignorarea nu se aplică jocurilor fără recenzii sau cu recenzii insuficiente.",

            ignore_applied_by: "Ignorat",
            ignored_already_played_applied_by: "Ignorat (Deja jucat)"
        },

        ja: {
            total_ignored: "無視した数:",
            last_ignored: "最後の無視:",
            none: "なし",
            settings: "設定",
            hint_ignore: "無視:",
            hint_already_played: "プレイ済み:",
            no_recent_history: "履歴なし",
            hold_and_swipe_right: "スワイプ →",
            hold_and_swipe_left: "スワイプ ←",
            left_click: "左クリック",

            your_discovery_queue: "発見キュー",
            section_manual_ignore: "手動で無視",
            click_next_after_ignore: "無視した後に次へ",
            ignore_mode: "無視モード:",
            mode_bad_reviews: "低評価のみ",
            mode_every_game: "すべてのゲーム",
            default_ignore: "標準の無視:",
            already_played: "プレイ済み:",
            off: "オフ",
            language: "言語:",
            tooltip_dq_master: "発見キュー自動化のメインスイッチ。",
            tooltip_dq_next: "ゲームの無視に成功した場合のみ自動で次へ進む。",
            shortcut_swipe_right: "右クリック + 右スワイプ",
            shortcut_swipe_left: "右クリック + 左スワイプ",
            shortcut_ctrl_left: "Ctrl + 左クリック",
            shortcut_shift_left: "Shift + 左クリック",
            shortcut_alt_left: "Alt + 左クリック",

            keep_high_score: "高評価は残す",
            start_auto_ignore: "自動無視を開始",
            stop_with_count: "停止 ({count})",

            queue_helper: "キューヘルパー",
            disable: "無効化",
            run_auto_ignore: "自動無視を実行",
            fast_forward_no_ignore: "早送り (無視せず)",
            skipping: "スキップ中...",
            toast_stop: "停止",
            toast_stopped: "停止済み",
            fast_forwarding: "早送り中...",
            ignored_moving_next: "を無視しました。次へ...",

            ignored_by: "無視済み",
            not_auto_ignored_by: "自動無視スキップ",
            ignore_criteria: "無視基準",
            no_reviews_explanation: "レビューがない、または少ないゲームには適用されません。",

            ignore_applied_by: "無視を適用",
            ignored_already_played_applied_by: "無視 (プレイ済み) を適用"
        },

        ko: {
            total_ignored: "전체 숨김:",
            last_ignored: "마지막:",
            none: "없음",
            settings: "설정",
            hint_ignore: "숨김:",
            hint_already_played: "이미 플레이함:",
            no_recent_history: "기록 없음",
            hold_and_swipe_right: "스와이프 →",
            hold_and_swipe_left: "스와이프 ←",
            left_click: "좌클릭",

            your_discovery_queue: "탐색 큐",
            section_manual_ignore: "수동 숨김",
            click_next_after_ignore: "숨김 후 자동 다음",
            ignore_mode: "숨김 모드:",
            mode_bad_reviews: "낮은 평가",
            mode_every_game: "모든 게임",
            default_ignore: "기본 동작:",
            already_played: "이미 플레이함:",
            off: "끔",
            language: "언어:",
            tooltip_dq_master: "탐색 큐 자동화의 메인 스위치.",
            tooltip_dq_next: "게임을 성공적으로 숨겼을 때만 자동으로 다음으로 이동.",
            shortcut_swipe_right: "우클릭 + 오른쪽 스와이프",
            shortcut_swipe_left: "우클릭 + 왼쪽 스와이프",
            shortcut_ctrl_left: "Ctrl + 좌클릭",
            shortcut_shift_left: "Shift + 좌클릭",
            shortcut_alt_left: "Alt + 좌클릭",

            keep_high_score: "고평가는 유지",
            start_auto_ignore: "자동 숨김 시작",
            stop_with_count: "정지 ({count})",

            queue_helper: "큐 도우미",
            disable: "비활성화",
            run_auto_ignore: "자동 숨김 실행",
            fast_forward_no_ignore: "건너뛰기 (숨김 없음)",
            skipping: "건너뛰는 중...",
            toast_stop: "정지",
            toast_stopped: "정지됨",
            fast_forwarding: "빨리 감기...",
            ignored_moving_next: "숨김 완료. 다음...",

            ignored_by: "숨김 처리",
            not_auto_ignored_by: "자동 숨김 안 됨",
            ignore_criteria: "숨김 기준",
            no_reviews_explanation: "평가가 없거나 부족한 게임에는 숨김이 적용되지 않습니다.",

            ignore_applied_by: "숨김 적용",
            ignored_already_played_applied_by: "숨김 (이미 플레이함) 적용"
        },

        'zh-TW': {
            total_ignored: "已忽略總數:",
            last_ignored: "最近:",
            none: "無",
            settings: "設定",
            hint_ignore: "忽略:",
            hint_already_played: "已玩過:",
            no_recent_history: "無記錄",
            hold_and_swipe_right: "右滑 →",
            hold_and_swipe_left: "左滑 ←",
            left_click: "左鍵",

            your_discovery_queue: "探索佇列",
            section_manual_ignore: "手動忽略",
            click_next_after_ignore: "忽略後自動下一款",
            ignore_mode: "忽略模式:",
            mode_bad_reviews: "負評遊戲",
            mode_every_game: "所有遊戲",
            default_ignore: "預設動作:",
            already_played: "已玩過:",
            off: "關閉",
            language: "語言:",
            tooltip_dq_master: "探索佇列自動化的主開關。",
            tooltip_dq_next: "僅在成功忽略遊戲時自動進入下一個。",
            shortcut_swipe_right: "右鍵 + 右滑",
            shortcut_swipe_left: "右鍵 + 左滑",
            shortcut_ctrl_left: "Ctrl + 左鍵",
            shortcut_shift_left: "Shift + 左鍵",
            shortcut_alt_left: "Alt + 左鍵",

            keep_high_score: "保留高評價",
            start_auto_ignore: "開始自動忽略",
            stop_with_count: "停止 ({count})",

            queue_helper: "佇列助手",
            disable: "停用",
            run_auto_ignore: "執行自動忽略",
            fast_forward_no_ignore: "快轉 (不忽略)",
            skipping: "略過中...",
            toast_stop: "停止",
            toast_stopped: "已停止",
            fast_forwarding: "快轉中...",
            ignored_moving_next: "已忽略。下一個...",

            ignored_by: "已忽略",
            not_auto_ignored_by: "未自動忽略",
            ignore_criteria: "忽略條件",
            no_reviews_explanation: "對沒有或評價不足的遊戲不套用忽略。",

            ignore_applied_by: "套用忽略",
            ignored_already_played_applied_by: "套用忽略 (已玩過)"
        },

        th: {
            total_ignored: "ที่ซ่อนทั้งหมด:",
            last_ignored: "ล่าสุด:",
            none: "ไม่มี",
            settings: "ตั้งค่า",
            hint_ignore: "ซ่อน:",
            hint_already_played: "เคยเล่นแล้ว:",
            no_recent_history: "ไม่มีประวัติ",
            hold_and_swipe_right: "ปัดขวา →",
            hold_and_swipe_left: "ปัดซ้าย ←",
            left_click: "คลิกซ้าย",

            your_discovery_queue: "คิวค้นพบ",
            section_manual_ignore: "ซ่อนด้วยมือ",
            click_next_after_ignore: "ถัดไปหลังซ่อน",
            ignore_mode: "โหมดซ่อน:",
            mode_bad_reviews: "รีวิวแย่",
            mode_every_game: "ทุกเกม",
            default_ignore: "การกระทำหลัก:",
            already_played: "เคยเล่นแล้ว:",
            off: "ปิด",
            language: "ภาษา:",
            tooltip_dq_master: "สวิตช์หลักสำหรับระบบอัตโนมัติของคิวค้นพบ",
            tooltip_dq_next: "เปลี่ยนอัตโนมัติเฉพาะเมื่อซ่อนเกมสำเร็จเท่านั้น",
            shortcut_swipe_right: "คลิกขวา + ปัดขวา",
            shortcut_swipe_left: "คลิกขวา + ปัดซ้าย",
            shortcut_ctrl_left: "Ctrl + คลิกซ้าย",
            shortcut_shift_left: "Shift + คลิกซ้าย",
            shortcut_alt_left: "Alt + คลิกซ้าย",

            keep_high_score: "คงเกมเรตติ้งสูง",
            start_auto_ignore: "เริ่มซ่อนอัตโนมัติ",
            stop_with_count: "หยุด ({count})",

            queue_helper: "ตัวช่วยคิว",
            disable: "ปิดใช้งาน",
            run_auto_ignore: "รันซ่อนอัตโนมัติ",
            fast_forward_no_ignore: "เดินหน้าเร็ว (ไม่ซ่อน)",
            skipping: "กำลังข้าม...",
            toast_stop: "หยุด",
            toast_stopped: "หยุดแล้ว",
            fast_forwarding: "เดินหน้าเร็ว...",
            ignored_moving_next: "ซ่อนแล้ว ถัดไป...",

            ignored_by: "ซ่อนแล้ว",
            not_auto_ignored_by: "ไม่ได้ซ่อนอัตโนมัติ",
            ignore_criteria: "เกณฑ์ซ่อน",
            no_reviews_explanation: "จะไม่ซ่อนเกมที่รีวิวไม่เพียงพอ",

            ignore_applied_by: "ซ่อนแล้ว",
            ignored_already_played_applied_by: "ซ่อนแล้ว (เคยเล่นแล้ว)"
        }
    };

    let currentLang = 'en';

    function t(key, params) {
        const bundle = DICT[currentLang] || DICT.en;
        let str;
        if (bundle && Object.prototype.hasOwnProperty.call(bundle, key)) {
            str = bundle[key];
        } else if (Object.prototype.hasOwnProperty.call(DICT.en, key)) {
            str = DICT.en[key];
        } else {
            return key;
        }
        if (params) {
            for (const p in params) {
                str = str.split('{' + p + '}').join(params[p]);
            }
        }
        return str;
    }

    function setLang(code) {
        currentLang = DICT[code] ? code : 'en';
    }

    function getLang() { return currentLang; }

    function getLanguages() {
        return LANGUAGES.map(l => Object.assign({}, l, { translated: !!DICT[l.code] }));
    }

    function applyDom(root) {
        const r = root || document;
        r.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            el.textContent = t(key);
        });
        r.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            el.title = t(key);
        });
    }

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
            chrome.storage.local.get('ilap_lang', (res) => {
                if (chrome.runtime && chrome.runtime.lastError) return;
                if (res && res.ilap_lang) setLang(res.ilap_lang);
            });
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local' || !changes.ilap_lang) return;
                setLang(changes.ilap_lang.newValue);
            });
        } catch (e) { /* ignore */ }
    }

    window.ILAP.t = t;
    window.ILAP.i18n = { setLang, getLang, getLanguages, applyDom };

    // Storage migration shim: legacy gesture-shortcut values → current names.
    // Parked here because i18n.js is the only module loaded in BOTH the content
    // script and the popup, so every storage read path can share one normalizer.
    const LEGACY_SHORTCUTS = { swipeRightRight: 'swipeRight', swipeRightLeft: 'swipeLeft' };
    window.ILAP.normalizeShortcut = (value) => LEGACY_SHORTCUTS[value] || value;
})();
