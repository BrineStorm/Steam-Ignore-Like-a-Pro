(function() {
    'use strict';
    
    window.ILAP = window.ILAP || {};
    window.ILAP.QueueUI = {};

    const CONTAINER_ID = 'ilap-queue-controls'; 
    const CONTAINER_CLASS = 'ilap-controls-container';

    // CSS fix for the container
    const CUSTOM_STYLE = `
        .ilap-controls-container {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-right: 15px;
            /* Ensure container doesn't collapse */
            height: 34px; 
            flex-grow: 0; 
            flex-shrink: 0;
            font-size: 13px;
        }
        
        #queue-auto-ignore-btn {
            height: 32px;
            line-height: 30px; /* Vertically center text */
            padding: 0 15px;
            font-size: 14px;
            border-radius: 2px;
            cursor: pointer;
            font-family: "Motiva Sans", Sans-serif;
            font-weight: normal;
            box-shadow: 2px 2px 5px rgba(0,0,0,0.2);
            white-space: nowrap;
        }

        #queue-auto-ignore-btn:hover {
            filter: brightness(1.1);
        }
        
        #queue-auto-ignore-btn:active {
            transform: scale(0.98);
        }
    `;

    const style = document.createElement('style');
    style.textContent = CUSTOM_STYLE;
    document.head.appendChild(style);

    let ui_Container = null;
    let ui_Button = null;

    window.ILAP.QueueUI.create = function(onStartStop, onCheckbox) {
        if (ui_Container) return ui_Container;

        const container = document.createElement('div');
        container.className = CONTAINER_CLASS;
        container.id = CONTAINER_ID;

        // Checkbox
        const label = document.createElement('label');
        label.className = 'ilap-checkbox-label';
        label.style.marginRight = '8px';
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        label.style.cursor = 'pointer';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'ilap-checkbox';
        checkbox.style.marginTop = '0'; // Fix alignment
        checkbox.addEventListener('change', (e) => onCheckbox(e.target.checked));
        
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode("Keep High Score"));
        
        // Button
        const button = document.createElement('button');
        button.id = "queue-auto-ignore-btn";
        button.addEventListener('click', onStartStop);
        
        // === FIX 1: Correct Text and Colors ===
        button.innerHTML = `<span class="btn-symbol">â</span> Start Auto Ignore`;
        button.style.backgroundColor = '#5c7e10'; // Steam Green
        button.style.color = '#fff';
        button.style.border = '1px solid #4c6b22';
        
        container.appendChild(label);
        container.appendChild(button);
        
        ui_Container = container;
        ui_Button = button;
        return container;
    };

    window.ILAP.QueueUI.updateState = function(isRunning, processedCount) {
        if (!ui_Button) return;
        if (isRunning) {
            ui_Button.innerHTML = `<span class="btn-symbol">â</span> Stop (${processedCount})`;
            ui_Button.classList.add('running');
            ui_Button.style.backgroundColor = '#d32f2f'; // Red
            ui_Button.style.border = '1px solid #b71c1c';
        } else {
            ui_Button.innerHTML = `<span class="btn-symbol">â</span> Start Auto Ignore`;
            ui_Button.classList.remove('running');
            ui_Button.style.backgroundColor = '#5c7e10'; // Green
            ui_Button.style.border = '1px solid #4c6b22';
        }
    };

    window.ILAP.QueueUI.remove = function() {
        if (ui_Container && ui_Container.parentElement) {
            ui_Container.remove();
        }
    };

    window.ILAP.QueueUI.findInsertionPoint = function(modal) {
        let closeBtnInner = modal.querySelector('div[aria-label="Close"]');
        
        if (!closeBtnInner) {
            const polygons = modal.querySelectorAll('polygon');
            for(const poly of polygons) {
                const points = poly.getAttribute('points');
                if (points && points.startsWith("-74.9,117.2")) {
                    closeBtnInner = poly.closest('div[role="button"]');
                    break;
                }
            }
        }

        if (closeBtnInner) {
            const wrapper = closeBtnInner.parentElement;
            if (wrapper && wrapper.classList.contains('Focusable')) {
                return {
                    parent: wrapper.parentElement, 
                    referenceNode: wrapper         
                };
            }
        }
        return null;
    };

})();