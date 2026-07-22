import { useState, useEffect, useCallback } from 'react';

export interface AudioDevice {
  deviceId: string;
  label: string;
}

export function useAudioDevices() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('default');
  const [volume, setVolume] = useState(100);

  const loadDevices = useCallback(async () => {
    try {
      // The Permissions API can report "prompt" even after the user has
      // actually granted access — Chrome ignores extension-origin grants in
      // its permissions.query() until getUserMedia fires at least once.
      // We always try to enumerate first (cheap, no prompt); if labels come
      // back empty it means permission isn't granted yet and we just render
      // the device list with generic names.
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = allDevices
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${i + 1}`,
        }));
      setDevices(audioInputs);
    } catch {
      // enumerateDevices can still throw in restricted contexts (e.g. the
      // extension is loaded into a page without secure-context).  Swallow —
      // the mic dropdown will simply show "System Default" only.
    }
  }, []);

  useEffect(() => {
    chrome.storage?.local
      ?.get(['micDeviceId', 'micVolume'])
      .then((result: { micDeviceId?: string; micVolume?: number }) => {
        if (result.micDeviceId) setSelectedDeviceId(result.micDeviceId);
        if (result.micVolume !== undefined) setVolume(result.micVolume);
      })
      .catch(() => {});
    loadDevices();

    const handler = () => loadDevices();
    navigator.mediaDevices.addEventListener('devicechange', handler);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
  }, [loadDevices]);

  const selectDevice = useCallback((deviceId: string) => {
    setSelectedDeviceId(deviceId);
    chrome.storage?.local?.set({ micDeviceId: deviceId }).catch(() => {});
  }, []);

  const changeVolume = useCallback((vol: number) => {
    setVolume(vol);
    chrome.storage?.local?.set({ micVolume: vol }).catch(() => {});
  }, []);

  return {
    devices,
    selectedDeviceId,
    selectDevice,
    volume,
    changeVolume,
    refreshDevices: loadDevices,
  };
}
