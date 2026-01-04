import React, { useState, useEffect, useRef } from 'react';
import { AlertCircle, Plus, Trash2, Zap, Server } from 'lucide-react';
import { useSync } from './hooks/useSync';
import { usePersistence } from './hooks/usePersistence';

export default function DesktopApp() {
  const [records, setRecords] = useState([]);
  const [input, setInput] = useState({ title: '', value: '' });
  const [computing, setComputing] = useState(null);
  const [serverStatus, setServerStatus] = useState('checking');
  const [connectedDevices, setConnectedDevices] = useState(0);
  
  const { ws, connected, deviceId, serverReady } = useSync('desktop');
  const { saveLocal, loadLocal } = usePersistence();

  // Carregar dados ao iniciar
  useEffect(() => {
    loadCachedData();
    checkServerStatus();
    const interval = setInterval(checkServerStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const checkServerStatus = async () => {
    try {
      const res = await fetch('http://localhost:8000/health');
      if (res.ok) {
        const data = await res.json();
        setServerStatus('running');
        setConnectedDevices(data.connected_devices);
      }
    } catch {
      setServerStatus('offline');
    }
  };

  const loadCachedData = async () => {
    const cached = await loadLocal('records');
    if (cached) setRecords(cached);
  };

  // Receber atualizações via WebSocket
  useEffect(() => {
    if (!ws) return;

    const handleMessage = async (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'sync_response':
          setRecords(data.records);
          await saveLocal('records', data.records);
          break;

        case 'data_created':
          setRecords(prev => [...prev, data.data]);
          await saveLocal('records', [...records, data.data]);
          break;

        case 'data_updated':
          const updated = records.map(r => r.id === data.data.id ? data.data : r);
          setRecords(updated);
          await saveLocal('records', updated);
          break;

        case 'data_deleted':
          const filtered = records.filter(r => r.id !== data.record_id);
          setRecords(filtered);
          await saveLocal('records', filtered);
          break;

        case 'compute_result':
          const computed = records.map(r =>
            r.id === data.record_id ? { ...r, computed_result: data.result } : r
          );
          setRecords(computed);
          setComputing(null);
          break;

        case 'device_status':
          setConnectedDevices(data.connected_devices.length);
          break;
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws, records]);

  const createRecord = async () => {
    if (!input.title || !input.value) return;

    try {
      const res = await fetch('http://localhost:8000/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: input.title,
          value: parseFloat(input.value)
        })
      });

      if (res.ok) {
        setInput({ title: '', value: '' });
      }
    } catch (err) {
      console.error('Create error:', err);
    }
  };

  const deleteRecord = async (id) => {
    try {
      await fetch(`http://localhost:8000/api/data/${id}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Delete error:', err);
    }
  };

  const computeRecord = async (id) => {
    setComputing(id);
    ws?.send(JSON.stringify({
      type: 'compute_request',
      record_id: id
    }));
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-4xl font-bold text-white">SyncApp Desktop</h1>
            <div className="flex items-center gap-4">
              {/* Server Status */}
              <div className="bg-slate-800 rounded-lg px-4 py-3 border border-slate-700 flex items-center gap-3">
                <Server size={20} className={serverStatus === 'running' ? 'text-emerald-400' : 'text-red-400'} />
                <div>
                  <p className="text-xs text-slate-400">Servidor</p>
                  <p className={`text-sm font-semibold ${serverStatus === 'running' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {serverStatus === 'running' ? '✓ Ativo' : '✗ Offline'}
                  </p>
                </div>
              </div>

              {/* Connected Devices */}
              <div className="bg-slate-800 rounded-lg px-4 py-3 border border-slate-700">
                <p className="text-xs text-slate-400">Devices Conectados</p>
                <p className="text-sm font-semibold text-teal-400">{connectedDevices}</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
            <p className="text-sm text-slate-300">
              {connected ? `Conectado (${deviceId.slice(0, 8)})` : 'Desconectado'}
            </p>
          </div>
        </div>

        {/* Aviso se servidor offline */}
        {serverStatus !== 'running' && (
          <div className="mb-6 bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-center gap-3">
            <AlertCircle className="text-red-400" size={20} />
            <div>
              <p className="text-red-300 font-semibold">Servidor desativado</p>
              <p className="text-sm text-red-200">O servidor deve estar rodando para sincronizar dados.</p>
            </div>
          </div>
        )}

        {/* Input Section */}
        <div className="bg-slate-800 rounded-lg p-6 mb-8 border border-slate-700">
          <h2 className="text-lg font-semibold text-white mb-4">Novo Registro</h2>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Título"
              value={input.title}
              onChange={(e) => setInput({ ...input, title: e.target.value })}
              className="flex-1 px-4 py-2 rounded-lg bg-slate-700 text-white placeholder-slate-400 border border-slate-600 focus:border-teal-500 focus:outline-none"
            />
            <input
              type="number"
              placeholder="Valor"
              value={input.value}
              onChange={(e) => setInput({ ...input, value: e.target.value })}
              className="w-24 px-4 py-2 rounded-lg bg-slate-700 text-white placeholder-slate-400 border border-slate-600 focus:border-teal-500 focus:outline-none"
            />
            <button
              onClick={createRecord}
              disabled={!connected || serverStatus !== 'running'}
              className="px-6 py-2 rounded-lg bg-teal-500 hover:bg-teal-600 disabled:opacity-50 text-white font-medium transition flex items-center gap-2"
            >
              <Plus size={18} />
              Criar
            </button>
          </div>
        </div>

        {/* Records Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white mb-4">Registros Locais</h2>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {records.length === 0 ? (
                <div className="bg-slate-800 rounded-lg p-8 border border-slate-700 text-center">
                  <AlertCircle className="mx-auto mb-3 text-slate-400" size={32} />
                  <p className="text-slate-400">Nenhum registro</p>
                </div>
              ) : (
                records.map(record => (
                  <div key={record.id} className="bg-slate-800 rounded-lg p-4 border border-slate-700 hover:border-slate-600 transition">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <h3 className="text-white font-semibold">{record.title}</h3>
                        <p className="text-sm text-slate-400">Valor: {record.value}</p>
                        {record.computed_result !== null && (
                          <p className="text-sm text-teal-400 font-mono">
                            Resultado: {record.computed_result.toFixed(2)}
                          </p>
                        )}
                        <p className="text-xs text-slate-500 mt-1">v{record.version}</p>
                      </div>

                      <div className="flex gap-2">
                        <button
                          onClick={() => computeRecord(record.id)}
                          disabled={computing === record.id}
                          className="px-3 py-2 rounded-lg bg-teal-500 hover:bg-teal-600 disabled:opacity-50 text-white text-sm font-medium transition"
                        >
                          <Zap size={16} />
                        </button>
                        <button
                          onClick={() => deleteRecord(record.id)}
                          className="px-3 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 text-sm font-medium transition"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Server Info */}
          <div>
            <h2 className="text-lg font-semibold text-white mb-4">Informações do Servidor</h2>
            <div className="bg-slate-800 rounded-lg p-6 border border-slate-700 space-y-4">
              <div>
                <p className="text-xs text-slate-400 mb-1">Endereço Local</p>
                <code className="text-sm bg-slate-700 px-3 py-2 rounded text-teal-300 break-all">
                  localhost:8000
                </code>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">Endereço na Rede</p>
                <code className="text-sm bg-slate-700 px-3 py-2 rounded text-teal-300 break-all">
                  SyncApp.local (mDNS)
                </code>
                <p className="text-xs text-slate-500 mt-2">
                  Dispositivos mobile podem descobrir automaticamente
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">Status</p>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${serverStatus === 'running' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                  <span className={`text-sm ${serverStatus === 'running' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {serverStatus === 'running' ? 'Servidor rodando' : 'Servidor offline'}
                  </span>
                </div>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">Devices Conectados</p>
                <p className="text-lg font-semibold text-teal-400">{connectedDevices}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Status Bar */}
        <div className="mt-8 p-4 bg-slate-800 rounded-lg border border-slate-700 text-xs text-slate-400">
          <p>Total: {records.length} registros | Computados: {records.filter(r => r.computed_result !== null).length}</p>
        </div>
      </div>
    </div>
  );
}
