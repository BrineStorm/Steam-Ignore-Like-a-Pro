(function() {
    'use strict';
    
    window.ILAP = window.ILAP || {};
    window.ILAP.QueueUI = {};

    const IDS = {
        CONTAINER: 'ilap-queue-controls',
        BUTTON: 'queue-auto-ignore-btn'
    };

    /**
     * SRP: Encapsulates CSS injection
     */
    class Styles {
        static inject() {
            if (document.getElementById('ilap-queue-styles')) return;
            const style = document.createElement('style');
            style.id = 'ilap-queue-styles';
            style.textContent = `
                .ilap-controls-container {
                    display: flex; align-items: center; gap: 10px; margin-right: 15px;
                    height: 34px; flex-grow: 0; flex-shrink: 0; font-size: 13px;
                }
                #${IDS.BUTTON} {
                    height: 32px; line-height: 30px; padding: 0 15px; font-size: 14px;
                    border-radius: 2px; cursor: pointer; font-family: "Motiva Sans", Sans-serif;
                    font-weight: normal; box-shadow: 2px 2px 5px rgba(0,0,0,0.2); white-space: nowrap;
                    background-color: #5c7e10; color: #fff; border: 1px solid #4c6b22;
                    display: flex; align-items: center; justify-content: center;
                }
                #${IDS.BUTTON}:hover { filter: brightness(1.1); }
                #${IDS.BUTTON}:active { transform: scale(0.98); }
                
                #${IDS.BUTTON}.running {
                    background-color: #d32f2f; border: 1px solid #b71c1c;
                }
                
                .ilap-checkbox-label {
                    display: flex; align-items: center; color: #8f98a0; font-size: 12px;
                    cursor: pointer; user-select: none; margin-right: 8px;
                }
                .ilap-checkbox-label:hover { color: #fff; }
                .ilap-checkbox { margin-right: 6px; margin-top: 0; cursor: pointer; }
                
                .btn-symbol { margin-right: 8px; font-size: 12px; line-height: 1; }
            `;
            document.head.appendChild(style);
        }
    }

    /**
     * SRP: Creates HTML elements
     */
    class UIFactory {
        static create(handlers) {
            const container = document.createElement('div');
            container.className = 'ilap-controls-container';
            container.id = IDS.CONTAINER;

            // Checkbox
            const label = document.createElement('label');
            label.className = 'ilap-checkbox-label';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'ilap-checkbox';
            checkbox.addEventListener('change', (e) => handlers.onCheckbox(e.target.checked));
            
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode("Keep High Score"));

            // Button
            const button = document.createElement('button');
            button.id = IDS.BUTTON;
            button.innerHTML = `<span class="btn-symbol">â</span> Start Auto Ignore`;
            button.addEventListener('click', handlers.onStartStop);

            container.appendChild(label);
            container.appendChild(button);

            return { container, button, checkbox };
        }
    }

    /**
     * SRP: Manages UI Lifecycle
     */
    class UIManager {
        constructor() {
            this.container = null;
            this.button = null;
            Styles.inject();
        }

        mount(insertionPoint, handlers) {
            if (this.container) return; // Already mounted

            const elements = UIFactory.create(handlers);
            this.container = elements.container;
            this.button = elements.button;

            if (insertionPoint.parent && !insertionPoint.parent.contains(this.container)) {
                insertionPoint.parent.insertBefore(this.container, insertionPoint.referenceNode);
            }
        }

        unmount() {
            if (this.container) {
                this.container.remove();
                this.container = null;
                this.button = null;
            }
        }

        updateState(isRunning, processedCount) {
            if (!this.button) return;
            
            if (isRunning) {
                this.button.innerHTML = `<span class="btn-symbol">â</span> Stop (${processedCount})`;
                this.button.classList.add('running');
            } else {
                this.button.innerHTML = `<span class="btn-symbol">â</span> Start Auto Ignore`;
                this.button.classList.remove('running');
            }
        }
    }

    window.ILAP.QueueUI = new UIManager();

})();