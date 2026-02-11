import asyncio
import json
import websockets
from typing import Dict, Set, Optional
from datetime import datetime
import logging
import time

# Настройка логгирования
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('race_sync_server.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class TeamState:
    """Состояние команды с версионированием"""
    def __init__(self, team_name: str):
        self.team_name = team_name
        self.kart_states: Dict[str, int] = {}  # kart_number -> status
        self.version = 1  # Версия состояния
        self.last_updated = time.time()
        self.last_update_by: Optional[str] = None
        
    def update_kart(self, kart_number: str, status: int, client_id: str) -> bool:
        """Обновление статуса карта"""
        current_status = self.kart_states.get(kart_number, 0)
        
        if current_status != status:
            self.kart_states[kart_number] = status
            self.version += 1
            self.last_updated = time.time()
            self.last_update_by = client_id
            
            logger.info(f"Команда {self.team_name}: Карт {kart_number} изменен {self.get_status_name(current_status)} -> {self.get_status_name(status)} клиентом {client_id}")
            return True
        return False
    
    def get_status_name(self, status: int) -> str:
        """Получение названия статуса"""
        status_names = {
            0: 'Не знаю',
            1: 'Дрова',
            2: 'Средний',
            3: 'Хороший',
            4: 'Ракета'
        }
        return status_names.get(status, f'Неизвестно ({status})')
    
    def get_state(self) -> dict:
        """Получение состояния для отправки клиенту"""
        return {
            'team': self.team_name,
            'kart_states': self.kart_states.copy(),
            'version': self.version,
            'last_updated': self.last_updated,
            'last_update_by': self.last_update_by
        }

class RaceSyncServer:
    def __init__(self):
        # Подключенные клиенты: team -> set of websockets
        self.connected_clients: Dict[str, Set[websockets.WebSocketServerProtocol]] = {}
        
        # Состояния картов для команд
        self.team_states: Dict[str, TeamState] = {}
        
        # Клиентские сессии: websocket -> team
        self.client_teams: Dict[websockets.WebSocketServerProtocol, str] = {}
        
        # Версии, которые видели клиенты: (websocket, team) -> version
        self.client_versions: Dict[tuple, int] = {}
        
        # Статистика
        self.stats = {
            'total_connections': 0,
            'total_updates': 0,
            'total_syncs': 0
        }
        
        logger.info("Сервер синхронизации инициализирован")
    
    def get_client_id(self, websocket: websockets.WebSocketServerProtocol) -> str:
        """Генерация ID клиента"""
        return f"client_{id(websocket)}"
    
    async def register_client(self, websocket: websockets.WebSocketServerProtocol):
        """Регистрация нового клиента"""
        client_id = self.get_client_id(websocket)
        self.stats['total_connections'] += 1
        
        logger.info(f"Новое подключение: {client_id}")
        
        try:
            async for message in websocket:
                data = json.loads(message)
                await self.handle_message(data, websocket, client_id)
                
        except websockets.exceptions.ConnectionClosed:
            logger.info(f"Клиент {client_id} отключился")
        except Exception as e:
            logger.error(f"Ошибка с клиентом {client_id}: {e}")
        finally:
            await self.remove_client(websocket)
    
    async def remove_client(self, websocket: websockets.WebSocketServerProtocol):
        """Удаление отключенного клиента"""
        client_id = self.get_client_id(websocket)
        team = self.client_teams.get(websocket)
        
        if team and team in self.connected_clients:
            self.connected_clients[team].remove(websocket)
            logger.info(f"Клиент {client_id} удален из команды {team}")
            
            if not self.connected_clients[team]:
                del self.connected_clients[team]
                logger.info(f"Команда {team} удалена (нет клиентов)")
        
        # Удаляем из client_teams
        if websocket in self.client_teams:
            del self.client_teams[websocket]
        
        # Удаляем версии
        keys_to_remove = []
        for key in self.client_versions.keys():
            if key[0] == websocket:
                keys_to_remove.append(key)
        
        for key in keys_to_remove:
            del self.client_versions[key]
        
        logger.info(f"Клиент {client_id} полностью удален")
    
    async def handle_message(self, data: dict, websocket: websockets.WebSocketServerProtocol, client_id: str):
        """Обработка сообщений от клиентов"""
        msg_type = data.get('type')
        
        if msg_type == 'team_selection':
            await self.handle_team_selection(data, websocket, client_id)
        elif msg_type == 'kart_update':
            await self.handle_kart_update(data, websocket, client_id)
        elif msg_type == 'sync_request':
            await self.handle_sync_request(data, websocket, client_id)
        elif msg_type == 'ping':
            await self.send_to_client(websocket, {'type': 'pong', 'timestamp': datetime.now().isoformat()})
        else:
            logger.warning(f"Неизвестный тип сообщения от {client_id}: {msg_type}")
    
    async def handle_team_selection(self, data: dict, websocket: websockets.WebSocketServerProtocol, client_id: str):
        """Обработка выбора команды"""
        team = data.get('team')
        if not team:
            logger.warning(f"Клиент {client_id}: пустая команда")
            return
        
        logger.info(f"Клиент {client_id} выбирает команду: {team}")
        
        # Удаляем из предыдущей команды
        old_team = self.client_teams.get(websocket)
        if old_team and old_team in self.connected_clients:
            self.connected_clients[old_team].remove(websocket)
            if not self.connected_clients[old_team]:
                del self.connected_clients[old_team]
        
        # Добавляем в новую команду
        if team not in self.connected_clients:
            self.connected_clients[team] = set()
        
        self.connected_clients[team].add(websocket)
        self.client_teams[websocket] = team
        
        # Создаем состояние команды если нужно
        if team not in self.team_states:
            self.team_states[team] = TeamState(team)
            logger.info(f"Создано состояние для команды {team}")
        
        logger.info(f"Текущее состояние: {self.team_states[team].get_state()}")
        
        # Отправляем подтверждение
        await self.send_to_client(websocket, {
            'type': 'team_confirmed',
            'team': team,
            'connected_managers': len(self.connected_clients[team]),
            'timestamp': datetime.now().isoformat()
        })
        
        # Отправляем полное состояние команды новому клиенту
        await self.send_full_state_to_client(websocket, team, client_id, is_new=True)
    
    async def handle_kart_update(self, data: dict, websocket: websockets.WebSocketServerProtocol, client_id: str):
        """Обработка обновления ОДНОГО карта от клиента"""
        team = data.get('team')
        kart_number = data.get('kart_number')
        status = data.get('status')
        
        if not all([team, kart_number, status is not None]):
            return
        
        # Проверяем, что клиент в команде
        if team not in self.connected_clients or websocket not in self.connected_clients[team]:
            return
        
        # Инициализируем состояние команды если нужно
        if team not in self.team_states:
            self.team_states[team] = TeamState(team)
        
        # Получаем предыдущий статус
        old_status = self.team_states[team].get_state().get("status")
        logger.info(f"СЕРВЕР: Старая информация о команде: {self.team_states[team].get_state()}")
        
        # ЕСЛИ СТАТУС ИЗМЕНИЛСЯ - обновляем состояние на сервере
        if old_status != status:
            self.team_states[team].update_kart(kart_number, status, client_id)
            
            logger.info(f"СЕРВЕР: Команда {team}, Карт {kart_number}: {old_status} -> {status} от клиента {client_id}")
            
            # Рассылаем ТОЛЬКО ЭТО ИЗМЕНЕНИЕ всем клиентам команды
            await self.broadcast_kart_update(team, kart_number, status, client_id)
    
    async def handle_sync_request(self, data: dict, websocket: websockets.WebSocketServerProtocol, client_id: str):
        """Обработка запроса синхронизации"""
        team = data.get('team')
        client_version = data.get('version', 0)
        
        if not team or team not in self.team_states:
            await self.send_to_client(websocket, {
                'type': 'sync_response',
                'team': team or '',
                'has_changes': False,
                'timestamp': datetime.now().isoformat()
            })
            return
        
        team_state = self.team_states[team]
        key = (websocket, team)
        
        # Проверяем, есть ли изменения для этого клиента
        if self.client_versions.get(key, 0) < team_state.version:
            self.stats['total_syncs'] += 1
            self.client_versions[key] = team_state.version
            
            # Отправляем полное состояние
            await self.send_full_state_to_client(websocket, team, client_id, is_new=False)
        else:
            # Нет изменений
            await self.send_to_client(websocket, {
                'type': 'sync_response',
                'team': team,
                'has_changes': False,
                'server_version': team_state.version,
                'timestamp': datetime.now().isoformat()
            })
    
    async def send_to_client(self, websocket: websockets.WebSocketServerProtocol, message: dict):
        """Отправка сообщения клиенту"""
        try:
            await websocket.send(json.dumps(message))
        except:
            await self.remove_client(websocket)
    
    async def send_full_state_to_client(self, websocket: websockets.WebSocketServerProtocol, team: str, client_id: str, is_new: bool = False):
        """Отправка полного состояния команды клиенту"""
        if team not in self.team_states:
            return
        
        team_state = self.team_states[team]
        state_data = team_state.get_state()
        
        if is_new:
            logger.info(f"Отправка полного состояния команды {team} новому клиенту {client_id}, версия {team_state.version}")
            message_type = 'full_state_sync'
        else:
            logger.info(f"Отправка обновления состояния команды {team} клиенту {client_id}, версия {team_state.version}")
            message_type = 'state_update'
        
        await self.send_to_client(websocket, {
            'type': message_type,
            'team': team,
            'kart_states': state_data['kart_states'],
            'version': state_data['version'],
            'timestamp': datetime.now().isoformat()
        })
        
        # Обновляем версию клиента
        key = (websocket, team)
        self.client_versions[key] = team_state.version
    
    async def broadcast_kart_update(self, team: str, kart_number: str, status: int, sender_client_id: str):
        """Рассылка обновления ТОЛЬКО ОДНОГО КАРТА всем клиентам команды"""
        if team not in self.connected_clients:
            return
        
        message = {
            'type': 'kart_update_broadcast',
            'team': team,
            'kart_number': kart_number,
            'status': status,
            'timestamp': datetime.now().isoformat()
        }
        
        tasks = []
        for websocket in self.connected_clients[team]:
            client_id = f"client_{id(websocket)}"
            if client_id == sender_client_id:
                continue
            
            try:
                tasks.append(websocket.send(json.dumps(message)))
                logger.info(f"json: {json.dumps(message)}")
            except:
                pass
        
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
            logger.debug(f"Обновление карта {kart_number} разослано {len(tasks)} клиентам команды {team}")
    
    def log_statistics(self):
        """Логирование статистики"""
        logger.info("=" * 60)
        logger.info("СТАТИСТИКА СЕРВЕРА:")
        logger.info(f"Всего подключений: {self.stats['total_connections']}")
        logger.info(f"Всего обновлений: {self.stats['total_updates']}")
        logger.info(f"Всего синхронизаций: {self.stats['total_syncs']}")
        logger.info(f"Активных команд: {len(self.connected_clients)}")
        
        for team_name, team_state in self.team_states.items():
            clients_count = len(self.connected_clients.get(team_name, set()))
            logger.info(f"\nКоманда {team_name}:")
            logger.info(f"  Клиентов: {clients_count}")
            logger.info(f"  Версия состояния: {team_state.version}")
            logger.info(f"  Картов: {len(team_state.kart_states)}")
            logger.info(f"  Последнее обновление: {team_state.last_update_by}")
            
            # Статистика по статусам
            status_counts = {}
            for status in team_state.kart_states.values():
                status_counts[status] = status_counts.get(status, 0) + 1
            
            if status_counts:
                status_info = []
                for status_num in sorted(status_counts.keys()):
                    count = status_counts[status_num]
                    status_name = team_state.get_status_name(status_num)
                    status_info.append(f"{status_name}: {count}")
                logger.info(f"  Статусы: {', '.join(status_info)}")
        
        logger.info("=" * 60)
    
    async def start_server(self, host: str = '0.0.0.0', port: int = 8765):
        """Запуск сервера"""
        logger.info(f"Запуск сервера на {host}:{port}")
        
        # Периодическое логирование
        async def periodic_logging():
            while True:
                await asyncio.sleep(300)  # 5 минут
                self.log_statistics()
        
        logging_task = asyncio.create_task(periodic_logging())
        
        try:
            async with websockets.serve(
                self.register_client,
                host,
                port,
                ping_interval=30,
                ping_timeout=10
            ):
                logger.info(f"Сервер запущен и слушает порт {port}")
                await asyncio.Future()
        finally:
            logging_task.cancel()
            try:
                await logging_task
            except asyncio.CancelledError:
                pass

async def main():
    server = RaceSyncServer()
    await server.start_server()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Сервер остановлен по запросу пользователя")
    except Exception as e:
        logger.error(f"Критическая ошибка сервера: {e}", exc_info=True)