class RaceManagerSync {
    constructor() {
        this.currentTeam = null;
        this.wsConnection = null;
        this.isConnected = false;
        this.serverUrl = 'ws://localhost:8765';
        this.settings = {
            autoConnect: true,
            serverUrl: 'ws://localhost:8765'
        };
        
        // Ключ для localStorage
        this.storageKeyPrefix = null;
        this.raceId = null;
        
        // Локальное состояние
        this.localKartStates = {};
        this.serverStateVersion = 0;
        
        // Интервалы
        this.syncInterval = null;
        this.statusCheckInterval = null;
        
        // Флаги
        this.isSyncing = false;
        this.initialized = false;
        
        // Дебаг
        this.debug = true;
        
        this.init();
    }

    async init() {
        console.log('RaceMann Sync: Инициализация класса');
        await this.loadSettings();
        this.createStatusUI();
        this.waitForManagerTab();
    }

    log(...args) {
        if (this.debug) {
            console.log('RaceMann Sync:', ...args);
        }
    }

    async loadSettings() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['raceSyncSettings'], (result) => {
                if (result.raceSyncSettings) {
                    this.settings = { ...this.settings, ...result.raceSyncSettings };
                    this.serverUrl = this.settings.serverUrl;
                    this.log('Настройки загружены:', this.settings);
                }
                resolve();
            });
        });
    }

    waitForManagerTab() {
        this.log('Ожидание менеджера гонки...');
        
        const observer = new MutationObserver(() => {
            const managerTab = document.getElementById('mngTab');
            
            if (managerTab && managerTab.style.display !== 'none') {
                this.log('Менеджер гонки обнаружен');
                observer.disconnect();
                
                this.detectRaceId();
                this.setupTeamMonitoring();
                this.initializeLocalState();
                
                if (this.settings.autoConnect) {
                    setTimeout(() => this.connectToServer(), 1000);
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'display']
        });
    }

    detectRaceId() {
        // Извлекаем ID гонки из локального хранилища
        const urlMatch = localStorage.getItem('lastRaceId');
        if (urlMatch) {
            this.raceId = urlMatch;
            this.storageKeyPrefix = `carGood${this.raceId}`;
            this.log('ID гонки определен:', this.raceId);
            this.log('Префикс ключа:', this.storageKeyPrefix);
        } else {
            this.log('Не удалось определить ID гонки');
        }
    }

    setupTeamMonitoring() {
        this.log('Настройка мониторинга команды');
        this.detectCurrentTeam();
        
        const teamSelect = document.getElementById('mng-comp-select');
        if (teamSelect) {
            this.log('Select команды найден');
            teamSelect.addEventListener('change', () => {
                const newTeam = teamSelect.options[teamSelect.selectedIndex].text;
                this.log('Изменение команды:', newTeam);
                if (newTeam && newTeam !== this.currentTeam && teamSelect.options[teamSelect.selectedIndex].text !== 'Выбери команду') {
                    this.currentTeam = newTeam;
                    this.localKartStates = {};
                    this.serverStateVersion = 0;
                    
                    if (this.isConnected) {
                        this.sendTeamSelection();
                    } else {
                        this.log('Не подключены к серверу, команда не отправлена');
                    }
                }
            });
        } else {
            this.log('Select команды НЕ НАЙДЕН!');
        }
    }

    detectCurrentTeam() {
        const teamSelect = document.getElementById('mng-comp-select');
        if (teamSelect && teamSelect.options[teamSelect.selectedIndex].text !== 'Выбери команду') {
            this.currentTeam = teamSelect.options[teamSelect.selectedIndex].text;
            this.log('Команда определена из select:', this.currentTeam);
            return;
        }
        
        if (!this.currentTeam) {
            this.log('Команда НЕ ОПРЕДЕЛЕНА!');
        }
    }

    initializeLocalState() {
        this.log('Инициализация локального состояния');
        this.collectInitialKartStates();
        this.startStatusMonitoring();
        this.initialized = true;
        this.log('Инициализация завершена');
    }

    collectInitialKartStates() {
        const carsContainer = document.getElementById('mng-carsGood');
        if (!carsContainer) {
            this.log('Контейнер картов не найден!');
            return;
        }
        
        const kartElements = carsContainer.querySelectorAll('[onclick*="editMngCarGoodStart"]');
        this.log(`Найдено элементов картов: ${kartElements.length}`);
        
        kartElements.forEach(element => {
            const onclick = element.getAttribute('onclick');
            const match = onclick.match(/editMngCarGoodStart\('(\d+)'\)/);
            if (!match) {
                this.log('Не удалось извлечь номер карта из:', onclick);
                return;
            }
            
            const kartNumber = match[1];
            let status = 0;
            
            // Проверяем localStorage
            if (this.storageKeyPrefix) {
                const storageKey = `${this.storageKeyPrefix}${kartNumber}`;
                const storedValue = localStorage.getItem(storageKey);
                if (storedValue !== null) {
                    status = parseInt(storedValue);
                    this.log(`Карт ${kartNumber}: из localStorage = ${status}`);
                }
            }
            
            // Проверяем классы
            for (let i = 0; i <= 4; i++) {
                if (element.classList.contains(`car-good-${i}`)) {
                    status = i;
                    this.log(`Карт ${kartNumber}: из классов = ${status}`);
                    break;
                }
            }
            
            this.localKartStates[kartNumber] = status;
        });
        
        this.log('Начальное состояние картов:', this.localKartStates);
    }

    startStatusMonitoring() {
        this.log('Запуск мониторинга статусов');
        
        // Быстрая проверка изменений
        this.statusCheckInterval = setInterval(() => {
            this.checkForLocalChanges();
        }, 300);
        
        // Медленная синхронизация с сервером
        this.syncInterval = setInterval(() => {
            if (this.isConnected && this.currentTeam) {
                this.requestSync();
            }
        }, 2000);
    }

    checkForLocalChanges() {
        if (this.isSyncing || !this.initialized) {
            return;
        }
        
        const carsContainer = document.getElementById('mng-carsGood');
        if (!carsContainer) return;
        
        const kartElements = carsContainer.querySelectorAll('[onclick*="editMngCarGoodStart"]');
        const changes = [];
        
        kartElements.forEach(element => {
            const onclick = element.getAttribute('onclick');
            const match = onclick.match(/editMngCarGoodStart\('(\d+)'\)/);
            if (!match) return;
            
            const kartNumber = match[1];
            
            // Текущий статус из интерфейса
            let currentStatus = 0;
            for (let i = 0; i <= 4; i++) {
                if (element.classList.contains(`car-good-${i}`)) {
                    currentStatus = i;
                    break;
                }
            }
            
            // Предыдущий статус
            const lastStatus = this.localKartStates[kartNumber];
            
            if (lastStatus !== currentStatus) {
                this.log(`Обнаружено изменение карта ${kartNumber}: ${lastStatus} -> ${currentStatus}`);
                
                changes.push({
                    kartNumber: kartNumber,
                    status: currentStatus,
                    oldStatus: lastStatus
                });
                
                // Обновляем локальное состояние
                this.localKartStates[kartNumber] = currentStatus;
                
                // Обновляем localStorage
                this.updateLocalStorage(kartNumber, currentStatus);
            }
        });
        
        // Отправляем изменения на сервер
        if (changes.length > 0) {
            this.log(`Найдено ${changes.length} изменений`);
            
            if (this.isConnected && this.currentTeam) {
                changes.forEach(change => {
                    this.sendKartUpdate(change.kartNumber, change.status);
                    this.showKartIndicator(change.kartNumber, 'send');
                });
            } else {
                this.log(`Не отправлено: подключен=${this.isConnected}, команда=${this.currentTeam}`);
            }
        }
    }

    updateLocalStorage(kartNumber, status) {
        if (!this.storageKeyPrefix) {
            this.log('Не могу обновить localStorage: нет префикса ключа');
            return;
        }
        
        const storageKey = `${this.storageKeyPrefix}${kartNumber}`;
        localStorage.setItem(storageKey, status.toString());
        this.log(`Обновлен localStorage: ${storageKey} = ${status}`);
    }

    async connectToServer() {
        this.log('Подключение к серверу:', this.serverUrl);
        
        if (this.wsConnection) {
            this.wsConnection.close();
        }
        
        try {
            this.updateStatus('connecting', 'Подключение...');
            
            this.wsConnection = new WebSocket(this.serverUrl);
            
            this.wsConnection.onopen = () => {
                this.isConnected = true;
                this.log('WebSocket подключен');
                this.updateStatus('connected', 'Подключено');
                
                if (this.currentTeam) {
                    this.log('Отправка выбора команды:', this.currentTeam);
                    this.sendTeamSelection();
                } else {
                    this.log('Не могу отправить команду: не определена');
                }
            };
            
            this.wsConnection.onmessage = (event) => {
                this.log('Получено сообщение от сервера');
                this.handleServerMessage(event.data);
            };
            
            this.wsConnection.onerror = (error) => {
                this.log('Ошибка WebSocket:', error);
                this.isConnected = false;
                this.updateStatus('error', 'Ошибка');
            };
            
            this.wsConnection.onclose = () => {
                this.log('WebSocket закрыт');
                this.isConnected = false;
                this.updateStatus('disconnected', 'Отключено');
                
                if (this.settings.autoConnect) {
                    setTimeout(() => this.connectToServer(), 3000);
                }
            };
            
        } catch (error) {
            this.log('Ошибка при подключении:', error);
            this.updateStatus('error', 'Ошибка');
        }
    }

    sendTeamSelection() {
        if (!this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN) {
            this.log('Не могу отправить команду: WebSocket не готов');
            return;
        }
        
        if (!this.currentTeam) {
            this.log('Не могу отправить команду: не определена');
            return;
        }
        
        const message = {
            type: 'team_selection',
            team: this.currentTeam,
            timestamp: Date.now()
        };
        
        this.log('Отправка выбора команды:', message);
        this.wsConnection.send(JSON.stringify(message));
    }

    sendKartUpdate(kartNumber, status) {
        if (!this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN) {
            this.log('Не могу отправить обновление: WebSocket не готов');
            return;
        }
        
        if (!this.currentTeam) {
            this.log('Не могу отправить обновление: команда не определена');
            return;
        }
        
        const message = {
            type: 'kart_update',
            team: this.currentTeam,
            kart_number: kartNumber,
            status: status,
            timestamp: Date.now()
        };
        
        this.log('Отправка обновления карта:', message);
        this.wsConnection.send(JSON.stringify(message));
    }

    requestSync() {
        if (!this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN) {
            return;
        }
        
        if (!this.currentTeam) {
            return;
        }
        
        const message = {
            type: 'sync_request',
            team: this.currentTeam,
            version: this.serverStateVersion,
            timestamp: Date.now()
        };
        
        this.wsConnection.send(JSON.stringify(message));
    }

    handleServerMessage(data) {
        try {
            const message = JSON.parse(data);
            this.log('Тип сообщения:', message.type);
            
            switch(message.type) {
                case 'team_confirmed':
                    this.log('Команда подтверждена сервером');
                    this.updateStatus('connected', `Подключено`);
                    break;
                    
                case 'kart_update_broadcast':
                    if (message.team === this.currentTeam) {
                        this.log(`Получено обновление карта ${message.kart_number} = ${message.status}`);
                        this.applyRemoteKartUpdate(message.kart_number, message.status);
                    } else {
                        this.log(`Игнорирую обновление: команда ${message.team} != ${this.currentTeam}`);
                    }
                    break;
                    
                case 'full_state_sync':
                case 'state_update':
                    if (message.team === this.currentTeam) {
                        this.log(`Полное обновление состояния, версия ${message.version}`);
                        this.applyFullStateSync(message.kart_states, message.version);
                    }
                    break;
            }
            
        } catch (error) {
            this.log('Ошибка обработки сообщения:', error, 'Данные:', data);
        }
    }

    applyRemoteKartUpdate(kartNumber, status) {
        this.isSyncing = true;
        this.log(`Применение удаленного обновления: карт ${kartNumber} = ${status}`);
        
        try {
            this.updateKartInInterface(kartNumber, status);
            this.showKartIndicator(kartNumber, 'receive');
            
        } finally {
            setTimeout(() => {
                this.isSyncing = false;
            }, 50);
        }
    }

    updateKartInInterface(kartNumber, status) {
        this.log(`Обновление интерфейса карта ${kartNumber} на ${status}`);
        
        const carsContainer = document.getElementById('mng-carsGood');
        if (!carsContainer) {
            this.log('Контейнер картов не найден');
            return;
        }
        
        const kartElements = carsContainer.querySelectorAll('[onclick*="editMngCarGoodStart"]');
        let updated = false;
        
        kartElements.forEach(element => {
            const onclick = element.getAttribute('onclick');
            const match = onclick.match(/editMngCarGoodStart\('(\d+)'\)/);
            
            if (match && match[1] === kartNumber) {
                // Обновляем классы
                for (let i = 0; i <= 4; i++) {
                    element.classList.remove(`car-good-${i}`);
                }
                element.classList.add(`car-good-${status}`);
                updated = true;
            }
        });
        
        if (updated) {
            this.updateLocalStorage(kartNumber, status);
            this.localKartStates[kartNumber] = status;
            this.log(`Карт ${kartNumber} успешно обновлен`);
        } else {
            this.log(`Карт ${kartNumber} не найден в интерфейсе`);
        }
    }

    applyFullStateSync(newKartStates, serverVersion) {
        this.log('Применение полной синхронизации');
        this.isSyncing = true;
        
        try {
            this.serverStateVersion = serverVersion;
            
            Object.entries(newKartStates).forEach(([kartNumber, serverStatus]) => {
                const localStatus = this.localKartStates[kartNumber] || 0;
                
                if (serverStatus !== localStatus) {
                    this.log(`Синхронизация карта ${kartNumber}: ${localStatus} -> ${serverStatus}`);
                    this.updateKartInInterface(kartNumber, serverStatus);
                }
            });
            
            this.updateSyncIndicator('synced');
            
        } finally {
            setTimeout(() => {
                this.isSyncing = false;
            }, 100);
        }
    }

    showKartIndicator(kartNumber, type) {
        const carsContainer = document.getElementById('mng-carsGood');
        if (!carsContainer) return;
        
        const kartElements = carsContainer.querySelectorAll('[onclick*="editMngCarGoodStart"]');
        
        kartElements.forEach(element => {
            const onclick = element.getAttribute('onclick');
            const match = onclick.match(/editMngCarGoodStart\('(\d+)'\)/);
            
            if (match && match[1] === kartNumber) {
                let indicator = element.querySelector('.sync-indicator');
                if (!indicator) {
                    indicator = document.createElement('div');
                    indicator.className = 'sync-indicator';
                    element.style.position = 'relative';
                    element.appendChild(indicator);
                }
                
                const color = type === 'receive' ? '#2196F3' : '#4CAF50';
                indicator.style.cssText = `
                    position: absolute;
                    top: 2px;
                    right: 2px;
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: ${color};
                    box-shadow: 0 0 4px ${color};
                    animation: pulse 0.5s;
                    z-index: 1000;
                `;
                
                setTimeout(() => {
                    if (indicator) {
                        indicator.style.background = '#ccc';
                        indicator.style.boxShadow = 'none';
                        indicator.style.animation = '';
                    }
                }, 500);
            }
        });
    }

    createStatusUI() {
        const statusDiv = document.createElement('div');
        statusDiv.id = 'racemann-sync-status';
        statusDiv.style.cssText = `
            position: fixed;
            bottom: 10px;
            right: 10px;
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 12px;
            font-family: Arial, sans-serif;
            z-index: 9999;
            display: flex;
            align-items: center;
            gap: 8px;
            border: 1px solid #444;
            min-width: 160px;
        `;
        
        statusDiv.innerHTML = `
            <div class="status-indicator" style="width:10px;height:10px;border-radius:50%;background:#757575"></div>
            <span class="status-text">Отключено</span>
            <div class="debug-info" style="font-size:10px;color:#aaa;margin-left:auto"></div>
        `;
        
        document.body.appendChild(statusDiv);
        this.statusElement = statusDiv;
    }

    updateStatus(state, text) {
        if (!this.statusElement) return;
        
        const indicator = this.statusElement.querySelector('.status-indicator');
        const textElement = this.statusElement.querySelector('.status-text');
        const debugElement = this.statusElement.querySelector('.debug-info');
        
        if (indicator) {
            indicator.style.transition = 'all 0.3s';
            
            switch(state) {
                case 'connected':
                    indicator.style.background = '#4CAF50';
                    indicator.style.boxShadow = '0 0 8px #4CAF50';
                    break;
                case 'connecting':
                    indicator.style.background = '#FF9800';
                    indicator.style.boxShadow = '0 0 8px #FF9800';
                    break;
                case 'error':
                    indicator.style.background = '#F44336';
                    indicator.style.boxShadow = '0 0 8px #F44336';
                    break;
                default:
                    indicator.style.background = '#757575';
                    indicator.style.boxShadow = 'none';
            }
        }
        
        if (textElement) {
            textElement.textContent = text;
        }
        
        if (debugElement) {
            debugElement.textContent = this.currentTeam ? `Команда: ${this.currentTeam}` : 'Команда не определена';
        }
    }

    updateSyncIndicator(type) {
        const statusDiv = document.getElementById('racemann-sync-status');
        if (!statusDiv) return;
        
        const indicator = statusDiv.querySelector('.status-indicator');
        if (!indicator) return;
        
        if (type === 'synced') {
            indicator.style.background = '#2196F3';
            indicator.style.boxShadow = '0 0 6px #2196F3';
            setTimeout(() => {
                if (this.isConnected) {
                    indicator.style.background = '#4CAF50';
                    indicator.style.boxShadow = '0 0 6px #4CAF50';
                }
            }, 500);
        }
    }

    disconnect() {
        if (this.wsConnection) {
            this.wsConnection.close();
        }
        this.isConnected = false;
        
        if (this.statusCheckInterval) {
            clearInterval(this.statusCheckInterval);
        }
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }
        
        this.updateStatus('disconnected', 'Отключено');
    }
}

// Инициализация
let raceSyncInstance = null;

function initializeRaceSync() {
    if (!raceSyncInstance && window.location.href.includes('racemann.com/Race')) {
        console.log('RaceMann Sync: Запуск расширения');
        raceSyncInstance = new RaceManagerSync();
        window.raceSync = raceSyncInstance;
        
        // Для отладки делаем глобальным
        window.raceSyncDebug = raceSyncInstance;
    }
}

// Добавляем стили
if (!document.getElementById('sync-styles')) {
    const style = document.createElement('style');
    style.id = 'sync-styles';
    style.textContent = `
        @keyframes pulse {
            0% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.3); opacity: 0.7; }
            100% { transform: scale(1); opacity: 1; }
        }
    `;
    document.head.appendChild(style);
}

// Запускаем
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeRaceSync);
} else {
    initializeRaceSync();
}

// Для отладки: добавляем команды в консоль
if (typeof window !== 'undefined') {
    window.debugRaceSync = {
        getState: () => {
            if (raceSyncInstance) {
                return {
                    currentTeam: raceSyncInstance.currentTeam,
                    isConnected: raceSyncInstance.isConnected,
                    localKartStates: raceSyncInstance.localKartStates,
                    storageKeyPrefix: raceSyncInstance.storageKeyPrefix,
                    wsState: raceSyncInstance.wsConnection ? raceSyncInstance.wsConnection.readyState : 'no connection'
                };
            }
            return 'Not initialized';
        },
        
        sendTestUpdate: (kartNumber, status) => {
            if (raceSyncInstance && raceSyncInstance.isConnected && raceSyncInstance.currentTeam) {
                raceSyncInstance.sendKartUpdate(kartNumber, status);
                return `Sent update for kart ${kartNumber} = ${status}`;
            }
            return 'Not ready to send';
        },
        
        forceSync: () => {
            if (raceSyncInstance && raceSyncInstance.isConnected && raceSyncInstance.currentTeam) {
                raceSyncInstance.requestSync();
                return 'Sync requested';
            }
            return 'Not ready to sync';
        }
    };
}