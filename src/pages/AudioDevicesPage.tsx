import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { logger } from '../lib/logger';

const log = logger.scope('AudioDevicesPage');
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
  Settings2,
  Activity,
  Radio,
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

interface AudioDevicesPageProps {
  isRecording?: boolean;
  currentInputDevice?: string | null;
  deviceRestartNotice?: boolean;
}

const transportIcon = (type: TransportType, size = 'w-3.5 h-3.5') => {
  const cls = size;
  switch (type) {
    case 'Bluetooth': return <Bluetooth className={cls} />;
    case 'Usb': return <Usb className={cls} />;
    case 'BuiltIn': return <Monitor className={cls} />;
    case 'Hdmi': return <Monitor className={cls} />;
    case 'Virtual': return <Wifi className={cls} />;
    default: return <HelpCircle className={cls} />;
  }
};

const transportLabel = (type: TransportType): string => {
  switch (type) {
    case 'Bluetooth': return 'Bluetooth';
    case 'Usb': return 'USB';
    case 'BuiltIn': return 'Built-in';
    case 'Hdmi': return 'HDMI';
    case 'Virtual': return 'Virtual';
    default: return 'Unknown';
  }
};

const transportColor = (type: TransportType): string => {
  switch (type) {
    case 'Bluetooth': return 'bg-blue-50 text-blue-600 border-blue-200';
    case 'Usb': return 'bg-purple-50 text-purple-600 border-purple-200';
    case 'BuiltIn': return 'bg-gray-100 text-gray-600 border-gray-200';
    case 'Hdmi': return 'bg-orange-50 text-orange-600 border-orange-200';
    case 'Virtual': return 'bg-teal-50 text-teal-600 border-teal-200';
    default: return 'bg-gray-50 text-gray-500 border-gray-200';
  }
};

const transportBgColor = (type: TransportType): string => {
  switch (type) {
    case 'Bluetooth': return 'from-blue-500 to-blue-600';
    case 'Usb': return 'from-purple-500 to-purple-600';
    case 'BuiltIn': return 'from-gray-500 to-gray-600';
    case 'Hdmi': return 'from-orange-500 to-orange-600';
    case 'Virtual': return 'from-teal-500 to-teal-600';
    default: return 'from-gray-400 to-gray-500';
  }
};

export default function AudioDevicesPage({ isRecording, currentInputDevice, deviceRestartNotice }: AudioDevicesPageProps) {
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [defaultInput, setDefaultInput] = useState<AudioDevice | null>(null);
  const [defaultOutput, setDefaultOutput] = useState<AudioDevice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showInputs, setShowInputs] = useState(true);
  const [showOutputs, setShowOutputs] = useState(true);
  const [deviceSwitching, setDeviceSwitching] = useState(false);
  const [lastChangeType, setLastChangeType] = useState<string | null>(null);
  const [changeCount, setChangeCount] = useState(0);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [deviceActionError, setDeviceActionError] = useState<string | null>(null);

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

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    let unlistenChange: (() => void) | null = null;
    let unlistenRestart: (() => void) | null = null;

    (async () => {
      unlistenChange = await listenForDeviceChanges(async (changeType: DeviceChangeType) => {
        setLastChangeType(changeType);
        setChangeCount((c) => c + 1);
        setTimeout(() => setLastChangeType(null), 4000);
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

  const activateDevice = useCallback(
    async (device: AudioDevice) => {
      const isAlreadyDefault =
        device.direction === 'Input'
          ? defaultInput?.id === device.id
          : defaultOutput?.id === device.id;
      if (isAlreadyDefault) return;

      setBusyDeviceId(device.id);
      setDeviceActionError(null);
      try {
        if (device.direction === 'Input') {
          await setDefaultInputDevice(device.id);
        } else {
          await setDefaultOutputDevice(device.id);
        }
        await refreshDevices();
      } catch (e) {
        setDeviceActionError(
          e instanceof Error ? e.message : 'Could not change the default device.',
        );
      } finally {
        setBusyDeviceId(null);
      }
    },
    [defaultInput?.id, defaultOutput?.id, refreshDevices],
  );

  return (
    <div className="flex flex-col h-full bg-white font-[system-ui] overflow-y-auto">
      <div className="w-full max-w-[760px] mx-auto px-3 sm:px-6 md:px-8 pt-5 sm:pt-12 pb-8 sm:pb-12">
        {/* Page Title */}
        <h1 className="text-[20px] sm:text-[32px] font-serif text-[#141414]/30 mb-1 sm:mb-2">
          Audio Devices
        </h1>
        <p className="text-[12px] sm:text-[14px] text-[#141414]/40 mb-5 sm:mb-8">
          Manage input and output devices. Tap a device to make it the system default — native recording
          uses the default microphone (Bluetooth, USB, or built-in). Changes are auto-detected.
        </p>

        {deviceActionError && (
          <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-800">
            {deviceActionError}
          </div>
        )}

        {/* Status Cards Row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
          {/* Current Input */}
          <div className="bg-white rounded-2xl border border-[#141414]/8 p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-xl bg-[#141414] flex items-center justify-center">
                <Mic className="w-4 h-4 text-white" />
              </div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#141414]/40">Input</span>
            </div>
            <p className="text-[14px] font-medium text-[#141414] truncate">
              {defaultInput?.name || 'No device'}
            </p>
            {defaultInput && (
              <div className="flex items-center gap-1.5 mt-2">
                <span className={`inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${transportColor(defaultInput.transport_type)}`}>
                  {transportIcon(defaultInput.transport_type, 'w-2.5 h-2.5')}
                  {transportLabel(defaultInput.transport_type)}
                </span>
              </div>
            )}
          </div>

          {/* Current Output */}
          <div className="bg-white rounded-2xl border border-[#141414]/8 p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-xl bg-[#141414] flex items-center justify-center">
                {defaultOutput?.is_headphone
                  ? <Headphones className="w-4 h-4 text-white" />
                  : <Volume2 className="w-4 h-4 text-white" />
                }
              </div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#141414]/40">Output</span>
              {defaultOutput?.is_headphone && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-semibold border border-indigo-200">
                  Headphone
                </span>
              )}
            </div>
            <p className="text-[14px] font-medium text-[#141414] truncate">
              {defaultOutput?.name || 'No device'}
            </p>
            {defaultOutput && (
              <div className="flex items-center gap-1.5 mt-2">
                <span className={`inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${transportColor(defaultOutput.transport_type)}`}>
                  {transportIcon(defaultOutput.transport_type, 'w-2.5 h-2.5')}
                  {transportLabel(defaultOutput.transport_type)}
                </span>
              </div>
            )}
          </div>

          {/* Status */}
          <div className="bg-white rounded-2xl border border-[#141414]/8 p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${isRecording ? 'bg-red-500' : 'bg-green-500'}`}>
                <Activity className="w-4 h-4 text-white" />
              </div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#141414]/40">Status</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-green-500'}`} />
              <p className="text-[14px] font-medium text-[#141414]">
                {isRecording ? 'Recording Active' : 'Ready'}
              </p>
            </div>
            <p className="text-[11px] text-[#141414]/35 mt-1.5">
              {changeCount} device change{changeCount !== 1 ? 's' : ''} detected this session
            </p>
          </div>
        </div>

        {/* Event Banner */}
        <AnimatePresence>
          {(deviceSwitching || lastChangeType || deviceRestartNotice) && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className={`rounded-xl px-4 py-3 mb-6 flex items-center gap-3 ${
                deviceSwitching || deviceRestartNotice
                  ? 'bg-amber-50 border border-amber-200'
                  : 'bg-blue-50 border border-blue-200'
              }`}
            >
              {deviceSwitching || deviceRestartNotice ? (
                <>
                  <RefreshCw className="w-4 h-4 text-amber-600 animate-spin flex-shrink-0" />
                  <div>
                    <p className="text-[13px] font-medium text-amber-800">Restarting audio capture</p>
                    <p className="text-[11px] text-amber-600">Switching to new device seamlessly…</p>
                  </div>
                </>
              ) : lastChangeType === 'input-changed' ? (
                <>
                  <Mic className="w-4 h-4 text-blue-600 flex-shrink-0" />
                  <div>
                    <p className="text-[13px] font-medium text-blue-800">Default input device changed</p>
                    <p className="text-[11px] text-blue-600">Now using: {defaultInput?.name || 'Unknown'}</p>
                  </div>
                </>
              ) : lastChangeType === 'output-changed' ? (
                <>
                  <Volume2 className="w-4 h-4 text-blue-600 flex-shrink-0" />
                  <div>
                    <p className="text-[13px] font-medium text-blue-800">Default output device changed</p>
                    <p className="text-[11px] text-blue-600">Now using: {defaultOutput?.name || 'Unknown'}</p>
                  </div>
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 text-blue-600 flex-shrink-0" />
                  <div>
                    <p className="text-[13px] font-medium text-blue-800">Device list updated</p>
                    <p className="text-[11px] text-blue-600">A device was connected or disconnected</p>
                  </div>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input Devices */}
        <div className="mb-6">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setShowInputs(!showInputs)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowInputs(!showInputs); } }}
            className="flex items-center justify-between w-full mb-3 group cursor-pointer select-none"
          >
            <div className="flex items-center gap-2.5">
              <Mic className="w-4 h-4 text-[#141414]/40" />
              <span className="text-[12px] font-semibold uppercase tracking-wider text-[#141414]/40">
                Input Devices
              </span>
              <span className="text-[11px] text-[#141414]/25 tabular-nums bg-[#141414]/5 px-2 py-0.5 rounded-full font-medium">
                {inputDevices.length}
              </span>
              {isLoading && <RefreshCw className="w-3 h-3 text-[#141414]/20 animate-spin" />}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); refreshDevices(); }}
                className="p-1 text-[#141414]/30 hover:text-[#141414] hover:bg-[#141414]/5 rounded-md transition-colors"
                title="Refresh"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
              {showInputs ? <ChevronUp className="w-4 h-4 text-[#141414]/25" /> : <ChevronDown className="w-4 h-4 text-[#141414]/25" />}
            </div>
          </div>

          <AnimatePresence>
            {showInputs && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="space-y-2">
                  {inputDevices.length === 0 ? (
                    <div className="bg-white rounded-xl border border-[#141414]/8 p-8 text-center">
                      <Mic className="w-8 h-8 text-[#141414]/15 mx-auto mb-2" />
                      <p className="text-[13px] text-[#141414]/30">No input devices found</p>
                    </div>
                  ) : (
                    inputDevices.map((device) => (
                      <DeviceCard
                        key={device.id}
                        device={device}
                        isDefault={defaultInput?.id === device.id}
                        isBusy={busyDeviceId === device.id}
                        onActivate={() => void activateDevice(device)}
                      />
                    ))
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Divider */}
        <div className="border-t border-[#141414]/5 mb-6" />

        {/* Output Devices */}
        <div className="mb-6">
          <button
            onClick={() => setShowOutputs(!showOutputs)}
            className="flex items-center justify-between w-full mb-3 group"
          >
            <div className="flex items-center gap-2.5">
              <Volume2 className="w-4 h-4 text-[#141414]/40" />
              <span className="text-[12px] font-semibold uppercase tracking-wider text-[#141414]/40">
                Output Devices
              </span>
              <span className="text-[11px] text-[#141414]/25 tabular-nums bg-[#141414]/5 px-2 py-0.5 rounded-full font-medium">
                {outputDevices.length}
              </span>
            </div>
            {showOutputs ? <ChevronUp className="w-4 h-4 text-[#141414]/25" /> : <ChevronDown className="w-4 h-4 text-[#141414]/25" />}
          </button>

          <AnimatePresence>
            {showOutputs && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="space-y-2">
                  {outputDevices.length === 0 ? (
                    <div className="bg-white rounded-xl border border-[#141414]/8 p-8 text-center">
                      <Volume2 className="w-8 h-8 text-[#141414]/15 mx-auto mb-2" />
                      <p className="text-[13px] text-[#141414]/30">No output devices found</p>
                    </div>
                  ) : (
                    outputDevices.map((device) => (
                      <DeviceCard
                        key={device.id}
                        device={device}
                        isDefault={defaultOutput?.id === device.id}
                        isBusy={busyDeviceId === device.id}
                        onActivate={() => void activateDevice(device)}
                      />
                    ))
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Info Footer */}
        <div className="bg-[#141414]/[0.03] rounded-xl border border-[#141414]/5 p-4">
          <div className="flex items-start gap-3">
            <Settings2 className="w-4 h-4 text-[#141414]/25 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[12px] font-medium text-[#141414]/50 mb-1">How it works</p>
              <ul className="text-[11px] text-[#141414]/35 space-y-1">
                <li>Devices are auto-detected via macOS CoreAudio property listeners</li>
                <li>
                  Tap any input or output to set it as the system default — same as Sound settings in System
                  Preferences
                </li>
                <li>When you connect Bluetooth headphones or plug in a USB mic, you can switch defaults here</li>
                <li>During active recording, audio capture restarts seamlessly when the default mic changes</li>
                <li>Default-device changes are debounced to handle rapid Bluetooth pairing transitions</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeviceCard({
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
  const canActivate = !isDefault && !isBusy;
  const activateHint =
    device.direction === 'Input' ? 'Set as default microphone' : 'Set as default output';

  return (
    <div
      role={canActivate ? 'button' : undefined}
      tabIndex={canActivate ? 0 : -1}
      onClick={() => canActivate && onActivate()}
      onKeyDown={(e) => {
        if (canActivate && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onActivate();
        }
      }}
      title={isDefault ? 'Current default' : activateHint}
      className={`bg-white rounded-xl border p-4 transition-all ${
        isDefault
          ? 'border-[#141414]/15 shadow-sm'
          : 'border-[#141414]/8 hover:border-[#141414]/12'
      } ${canActivate ? 'cursor-pointer' : ''} ${isBusy ? 'opacity-70 pointer-events-none' : ''}`}
    >
      <div className="flex items-center gap-3.5">
        {/* Icon */}
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
          isDefault
            ? `bg-gradient-to-br ${transportBgColor(device.transport_type)} text-white shadow-sm`
            : 'bg-[#141414]/5 text-[#141414]/35'
        }`}>
          {device.is_headphone ? (
            <Headphones className="w-5 h-5" />
          ) : device.direction === 'Input' ? (
            <Mic className="w-5 h-5" />
          ) : (
            <Volume2 className="w-5 h-5" />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-[14px] font-medium truncate ${isDefault ? 'text-[#141414]' : 'text-[#141414]/60'}`}>
              {device.name}
            </span>
            {isDefault && (
              <span className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded-full border border-green-200">
                <Check className="w-2.5 h-2.5" strokeWidth={3} />
                Default
              </span>
            )}
            {isBusy && (
              <RefreshCw className="w-3.5 h-3.5 text-[#141414]/40 animate-spin flex-shrink-0" />
            )}
          </div>

          <div className="flex items-center gap-2 mt-1.5">
            {/* Transport Badge */}
            <span className={`inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border ${transportColor(device.transport_type)}`}>
              {transportIcon(device.transport_type, 'w-2.5 h-2.5')}
              {transportLabel(device.transport_type)}
            </span>

            {/* Headphone Badge */}
            {device.is_headphone && (
              <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border bg-indigo-50 text-indigo-600 border-indigo-200">
                <Headphones className="w-2.5 h-2.5" />
                Headphone
              </span>
            )}

            {/* Direction Badge */}
            <span className="text-[9px] font-medium text-[#141414]/25 uppercase tracking-wide">
              {device.direction}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
