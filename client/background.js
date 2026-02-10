// Background service worker для расширения
console.log('RaceMann Sync: Background script загружен');

// Хранилище для данных расширения
let syncState = {
    connected: false,
    currentTeam: null,
    serverUrl: 'ws://localhost:8765',
    autoConnect: true
};

// Слушаем сообщения от content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background получил сообщение:', message);
    
    switch(message.action) {
        case 'get_state':
            sendResponse(syncState);
            break;
            
        case 'update_team':
            syncState.currentTeam = message.team;
            chrome.storage.local.set({ syncState });
            sendResponse({ success: true });
            break;
            
        case 'update_settings':
            Object.assign(syncState, message.settings);
            chrome.storage.local.set({ syncState });
            sendResponse({ success: true });
            break;
    }
    
    return true; // Для асинхронного ответа
});

// Восстанавливаем состояние при запуске
chrome.runtime.onStartup.addListener(() => {
    chrome.storage.local.get(['syncState'], (result) => {
        if (result.syncState) {
            syncState = result.syncState;
        }
    });
});

// Обработка установки/обновления расширения
chrome.runtime.onInstalled.addListener((details) => {
    console.log('Расширение установлено/обновлено:', details.reason);
    
    // Устанавливаем начальные настройки
    chrome.storage.local.set({ 
        syncState,
        installed: true,
        version: '1.0.0'
    });
});