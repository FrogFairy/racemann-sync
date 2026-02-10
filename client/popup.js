document.addEventListener('DOMContentLoaded', () => {
    const statusEl = document.getElementById('status');
    const toggleBtn = document.getElementById('toggleConnect');
    const serverUrlInput = document.getElementById('serverUrl');
    const autoConnectCheckbox = document.getElementById('autoConnect');
    const saveSettingsBtn = document.getElementById('saveSettings');

    // Загружаем настройки
    chrome.storage.local.get(['raceSyncSettings'], (result) => {
        if (result.raceSyncSettings) {
            serverUrlInput.value = result.raceSyncSettings.serverUrl || 'ws://localhost:8765';
            autoConnectCheckbox.checked = result.raceSyncSettings.autoConnect !== false;
        }
    });

    // Получаем статус
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.url?.includes('racemann.com/Race')) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'get_state' }, (response) => {
                if (response) {
                    updateUI(response);
                }
            });
        }
    });

    function updateUI(state) {
        if (state.connected) {
            statusEl.textContent = 'Подключено';
            statusEl.className = 'status connected';
            toggleBtn.textContent = 'Отключиться';
        } else {
            statusEl.textContent = 'Отключено';
            statusEl.className = 'status disconnected';
            toggleBtn.textContent = 'Подключиться';
        }
    }

    toggleBtn.addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.url?.includes('racemann.com/Race')) {
                const action = toggleBtn.textContent === 'Подключиться' ? 'connect' : 'disconnect';
                chrome.tabs.sendMessage(tabs[0].id, { action: action });
                
                toggleBtn.disabled = true;
                toggleBtn.textContent = '...';
                
                setTimeout(() => {
                    toggleBtn.disabled = false;
                    chrome.tabs.sendMessage(tabs[0].id, { action: 'get_state' }, updateUI);
                }, 500);
            }
        });
    });

    saveSettingsBtn.addEventListener('click', () => {
        const settings = {
            serverUrl: serverUrlInput.value.trim() || 'ws://localhost:8765',
            autoConnect: autoConnectCheckbox.checked
        };

        chrome.storage.local.set({ raceSyncSettings: settings }, () => {
            saveSettingsBtn.textContent = 'Сохранено!';
            saveSettingsBtn.style.background = '#28a745';
            
            setTimeout(() => {
                saveSettingsBtn.textContent = 'Сохранить';
                saveSettingsBtn.style.background = '';
            }, 1500);
        });
    });
});