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
        
        // Состояние
        this.localKartStates = {};
        this.serverStateVersion = 0;
        
        // Для предотвращения циклических вызовов
        this.isProcessingRemoteUpdate = false;
        this.currentProcessingKart = null;
        
        // Интервалы
        this.syncInterval = null;
        this.statusCheckInterval = null;
        
        this.init();
    }

    async init() {
        console.log('RaceMann Sync: Инициализация');
        await this.loadSettings();
        this.createStatusUI();
        this.waitForManagerTab();
    }

    async loadSettings() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['raceSyncSettings'], (result) => {
                if (result.raceSyncSettings) {
                    this.settings = { ...this.settings, ...result.raceSyncSettings };
                    this.serverUrl = this.settings.serverUrl;
                }
                resolve();
            });
        });
    }

    waitForManagerTab() {
        const observer = new MutationObserver(() => {
            const managerTab = document.getElementById('mngTab');
            
            if (managerTab && managerTab.style.display !== 'none') {
                console.log('RaceMann Sync: Менеджер гонки обнаружен');
                observer.disconnect();
                
                this.detectCurrentTeam();
                this.setupTeamMonitoring();
                this.startMonitoring();
                
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

    detectCurrentTeam() {
        const teamSelect = document.getElementById('mng-comp-select');
        if (teamSelect && teamSelect.value) {
            this.currentTeam = teamSelect.value;
            console.log('RaceMann Sync: Команда определена:', this.currentTeam);
        }
    }

    setupTeamMonitoring() {
        const teamSelect = document.getElementById('mng-comp-select');
        if (teamSelect) {
            teamSelect.addEventListener('change', () => {
                const newTeam = teamSelect.value;
                if (newTeam && newTeam !== this.currentTeam) {
                    this.currentTeam = newTeam;
                    this.localKartStates = {};
                    
                    if (this.isConnected) {
                        this.sendTeamSelection();
                    }
                }
            });
        }
    }

    startMonitoring() {
        // Собираем начальные статусы
        this.collectCurrentStatuses();
        
        // Отслеживаем изменения каждые 500мс
        this.statusCheckInterval = setInterval(() => {
            this.checkForChanges();
        }, 500);
        
        // Синхронизация с сервером каждые 2 секунды
        this.syncInterval = setInterval(() => {
            if (this.isConnected && this.currentTeam) {
                this.requestSync();
            }
        }, 2000);
    }

    collectCurrentStatuses() {
        const carsContainer = document.getElementById('mng-carsGood');
        if (!carsContainer) return;
        
        const kartElements = carsContainer.querySelectorAll('[onclick*="editMngCarGoodStart"]');
        
        kartElements.forEach(element => {
            const onclick = element.getAttribute('onclick');
            const match = onclick.match(/editMngCarGoodStart\('(\d+)'\)/);
            if (!match) return;
            
            const kartNumber = match[1];
            
            // Определяем статус по классам
            let status = 0;
            for (let i = 0; i <= 4; i++) {
                if (element.classList.contains(`car-good-${i}`)) {
                    status = i;
                    break;
                }
            }
            
            this.localKartStates[kartNumber] = status;
        });
        
        console.log('RaceMann Sync: Начальные статусы:', this.localKartStates);
    }

    checkForChanges() {
        // Если сейчас обрабатываем удаленное обновление, пропускаем проверку
        if (this.isProcessingRemoteUpdate) return;
        
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
            
            const lastStatus = this.localKartStates[kartNumber];
            
            if (lastStatus !== currentStatus) {
                changes.push({
                    kartNumber,
                    status: currentStatus,
                    oldStatus: lastStatus
                });
                
                this.localKartStates[kartNumber] = currentStatus;
            }
        });
        
        // Отправляем изменения на сервер
        if (changes.length > 0 && this.isConnected && this.currentTeam) {
            console.log('RaceMann Sync: Локальные изменения:', changes);
            changes.forEach(change => {
                this.sendKartUpdate(change.kartNumber, change.status);
                this.showKartIndicator(change.kartNumber, 'send');
            });
        }
    }

    // Эмуляция кликов для изменения статуса карта
    async simulateKartClick(kartNumber, targetStatus) {
        return new Promise((resolve) => {
            try {
                console.log(`RaceMann Sync: Эмуляция кликов для карта ${kartNumber} -> статус ${targetStatus}`);
                
                // 1. Находим элемент карта
                const carsContainer = document.getElementById('mng-carsGood');
                if (!carsContainer) {
                    resolve(false);
                    return;
                }
                
                const kartElements = carsContainer.querySelectorAll('[onclick*="editMngCarGoodStart"]');
                let kartElement = null;
                
                kartElements.forEach(element => {
                    const onclick = element.getAttribute('onclick');
                    const match = onclick.match(/editMngCarGoodStart\('(\d+)'\)/);
                    if (match && match[1] === kartNumber) {
                        kartElement = element;
                    }
                });
                
                if (!kartElement) {
                    console.log(`RaceMann Sync: Карт ${kartNumber} не найден`);
                    resolve(false);
                    return;
                }
                
                // 2. Кликаем на карт для открытия диалога
                kartElement.click();
                
                // 3. Ждем появления диалога
                setTimeout(() => {
                    const dialog = document.getElementById('editMngCarGoodPopup');
                    if (!dialog || dialog.style.display === 'none' || !dialog.parentElement.classList.contains('ui-popup-active')) {
                        console.log('RaceMann Sync: Диалог не открылся');
                        resolve(false);
                        return;
                    }
                    
                    // 4. Выбираем нужный статус
                    const radioToSelect = document.getElementById(`editMngCar_good_${targetStatus}`);
                    if (radioToSelect) {
                        radioToSelect.click();
                        console.log(`RaceMann Sync: Выбран статус ${targetStatus}`);
                        
                        // 5. Ждем и нажимаем кнопку ОК
                        setTimeout(() => {
                            // Кнопка ОК
                            const okButton = dialog.querySelector('#editMngCarGoodPopup > div.ui-content > a.ui-link.ui-btn.ui-btn-s.ui-btn-inline.ui-shadow.ui-corner-all');
                            
                            if (okButton) {
                                okButton.click();
                                console.log(`RaceMann Sync: Нажата кнопка ОК для карта ${kartNumber}`);
                                
                                // Обновляем локальное состояние
                                setTimeout(() => {
                                    this.localKartStates[kartNumber] = targetStatus;
                                    resolve(true);
                                }, 100);
                            } else {
                                console.log('RaceMann Sync: Кнопка ОК не найдена');
                                resolve(false);
                            }
                        }, 100);
                    } else {
                        console.log(`RaceMann Sync: Радиокнопка для статуса ${targetStatus} не найдена`);
                        resolve(false);
                    }
                }, 300);
                
            } catch (error) {
                console.error('RaceMann Sync: Ошибка при эмуляции:', error);
                resolve(false);
            }
        });
    }

    async connectToServer() {
        if (this.wsConnection) {
            this.wsConnection.close();
        }
        
        try {
            this.updateStatus('connecting', 'Подключение...');
            
            this.wsConnection = new WebSocket(this.serverUrl);
            
            this.wsConnection.onopen = () => {
                this.isConnected = true;
                this.updateStatus('connected', 'Подключено');
                
                if (this.currentTeam) {
                    this.sendTeamSelection();
                }
            };
            
            this.wsConnection.onmessage = (event) => {
                this.handleServerMessage(event.data);
            };
            
            this.wsConnection.onerror = () => {
                this.isConnected = false;
                this.updateStatus('error', 'Ошибка');
            };
            
            this.wsConnection.onclose = () => {
                this.isConnected = false;
                this.updateStatus('disconnected', 'Отключено');
                
                if (this.settings.autoConnect) {
                    setTimeout(() => this.connectToServer(), 3000);
                }
            };
            
        } catch (error) {
            this.updateStatus('error', 'Ошибка');
        }
    }

    sendTeamSelection() {
        if (!this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN) return;
        
        this.wsConnection.send(JSON.stringify({
            type: 'team_selection',
            team: this.currentTeam,
            timestamp: Date.now()
        }));
    }

    sendKartUpdate(kartNumber, status) {
        if (!this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN || !this.currentTeam) return;
        
        this.wsConnection.send(JSON.stringify({
            type: 'kart_update',
            team: this.currentTeam,
            kart_number: kartNumber,
            status: status,
            timestamp: Date.now()
        }));
    }

    requestSync() {
        if (!this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN || !this.currentTeam) return;
        
        this.wsConnection.send(JSON.stringify({
            type: 'sync_request',
            team: this.currentTeam,
            version: this.serverStateVersion,
            timestamp: Date.now()
        }));
    }

    async handleServerMessage(data) {
        try {
            const message = JSON.parse(data);
            
            switch(message.type) {
                case 'team_confirmed':
                    this.updateStatus('connected', `Команда ${message.team} (${message.connected_managers})`);
                    break;
                    
                case 'kart_update_broadcast':
                    // Игнорируем свои сообщения
                    if (message.sender === this.getClientId()) {
                        return;
                    }
                    
                    if (message.team === this.currentTeam) {
                        console.log(`RaceMann Sync: Получено обновление карта ${message.kart_number} -> ${message.status}`);
                        
                        // Проверяем, не обрабатываем ли мы уже этот карт
                        if (this.currentProcessingKart === message.kart_number) {
                            console.log(`RaceMann Sync: Карт ${message.kart_number} уже обрабатывается, пропускаем`);
                            return;
                        }
                        
                        // Проверяем текущий статус
                        const currentStatus = this.getCurrentKartStatus(message.kart_number);
                        
                        // Если статус уже совпадает, ничего не делаем
                        if (currentStatus === message.status) {
                            console.log(`RaceMann Sync: Карт ${message.kart_number} уже имеет статус ${message.status}`);
                            return;
                        }
                        
                        // Устанавливаем флаг обработки
                        this.isProcessingRemoteUpdate = true;
                        this.currentProcessingKart = message.kart_number;
                        
                        // Эмулируем клики
                        const success = await this.simulateKartClick(message.kart_number, message.status);
                        
                        if (success) {
                            this.showKartIndicator(message.kart_number, 'receive');
                            console.log(`RaceMann Sync: Успешно применено обновление для карта ${message.kart_number}`);
                        } else {
                            console.log(`RaceMann Sync: Не удалось применить обновление для карта ${message.kart_number}`);
                        }
                        
                        // Сбрасываем флаги
                        setTimeout(() => {
                            this.isProcessingRemoteUpdate = false;
                            this.currentProcessingKart = null;
                        }, 500);
                    }
                    break;
                    
                case 'full_state_sync':
                case 'state_update':
                    if (message.team === this.currentTeam && message.version > this.serverStateVersion) {
                        console.log('RaceMann Sync: Получено полное обновление состояния');
                        this.serverStateVersion = message.version;
                        
                        // Применяем все изменения по очереди
                        this.applyFullStateSync(message.kart_states);
                    }
                    break;
            }
            
        } catch (error) {
            console.error('RaceMann Sync: Ошибка обработки сообщения:', error);
            this.isProcessingRemoteUpdate = false;
            this.currentProcessingKart = null;
        }
    }

    getClientId() {
        return this.wsConnection ? `client_${this.wsConnection.url}_${Date.now()}` : 'unknown';
    }

    getCurrentKartStatus(kartNumber) {
        const carsContainer = document.getElementById('mng-carsGood');
        if (!carsContainer) return null;
        
        const kartElements = carsContainer.querySelectorAll('[onclick*="editMngCarGoodStart"]');
        
        for (const element of kartElements) {
            const onclick = element.getAttribute('onclick');
            const match = onclick.match(/editMngCarGoodStart\('(\d+)'\)/);
            
            if (match && match[1] === kartNumber) {
                for (let i = 0; i <= 4; i++) {
                    if (element.classList.contains(`car-good-${i}`)) {
                        return i;
                    }
                }
                return 0;
            }
        }
        
        return null;
    }

    async applyFullStateSync(newKartStates) {
        // Получаем все карты из интерфейса
        const carsContainer = document.getElementById('mng-carsGood');
        if (!carsContainer) return;
        
        const kartElements = carsContainer.querySelectorAll('[onclick*="editMngCarGoodStart"]');
        const kartNumbers = [];
        
        kartElements.forEach(element => {
            const onclick = element.getAttribute('onclick');
            const match = onclick.match(/editMngCarGoodStart\('(\d+)'\)/);
            if (match) {
                kartNumbers.push(match[1]);
            }
        });
        
        // Применяем изменения по очереди
        for (const kartNumber of kartNumbers) {
            const serverStatus = newKartStates[kartNumber];
            if (serverStatus === undefined) continue;
            
            const currentStatus = this.getCurrentKartStatus(kartNumber);
            
            if (currentStatus !== serverStatus && this.currentProcessingKart !== kartNumber) {
                // Ждем, если сейчас обрабатывается другой карт
                while (this.isProcessingRemoteUpdate) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
                this.isProcessingRemoteUpdate = true;
                this.currentProcessingKart = kartNumber;
                
                await this.simulateKartClick(kartNumber, serverStatus);
                
                this.isProcessingRemoteUpdate = false;
                this.currentProcessingKart = null;
                
                // Небольшая задержка между обновлениями
                await new Promise(resolve => setTimeout(resolve, 500));
            }
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
        `;
        
        document.body.appendChild(statusDiv);
        this.statusElement = statusDiv;
    }

    updateStatus(state, text) {
        if (!this.statusElement) return;
        
        const indicator = this.statusElement.querySelector('.status-indicator');
        const textElement = this.statusElement.querySelector('.status-text');
        
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
    }
}

// Стили анимации
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

// Запуск
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeRaceSync);
} else {
    initializeRaceSync();
}