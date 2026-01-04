"""
SERVIDOR DISTRIBUÍDO - FastAPI com mDNS Auto-Discovery
Pode rodar em: Windows, Linux, Raspberry Pi, qualquer máquina

Uso:
  python server.py  (dev)
  pyinstaller --onefile server.py  (para distribuir como executável)
"""

from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import asyncio
import json
import uuid
from datetime import datetime
import socket
import os
import threading
from typing import Dict

# Database
from sqlalchemy import create_engine, Column, String, Float, DateTime, Boolean, Integer
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session

# mDNS Discovery
from zeroconf import ServiceInfo, Zeroconf
try:
    from zeroconf import ServiceInfo, Zeroconf
except ImportError:
    print("⚠️  zeroconf não instalado. mDNS desabilitado.")
    Zeroconf = None

# ==================== DATABASE ====================
Base = declarative_base()

class DataRecord(Base):
    __tablename__ = "records"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    title = Column(String, index=True)
    value = Column(Float)
    computed_result = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    version = Column(Integer, default=1)  # Para controle de conflitos

# Database setup
DB_URL = os.getenv("DATABASE_URL", "sqlite:///./sync.db")
engine = create_engine(
    DB_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DB_URL else {},
    pool_pre_ping=True
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine)

# ==================== MDNS BROADCASTER ====================
class MDNSBroadcaster:
    def __init__(self, port=8000, service_name="SyncApp"):
        self.port = port
        self.service_name = service_name
        self.zeroconf = None
        self.service_info = None

    def start(self):
        """Anuncia servidor na rede local via mDNS"""
        if Zeroconf is None:
            print("⚠️  zeroconf não disponível. Descubra manualmente.")
            return

        try:
            # Obter IP local
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()

            # Criar serviço mDNS
            self.service_info = ServiceInfo(
                "_http._tcp.local.",
                f"{self.service_name}._http._tcp.local.",
                addresses=[socket.inet_aton(local_ip)],
                port=self.port,
                properties={"version": "1.0", "path": "/"},
                server=f"{self.service_name}.local.",
            )

            self.zeroconf = Zeroconf()
            self.zeroconf.register_service(self.service_info)
            print(f"✅ mDNS anunciado: {self.service_name}.local (IP: {local_ip}:{self.port})")

        except Exception as e:
            print(f"❌ Erro ao configurar mDNS: {e}")

    def stop(self):
        """Para de anunciar"""
        if self.zeroconf:
            self.zeroconf.unregister_service(self.service_info)
            self.zeroconf.close()
            print("🛑 mDNS desativado")

# ==================== CONNECTION MANAGER ====================
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.device_registry: Dict[str, dict] = {}

    async def connect(self, websocket: WebSocket, device_id: str):
        await websocket.accept()
        self.active_connections[device_id] = websocket
        self.device_registry[device_id] = {
            "type": "unknown",
            "connected_at": datetime.utcnow(),
            "last_sync": None
        }
        print(f"📱 Device conectado: {device_id}")
        await self.broadcast_status()

    def disconnect(self, device_id: str):
        if device_id in self.active_connections:
            del self.active_connections[device_id]
            del self.device_registry[device_id]
            print(f"📴 Device desconectado: {device_id}")

    async def broadcast_status(self):
        """Notifica todos sobre dispositivos conectados"""
        msg = {
            "type": "device_status",
            "connected_devices": list(self.device_registry.keys()),
            "timestamp": datetime.utcnow().isoformat()
        }
        await self.broadcast(msg)

    async def broadcast(self, message: dict, exclude_device: str = None):
        """Envia mensagem para todos os clientes"""
        disconnected = []
        for device_id, connection in self.active_connections.items():
            if exclude_device and device_id == exclude_device:
                continue
            try:
                await connection.send_json(message)
            except Exception as e:
                print(f"❌ Erro enviando para {device_id}: {e}")
                disconnected.append(device_id)

        for device_id in disconnected:
            self.disconnect(device_id)

    async def send_personal_message(self, device_id: str, message: dict):
        """Envia mensagem para um device específico"""
        if device_id in self.active_connections:
            try:
                await self.active_connections[device_id].send_json(message)
            except Exception as e:
                print(f"❌ Erro: {e}")
                self.disconnect(device_id)

manager = ConnectionManager()
mdns = MDNSBroadcaster(port=8000, service_name="SyncApp")

# ==================== FASTAPI APP ====================
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    mdns.start()
    yield
    # Shutdown
    mdns.stop()

app = FastAPI(title="SyncApp Server", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ==================== REST ENDPOINTS ====================

@app.get("/api/data")
async def get_data(db: Session = next(get_db())):
    """Retorna todos os registros com versão"""
    records = db.query(DataRecord).all()
    return {
        "records": [
            {
                "id": r.id,
                "title": r.title,
                "value": r.value,
                "computed_result": r.computed_result,
                "version": r.version,
                "updated_at": r.updated_at.isoformat()
            }
            for r in records
        ]
    }

@app.post("/api/data")
async def create_data(payload: dict, db: Session = next(get_db())):
    """Criar novo registro"""
    record = DataRecord(
        title=payload.get("title"),
        value=payload.get("value", 0)
    )
    db.add(record)
    db.commit()
    db.refresh(record)

    # Broadcast
    await manager.broadcast({
        "type": "data_created",
        "data": {
            "id": record.id,
            "title": record.title,
            "value": record.value,
            "version": record.version,
        },
        "timestamp": datetime.utcnow().isoformat()
    })

    return {"id": record.id, "version": record.version}

@app.put("/api/data/{record_id}")
async def update_data(record_id: str, payload: dict, db: Session = next(get_db())):
    """Atualizar registro com controle de versão"""
    record = db.query(DataRecord).filter(DataRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Not found")

    # Verificar versão (para detectar conflitos)
    client_version = payload.get("version", 0)
    if client_version != 0 and client_version != record.version:
        # Conflito! Retornar versão atual
        return {
            "error": "version_conflict",
            "current_version": record.version,
            "status": "conflict"
        }

    record.title = payload.get("title", record.title)
    record.value = payload.get("value", record.value)
    record.computed_result = payload.get("computed_result", record.computed_result)
    record.version += 1
    record.updated_at = datetime.utcnow()
    db.commit()

    await manager.broadcast({
        "type": "data_updated",
        "data": {
            "id": record.id,
            "title": record.title,
            "value": record.value,
            "computed_result": record.computed_result,
            "version": record.version,
        },
        "timestamp": record.updated_at.isoformat()
    })

    return {"version": record.version, "status": "updated"}

@app.delete("/api/data/{record_id}")
async def delete_data(record_id: str, db: Session = next(get_db())):
    """Deletar registro"""
    record = db.query(DataRecord).filter(DataRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Not found")

    db.delete(record)
    db.commit()

    await manager.broadcast({
        "type": "data_deleted",
        "record_id": record_id,
        "timestamp": datetime.utcnow().isoformat()
    })

    return {"status": "deleted"}

# ==================== WEBSOCKET ====================

@app.websocket("/ws/{device_id}")
async def websocket_endpoint(websocket: WebSocket, device_id: str):
    """WebSocket para sincronização em tempo real e fila offline"""
    await manager.connect(websocket, device_id)
    db = SessionLocal()

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "register_device":
                manager.device_registry[device_id]["type"] = data.get("device_type")
                print(f"📱 {device_id} é um {data.get('device_type')}")

            elif msg_type == "sync_request":
                # Enviar todos os dados + timestamp para comparação
                records = db.query(DataRecord).all()
                await manager.send_personal_message(device_id, {
                    "type": "sync_response",
                    "records": [
                        {
                            "id": r.id,
                            "title": r.title,
                            "value": r.value,
                            "computed_result": r.computed_result,
                            "version": r.version,
                            "updated_at": r.updated_at.isoformat()
                        }
                        for r in records
                    ],
                    "server_time": datetime.utcnow().isoformat()
                })

            elif msg_type == "sync_offline_queue":
                # Mobile enviando operações acumuladas offline
                operations = data.get("operations", [])
                print(f"📥 Processando {len(operations)} operações offline de {device_id}")
                
                for op in operations:
                    # Cada operação tem tipo (create/update/delete) e dados
                    if op["type"] == "create":
                        record = DataRecord(
                            title=op["data"].get("title"),
                            value=op["data"].get("value")
                        )
                        db.add(record)
                        db.commit()
                        await manager.broadcast({
                            "type": "data_created",
                            "data": {
                                "id": record.id,
                                "title": record.title,
                                "value": record.value,
                            }
                        }, exclude_device=device_id)

                    elif op["type"] == "update":
                        record = db.query(DataRecord).filter(
                            DataRecord.id == op["record_id"]
                        ).first()
                        if record:
                            record.title = op["data"].get("title", record.title)
                            record.value = op["data"].get("value", record.value)
                            record.version += 1
                            record.updated_at = datetime.utcnow()
                            db.commit()
                            await manager.broadcast({
                                "type": "data_updated",
                                "data": {
                                    "id": record.id,
                                    "title": record.title,
                                    "value": record.value,
                                    "version": record.version,
                                }
                            }, exclude_device=device_id)

                    elif op["type"] == "delete":
                        record = db.query(DataRecord).filter(
                            DataRecord.id == op["record_id"]
                        ).first()
                        if record:
                            db.delete(record)
                            db.commit()
                            await manager.broadcast({
                                "type": "data_deleted",
                                "record_id": op["record_id"]
                            }, exclude_device=device_id)

            elif msg_type == "compute_request":
                # Desktop solicitando computação
                record_id = data.get("record_id")
                record = db.query(DataRecord).filter(DataRecord.id == record_id).first()
                if record:
                    import math
                    record.computed_result = math.sqrt(abs(record.value)) * 100
                    record.version += 1
                    record.updated_at = datetime.utcnow()
                    db.commit()

                    await manager.broadcast({
                        "type": "compute_result",
                        "record_id": record_id,
                        "result": record.computed_result,
                        "version": record.version,
                        "timestamp": record.updated_at.isoformat()
                    }, exclude_device=device_id)

    except Exception as e:
        print(f"❌ WS Error ({device_id}): {e}")
    finally:
        manager.disconnect(device_id)
        db.close()

@app.get("/health")
async def health_check():
    """Health check com info de connected devices"""
    return {
        "status": "ok",
        "connected_devices": len(manager.active_connections),
        "server_time": datetime.utcnow().isoformat()
    }

@app.get("/api/server-info")
async def server_info():
    """Informações do servidor (IP, porta, etc)"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("8.8.8.8", 80))
    local_ip = s.getsockname()[0]
    s.close()

    return {
        "local_ip": local_ip,
        "port": 8000,
        "service_name": "SyncApp",
        "version": "1.0"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
