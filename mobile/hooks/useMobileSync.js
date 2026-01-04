// shared/hooks/useMobileSync.js - Auto-discovery + Offline support
import { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Para descoberta via mDNS
import { useNetInfo } from '@react-native-community/netinfo';

export function useMobileSync(deviceType) {
  const [ws, setWs] = useState(null);
  const [connected, setConnected] = useState(false);
  const [deviceId] = useState(() => {
    // Gerar ou recuperar device ID
    const stored = localStorage?.getItem?.('deviceId');
    if (stored) return stored;
    const id = uuidv4();
    localStorage?.setItem?.('deviceId', id);
    return id;
  });
  const [serverIp, setServerIp] = useState(null);
  const netInfo = useNetInfo();
  const reconnectTimeoutRef = useRef(null);

  // Descobrir servidor via mDNS / Bonjour
  const discoverServer = async () => {
    try {
      // 1. Tentar descoberta automática (requer zeroconf-react-native)
      // const servers = await discovery.getServices('_http._tcp');
      
      // 2. Fallback: procurar em IPs comuns da rede local
      const possibleIps = generatePossibleIps();
      
      for (const ip of possibleIps) {
        try {
          const res = await Promise.race([
            fetch(`http://${ip}:8000/health`),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('timeout')), 2000)
            )
          ]);
          
          if (res.ok) {
            const data = await res.json();
            console.log(`✅ Servidor encontrado: ${ip}`);
            setServerIp(ip);
            await AsyncStorage.setItem('serverIp', ip);
            return ip;
          }
        } catch (err) {
          // Continue tentando próximo IP
        }
      }
      
      console.log('❌ Servidor não encontrado na rede');
      return null;
    } catch (err) {
      console.error('Discovery error:', err);
      return null;
    }
  };

  // Gerar IPs possíveis da rede (ex: 192.168.1.1-254)
  const generatePossibleIps = () => {
    const ips = [];
    
    // Adicionar algumas IPs fixas comuns
    const commonIps = [
      '192.168.1.1',
      '192.168.1.100',
      '192.168.0.1',
      '192.168.0.100',
      '10.0.0.1',
      '10.0.0.100',
      '172.16.0.1',
    ];
    
    ips.push(...commonIps);
    
    // Se conseguir IP da rede, gerar range local
    if (netInfo?.details?.ipAddress) {
      const subnet = netInfo.details.ipAddress.substring(0, netInfo.details.ipAddress.lastIndexOf('.'));
      for (let i = 1; i <= 254; i += 10) { // Verificar cada 10 IPs para não travar
        ips.push(`${subnet}.${i}`);
      }
    }
    
    return [...new Set(ips)]; // Remove duplicatas
  };

  // Conectar ao WebSocket
  useEffect(() => {
    if (!serverIp) return;

    let ws = null;
    let reconnectTimeout = null;

    const connect = () => {
      ws = new WebSocket(`ws://${serverIp}:8000/ws/${deviceId}`);

      ws.onopen = () => {
        console.log(`[WS] Connected ao ${serverIp}`);
        setConnected(true);

        // Registrar device
        ws.send(JSON.stringify({
          type: 'register_device',
          device_type: deviceType
        }));

        // Solicitar sync
        ws.send(JSON.stringify({
          type: 'sync_request'
        }));

        setWs(ws);
      };

      ws.onerror = (error) => {
        console.error('[WS] Error:', error);
        setConnected(false);
      };

      ws.onclose = () => {
        console.log('[WS] Desconectado');
        setConnected(false);
        setWs(null);

        // Tentar reconectar em 5 segundos
        reconnectTimeout = setTimeout(connect, 5000);
      };
    };

    connect();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [serverIp, deviceId, deviceType]);

  // Carregar servidor salvo ao iniciar
  useEffect(() => {
    const loadServerIp = async () => {
      const saved = await AsyncStorage.getItem('serverIp');
      if (saved) {
        setServerIp(saved);
      } else {
        // Tentar descobrir
        await discoverServer();
      }
    };

    loadServerIp();
  }, []);

  return {
    ws,
    connected,
    deviceId,
    serverIp,
    discoverServer
  };
}

// shared/hooks/usePersistence.js - Atualizado para suportar Web também
import AsyncStorage from '@react-native-async-storage/async-storage';

const isWeb = typeof window !== 'undefined' && !window.ReactNative;

export function usePersistence() {
  const saveLocal = async (key, value) => {
    try {
      if (isWeb) {
        localStorage.setItem(key, JSON.stringify(value));
      } else {
        await AsyncStorage.setItem(key, JSON.stringify(value));
      }
    } catch (err) {
      console.error(`Save ${key} error:`, err);
    }
  };

  const loadLocal = async (key) => {
    try {
      let data;
      if (isWeb) {
        data = localStorage.getItem(key);
      } else {
        data = await AsyncStorage.getItem(key);
      }
      return data ? JSON.parse(data) : null;
    } catch (err) {
      console.error(`Load ${key} error:`, err);
      return null;
    }
  };

  const removeLocal = async (key) => {
    try {
      if (isWeb) {
        localStorage.removeItem(key);
      } else {
        await AsyncStorage.removeItem(key);
      }
    } catch (err) {
      console.error(`Remove ${key} error:`, err);
    }
  };

  return { saveLocal, loadLocal, removeLocal };
}
