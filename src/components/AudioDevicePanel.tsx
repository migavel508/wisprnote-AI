import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { logger } from '../lib/logger';

const log = logger.scope('AudioDevicePanel');
import {
  Mic,
  Volume2,
  Bluetooth,
  Usb,
  Monitor,
  Headphones,
  Wifi,
  HelpCircle,
  Check,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Settings,
  X,
} from 'lucide-react';
import {
  listAudioDevices,
  getDefaultInput,
  getDefaultOutput,
  setDefaultInputDevice,
  setDefaultOutputDevice,
  listenForDeviceChanges,
  listenForDeviceRestart,
  type AudioDevice,
  type TransportType,
  type DeviceChangeType,
} from '../services/audioDeviceService';

interface AudioDevicePanelProps {
  isOpen: boolean;
  onClose: () => void;
  isRecording?: boolean;
}

const transportIcon = (type: TransportType) => {
  switch (type) {
    case 'Bluetooth':
      return <Bluetooth className="w-3 h-3" />;
    case 'Usb':
      return <Usb className="w-3 h-3" />;
    case 'BuiltIn':
      return <Monitor className="w-3 h-3" />;
    case 'Hdmi':
      return <Monitor className="w-3 h-3" />;
    case 'Virtual':
      return <Wifi className="w-3 h-3" />;
    default:
      return <HelpCircle className="w-3 h-3" />;
  }
};

const transportLabel = (type: TransportType): string => {
  switch (type) {
    case 'Bluetooth':
      return 'Bluetooth';
    case 'Usb':
      return 'USB';
    case 'BuiltIn':
      return 'Built-in';
    case 'Hdmi':
      return 'HDMI';
    case 'Virtual':
      return 'Virtual';
    default:
      return 'Unknown';
  }
};

const transportColor = (type: TransportType): string => {
  switch (type) {
    case 'Bluetooth':
      return 'bg-blue-50 text-blue-600 border-blue-200';
    case 'Usb':
      return 'bg-purple-50 text-purple-600 border-purple-200';
    case 'BuiltIn':
      return 'bg-gray-50 text-gray-600 border-gray-200';
    case 'Hdmi':
      return 'bg-orange-50 text-orange-600 border-orange-200';
    case 'Virtual':
      return 'bg-teal-50 text-teal-600 border-teal-200';
    default:
      return 'bg-gray-50 text-gray-500 border-gray-200';
  }
};

export default function AudioDevicePanel({ isOpen, onClose, isRecording }: AudioDevicePanelProps) {
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [defaultInput, setDefaultInput] = useState<AudioDevice | null>(null);
  const [defaultOutput, setDefaultOutput] = useState<AudioDevice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showInputs, setShowInputs] = useState(true);
  const [showOutputs, setShowOutputs] = useState(true);
  const [deviceSwitching, setDeviceSwitching] = useState(false);
  const [lastChangeType, setLastChangeType] = useState<string | null>(null);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);

  const refreshDevices = useCallback(async () => {
    setIsLoading(true);
    try {
      const [allDevices, defInput, defOutput] = await Promise.all([
        listAudioDevices(),
        getDefaultInput(),
        getDefaultOutput(),
      ]);

      setInputDevices(allDevices.filter((d) => d.direction === 'Input'));
      setOutputDevices(allDevices.filter((d) => d.direction === 'Output'));
      setDefaultInput(defInput);
      setDefaultOutput(defOutput);
    } catch (e) {
      log.error('refresh_devices_failed', { error: e instanceof Error ? e : undefined });
    } finally {
      setIsLoading(false);
    }
  }, []);

  const activateDevice = useCallback(
    async (device: AudioDevice, currentDefaultId: string | undefined) => {
      if (device.id === currentDefaultId) return;
      setBusyDeviceId(device.id);
      try {
        if (device.direction === 'Input') {
          await setDefaultInputDevice(device.id);
        } else {
          await setDefaultOutputDevice(device.id);
        }
        await refreshDevices();
      } catch (e) {
        log.error('set_default_device_failed', { error: e instanceof Error ? e : undefined });
      } finally {
        setBusyDeviceId(null);
      }
    },
    [refreshDevices],
  );

  useEffect(() => {
    if (isOpen) {
      refreshDevices();
    }
  }, [isOpen, refreshDevices]);

  // Listen for device changes
  useEffect(() => {
    let unlistenChange: (() => void) | null = null;
    let unlistenRestart: (() => void) | null = null;

    (async () => {
      unlistenChange = await listenForDeviceChanges(async (changeType: DeviceChangeType) => {
        setLastChangeType(changeType);
        setTimeout(() => setLastChangeType(null), 3000);
        await refreshDevices();
      });

      unlistenRestart = await listenForDeviceRestart(() => {
        setDeviceSwitching(true);
        setTimeout(() => setDeviceSwitching(false), 3000);
      });
    })();

    return () => {
      unlistenChange?.();
      unlistenRestart?.();
    };
  }, [refreshDevices]);

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="absolute bottom-full left-0 right-0 sm:left-auto sm:right-0 sm:w-[380px] mb-2 z-50"
      >
        <div className="bg-white rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.15)] border border-[#141414]/10 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#141414]/5">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-[#141414]/5 flex items-center justify-center">
                <Settings className="w-3.5 h-3.5 text-[#141414]/60" />
              </div>
              <div>
                <h3 className="text-[13px] font-semibold text-[#141414]">Audio Devices</h3>
                <p className="text-[10px] text-[#141414]/40">
                  {inputDevices.length + outputDevices.length} devices detected
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={refreshDevices}
                className="p-1.5 text-[#141414]/40 hover:text-[#141414] hover:bg-[#141414]/5 rounded-lg transition-colors"
                title="Refresh devices"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={onClose}
                className="p-1.5 text-[#141414]/40 hover:text-[#141414] hover:bg-[#141414]/5 rounded-lg transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Status Banner */}
          <AnimatePresence>
            {(deviceSwitching || lastChangeType) && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div
                  className={`px-4 py-2 text-[11px] font-medium flex items-center gap-2 ${
                    deviceSwitching
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-blue-50 text-blue-700'
                  }`}
                >
                  {deviceSwitching ? (
                    <>
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      Restarting audio capture with new device…
                    </>
                  ) : lastChangeType === 'input-changed' ? (
                    <>
                      <Mic className="w-3 h-3" />
                      Default input device changed
                    </>
                  ) : lastChangeType === 'output-changed' ? (
                    <>
                      <Volume2 className="w-3 h-3" />
                      Default output device changed
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3 h-3" />
                      Device list updated
                    </>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Recording Active Banner */}
          {isRecording && (
            <div className="px-4 py-2 bg-red-50 text-red-600 text-[11px] font-medium flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              Recording active — device changes will auto-restart capture
            </div>
          )}

          <div className="max-h-[360px] overflow-y-auto">
            {/* Input Devices */}
            <div className="px-4 pt-3 pb-1">
              <button
                onClick={() => setShowInputs(!showInputs)}
                className="flex items-center justify-between w-full group"
              >
                <div className="flex items-center gap-2">
                  <Mic className="w-3.5 h-3.5 text-[#141414]/40" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#141414]/40">
                    Input Devices
                  </span>
                  <span className="text-[10px] text-[#141414]/25 tabular-nums">
                    ({inputDevices.length})
                  </span>
                </div>
                {showInputs ? (
                  <ChevronUp className="w-3 h-3 text-[#141414]/30" />
                ) : (
                  <ChevronDown className="w-3 h-3 text-[#141414]/30" />
                )}
              </button>
            </div>

            <AnimatePresence>
              {showInputs && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="px-3 pb-2">
                    {inputDevices.length === 0 ? (
                      <div className="px-3 py-4 text-center text-[12px] text-[#141414]/30">
                        No input devices found
                      </div>
                    ) : (
                      inputDevices.map((device) => (
                      <DeviceRow
                        key={device.id}
                        device={device}
                        isDefault={defaultInput?.id === device.id}
                        isBusy={busyDeviceId === device.id}
                        onActivate={() =>
                          void activateDevice(device, defaultInput?.id)
                        }
                      />
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Divider */}
            <div className="mx-4 border-t border-[#141414]/5" />

            {/* Output Devices */}
            <div className="px-4 pt-3 pb-1">
              <button
                onClick={() => setShowOutputs(!showOutputs)}
                className="flex items-center justify-between w-full group"
              >
                <div className="flex items-center gap-2">
                  <Volume2 className="w-3.5 h-3.5 text-[#141414]/40" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#141414]/40">
                    Output Devices
                  </span>
                  <span className="text-[10px] text-[#141414]/25 tabular-nums">
                    ({outputDevices.length})
                  </span>
                </div>
                {showOutputs ? (
                  <ChevronUp className="w-3 h-3 text-[#141414]/30" />
                ) : (
                  <ChevronDown className="w-3 h-3 text-[#141414]/30" />
                )}
              </button>
            </div>

            <AnimatePresence>
              {showOutputs && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="px-3 pb-3">
                    {outputDevices.length === 0 ? (
                      <div className="px-3 py-4 text-center text-[12px] text-[#141414]/30">
                        No output devices found
                      </div>
                    ) : (
                      outputDevices.map((device) => (
                      <DeviceRow
                        key={device.id}
                        device={device}
                        isDefault={defaultOutput?.id === device.id}
                        isBusy={busyDeviceId === device.id}
                        onActivate={() =>
                          void activateDevice(device, defaultOutput?.id)
                        }
                      />
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Footer */}
          <div className="px-4 py-2.5 bg-[#FAFAFA] border-t border-[#141414]/5">
            <p className="text-[10px] text-[#141414]/30 text-center">
              Tap a device to set it as the system default (mic or speakers). Native recording uses the
              default microphone. CoreAudio detects Bluetooth and USB automatically.
            </p>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

function DeviceRow({
  device,
  isDefault,
  isBusy,
  onActivate,
}: {
  device: AudioDevice;
  isDefault: boolean;
  isBusy: boolean;
  onActivate: () => void;
}) {
  const canTap = !isDefault && !isBusy;
  const hint =
    device.direction === 'Input' ? 'Set as default microphone' : 'Set as default output';

  return (
    <div
      role={canTap ? 'button' : undefined}
      tabIndex={canTap ? 0 : -1}
      onClick={() => canTap && onActivate()}
      onKeyDown={(e) => {
        if (canTap && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onActivate();
        }
      }}
      title={isDefault ? undefined : hint}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${
        isDefault
          ? 'bg-[#141414]/[0.04]'
          : 'hover:bg-[#141414]/[0.02]'
      } ${canTap ? 'cursor-pointer' : ''} ${isBusy ? 'opacity-70 pointer-events-none' : ''}`}
    >
      {/* Device Icon */}
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
          isDefault ? 'bg-[#141414] text-white' : 'bg-[#141414]/5 text-[#141414]/40'
        }`}
      >
        {device.is_headphone ? (
          <Headphones className="w-4 h-4" />
        ) : device.direction === 'Input' ? (
          <Mic className="w-4 h-4" />
        ) : (
          <Volume2 className="w-4 h-4" />
        )}
      </div>

      {/* Device Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className={`text-[13px] font-medium truncate ${
              isDefault ? 'text-[#141414]' : 'text-[#141414]/70'
            }`}
          >
            {device.name}
          </span>
          {isDefault && (
            <span className="flex-shrink-0 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center">
              <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
            </span>
          )}
          {isBusy && <RefreshCw className="w-3.5 h-3.5 text-[#141414]/35 animate-spin flex-shrink-0" />}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {/* Transport Badge */}
          <span
            className={`inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${transportColor(
              device.transport_type,
            )}`}
          >
            {transportIcon(device.transport_type)}
            {transportLabel(device.transport_type)}
          </span>

          {/* Headphone Badge */}
          {device.is_headphone && (
            <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border bg-indigo-50 text-indigo-600 border-indigo-200">
              <Headphones className="w-2.5 h-2.5" />
              Headphone
            </span>
          )}

          {/* Default label */}
          {isDefault && (
            <span className="text-[9px] font-semibold uppercase tracking-wide text-green-600">
              Default
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
