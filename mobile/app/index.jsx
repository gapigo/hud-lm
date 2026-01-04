// mobile/app/index.jsx - React Native com Offline-First + Auto-Discovery
import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { Plus, Trash2, Zap, Wifi, WifiOff } from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMobileSync } from '../hooks/useMobileSync';

export default function MobileApp() {
  const [records, setRecords] = useState([]);
  const [input, setInput] = useState({ title: '', value: '' });
  const [computing, setComputing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [offlineQueue, setOfflineQueue] = useState([]);
  const [discoveringServer, setDiscoveringServer] = useState(false);
  
  const { 
    ws, 
    connected, 
    deviceId, 
    serverIp,
    discoverServer 
  } = useMobileSync('mobile');

  // Carregar dados e fila ao iniciar
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const cached = await AsyncStorage.getItem('records');
      if (cached) setRecords(JSON.parse(cached));
      
      const queue = await AsyncStorage.getItem('offlineQueue');
      if (queue) setOfflineQueue(JSON.parse(queue));
    } catch (err) {
      console.error('Load error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Auto-discover servidor ao conectar na WiFi
  useEffect(() => {
    if (!connected && !serverIp) {
      discoverServerAuto();
    }
  }, []);

  const discoverServerAuto = async () => {
    setDiscoveringServer(true);
    try {
      const discovered = await discoverServer();
      if (discovered) {
        console.log('✅ Servidor descoberto:', discovered);
      }
    } catch (err) {
      console.error('Discovery error:', err);
    } finally {
      setDiscoveringServer(false);
    }
  };

  // Sincronizar fila offline quando conectar
  useEffect(() => {
    if (connected && offlineQueue.length > 0) {
      syncOfflineQueue();
    }
  }, [connected]);

  // Receber updates via WebSocket
  useEffect(() => {
    if (!ws) return;

    const handleMessage = async (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'sync_response':
          setRecords(data.records);
          await AsyncStorage.setItem('records', JSON.stringify(data.records));
          break;

        case 'data_created':
          const withNew = [...records, data.data];
          setRecords(withNew);
          await AsyncStorage.setItem('records', JSON.stringify(withNew));
          break;

        case 'data_updated':
          const updated = records.map(r => r.id === data.data.id ? data.data : r);
          setRecords(updated);
          await AsyncStorage.setItem('records', JSON.stringify(updated));
          break;

        case 'data_deleted':
          const filtered = records.filter(r => r.id !== data.record_id);
          setRecords(filtered);
          await AsyncStorage.setItem('records', JSON.stringify(filtered));
          break;

        case 'compute_result':
          const computed = records.map(r =>
            r.id === data.record_id ? { ...r, computed_result: data.result } : r
          );
          setRecords(computed);
          await AsyncStorage.setItem('records', JSON.stringify(computed));
          setComputing(null);
          break;
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws, records]);

  const syncOfflineQueue = () => {
    if (!ws || offlineQueue.length === 0) return;

    console.log('📤 Sincronizando fila offline...');
    ws.send(JSON.stringify({
      type: 'sync_offline_queue',
      operations: offlineQueue
    }));

    setOfflineQueue([]);
    AsyncStorage.removeItem('offlineQueue');
  };

  const createRecord = async () => {
    if (!input.title || !input.value) {
      Alert.alert('Erro', 'Preencha título e valor');
      return;
    }

    if (connected && ws) {
      // Online: enviar direto ao servidor
      try {
        const res = await fetch(`http://${serverIp}:8000/api/data`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: input.title,
            value: parseFloat(input.value)
          })
        });
        if (res.ok) setInput({ title: '', value: '' });
      } catch (err) {
        console.error('Create error:', err);
      }
    } else {
      // Offline: adicionar à fila
      const op = {
        type: 'create',
        data: {
          title: input.title,
          value: parseFloat(input.value),
          id: `local_${Date.now()}`
        }
      };
      
      const newQueue = [...offlineQueue, op];
      setOfflineQueue(newQueue);
      await AsyncStorage.setItem('offlineQueue', JSON.stringify(newQueue));
      
      // Adicionar localmente também
      const newRecord = {
        id: op.data.id,
        title: op.data.title,
        value: op.data.value,
        computed_result: null,
        version: 0
      };
      const newRecords = [...records, newRecord];
      setRecords(newRecords);
      await AsyncStorage.setItem('records', JSON.stringify(newRecords));
      
      setInput({ title: '', value: '' });
      Alert.alert('Offline', 'Dado salvo localmente. Será sincronizado ao conectar.');
    }
  };

  const deleteRecord = async (id) => {
    if (connected && ws) {
      try {
        await fetch(`http://${serverIp}:8000/api/data/${id}`, { method: 'DELETE' });
      } catch (err) {
        console.error('Delete error:', err);
      }
    } else {
      // Offline: adicionar delete à fila
      const op = { type: 'delete', record_id: id };
      const newQueue = [...offlineQueue, op];
      setOfflineQueue(newQueue);
      await AsyncStorage.setItem('offlineQueue', JSON.stringify(newQueue));
      
      const filtered = records.filter(r => r.id !== id);
      setRecords(filtered);
      await AsyncStorage.setItem('records', JSON.stringify(filtered));
    }
  };

  const requestCompute = (id) => {
    if (!connected || !ws) {
      Alert.alert('Offline', 'Computação requer conexão com servidor');
      return;
    }
    setComputing(id);
    ws.send(JSON.stringify({
      type: 'compute_request',
      record_id: id
    }));
  };

  if (loading) {
    return (
      <View className="flex-1 bg-slate-900 justify-center items-center">
        <ActivityIndicator size="large" color="#14b8a6" />
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 bg-slate-900">
      <View className="p-4">
        {/* Header */}
        <Text className="text-3xl font-bold text-white mb-1">SyncApp Mobile</Text>
        
        {/* Connection Status */}
        <View className="flex-row items-center mb-6 gap-4">
          <View className="flex-row items-center">
            {connected ? (
              <>
                <Wifi size={16} color="#4ade80" />
                <Text className="text-xs text-emerald-400 ml-1">Conectado</Text>
              </>
            ) : (
              <>
                <WifiOff size={16} color="#f87171" />
                <Text className="text-xs text-red-400 ml-1">Offline</Text>
              </>
            )}
          </View>
          
          {!connected && (
            <TouchableOpacity
              onPress={discoverServerAuto}
              disabled={discoveringServer}
              className="px-3 py-1 bg-teal-500 rounded"
            >
              <Text className="text-xs text-white font-semibold">
                {discoveringServer ? 'Buscando...' : 'Buscar Servidor'}
              </Text>
            </TouchableOpacity>
          )}
          
          {offlineQueue.length > 0 && (
            <View className="px-3 py-1 bg-yellow-500/20 rounded border border-yellow-500/50">
              <Text className="text-xs text-yellow-400">
                {offlineQueue.length} pendentes
              </Text>
            </View>
          )}
        </View>

        {/* Input Section */}
        <View className="bg-slate-800 rounded-lg p-4 mb-6 border border-slate-700">
          <Text className="text-base font-semibold text-white mb-3">Novo Registro</Text>
          <TextInput
            placeholder="Título"
            value={input.title}
            onChangeText={(text) => setInput({ ...input, title: text })}
            placeholderTextColor="#94a3b8"
            className="bg-slate-700 text-white px-3 py-2 rounded-lg mb-2 border border-slate-600"
          />
          <TextInput
            placeholder="Valor"
            value={input.value}
            onChangeText={(text) => setInput({ ...input, value: text })}
            keyboardType="decimal-pad"
            placeholderTextColor="#94a3b8"
            className="bg-slate-700 text-white px-3 py-2 rounded-lg mb-3 border border-slate-600"
          />
          <TouchableOpacity
            onPress={createRecord}
            className="bg-teal-500 rounded-lg py-2 flex-row items-center justify-center"
          >
            <Plus size={18} color="white" />
            <Text className="text-white font-medium ml-2">Criar</Text>
          </TouchableOpacity>
        </View>

        {/* Records List */}
        <Text className="text-base font-semibold text-white mb-3">
          Registros ({records.length})
        </Text>
        {records.length === 0 ? (
          <View className="bg-slate-800 rounded-lg p-8 border border-slate-700 items-center">
            <Text className="text-slate-400 text-center">Nenhum registro</Text>
          </View>
        ) : (
          records.map(record => (
            <View key={record.id} className="bg-slate-800 rounded-lg p-4 mb-3 border border-slate-700">
              <Text className="text-white font-semibold">{record.title}</Text>
              <Text className="text-sm text-slate-400 mt-1">Valor: {record.value}</Text>
              {record.computed_result !== null && (
                <Text className="text-sm text-teal-400 font-mono mt-1">
                  Resultado: {record.computed_result.toFixed(2)}
                </Text>
              )}
              {record.id.startsWith('local_') && (
                <Text className="text-xs text-yellow-400 mt-1">⚠️  Pendente sincronização</Text>
              )}

              <View className="flex-row gap-2 mt-3">
                <TouchableOpacity
                  onPress={() => requestCompute(record.id)}
                  disabled={computing === record.id}
                  className="flex-1 bg-teal-500 rounded-lg py-2 flex-row items-center justify-center"
                >
                  <Zap size={16} color="white" />
                  <Text className="text-white text-sm font-medium ml-1">
                    {computing === record.id ? 'Computando...' : 'Computar'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => deleteRecord(record.id)}
                  className="px-3 py-2 rounded-lg bg-red-500/20"
                >
                  <Trash2 size={16} color="#f87171" />
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}

        {/* Offline Notice */}
        {!connected && (
          <View className="mt-6 p-4 bg-yellow-500/10 rounded-lg border border-yellow-500/30">
            <Text className="text-yellow-300 text-sm">
              📱 Modo offline ativo. Suas alterações serão sincronizadas quando o servidor for encontrado.
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}
