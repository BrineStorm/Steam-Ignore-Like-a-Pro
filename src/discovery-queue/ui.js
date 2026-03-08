(function() {
    'use strict';
    
    window.ILAP = window.ILAP || {};
    window.ILAP.Discovery = window.ILAP.Discovery || {};

    const IDS = {
        CONTAINER: 'ilap-queue-controls',
        BUTTON: 'queue-auto-ignore-btn'
    };

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
                
                /* FIX: White text with black outline for high contrast on any background */
                .ilap-checkbox-label {
                    display: flex; align-items: center; font-size: 12px;
                    cursor: pointer; user-select: none; margin-right: 8px;
                    color: #ffffff;
                    font-weight: 600;
                    text-shadow: 
                        1px 1px 0 #000, 
                       -1px -1px 0 #000, 
                        1px -1px 0 #000, 
                       -1px 1px 0 #000, 
                        0px 2px 4px rgba(0,0,0,0.8);
                    transition: color 0.2s;
                }
                .ilap-checkbox-label:hover { color: #66c0f4; }
                
                .ilap-checkbox { margin-right: 6px; margin-top: 0; cursor: pointer; }
                
                .btn-symbol { margin-right: 8px; font-size: 12px; line-height: 1; }
            `;
            document.head.appendChild(style);
        }
    }

    class DiscoveryQueueUI {
        constructor() {
            this.container = null;
            this.button = null;
            this.checkbox = null;
            Styles.inject();
        }

        mount(insertionPoint, events) {
            if (this.container) return; 

            this.container = document.createElement('div');
            this.container.className = 'ilap-controls-container';
            this.container.id = IDS.CONTAINER;

            const label = document.createElement('label');
            label.className = 'ilap-checkbox-label';
            
            this.checkbox = document.createElement('input');
            this.checkbox.type = 'checkbox';
            this.checkbox.className = 'ilap-checkbox';
            this.checkbox.addEventListener('change', (e) => events.onCheckboxChange(e.target.checked));
            
            label.appendChild(this.checkbox);
            label.appendChild(document.createTextNode("Keep High Score")); 

            this.button = document.createElement('button');
            this.button.id = IDS.BUTTON;
            this.button.innerHTML = `<span class="btn-symbol">â</span> Start Auto Ignore`;
            this.button.addEventListener('click', events.onToggle);

            this.container.appendChild(label);
            this.container.appendChild(this.button);

            if (insertionPoint.parent && !insertionPoint.parent.contains(this.container)) {
                insertionPoint.parent.insertBefore(this.container, insertionPoint.referenceNode);
            }
        }

        unmount() {
            if (this.container) {
                this.container.remove();
                this.container = null;
                this.button = null;
                this.checkbox = null;
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

    window.ILAP.Discovery.UI = DiscoveryQueueUI;

})();