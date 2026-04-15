import React, { useState, useEffect, useCallback } from 'react';
import { Mic, Monitor, CheckCircle2, ArrowRight, Loader2, ShieldAlert } from 'lucide-react';
import {
  checkPermissions,
  requestMicrophonePermission,
  openScreenRecordingSettings,
  openMicrophoneSettings,
  PermissionStatus,
} from '../services/permissionService';

interface PermissionsGateProps {
  onAllGranted: () => void;
}

export default function PermissionsGate({ onAllGranted }: PermissionsGateProps) {
  const [permissions, setPermissions] = useState<PermissionStatus | null>(null);
  const [requesting, setRequesting] = useState<'mic' | 'screen' | null>(null);

  const refresh = useCallback(async () => {
    const status = await checkPermissions();
    setPermissions(status);
    return status;
  }, []);

  // Poll permissions every second to detect changes from System Settings
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Auto-continue when both permissions are granted
  useEffect(() => {
    if (
      permissions &&
      permissions.microphone === 'authorized' &&
      permissions.screen_recording === 'authorized'
    ) {
      onAllGranted();
    }
  }, [permissions, onAllGranted]);

  const handleMicAction = async () => {
    if (!permissions) return;

    if (permissions.microphone === 'denied') {
      await openMicrophoneSettings();
      return;
    }

    // not_determined → trigger system dialog
    setRequesting('mic');
    try {
      await requestMicrophonePermission();
    } finally {
      setRequesting(null);
      refresh();
    }
  };

  const handleScreenAction = async () => {
    setRequesting('screen');
    try {
      await openScreenRecordingSettings();
    } finally {
      // Keep polling — user needs to toggle in System Settings
      setTimeout(() => setRequesting(null), 1500);
    }
  };

  if (!permissions) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-10">
        <Loader2 className="w-6 h-6 text-[#141414]/40 animate-spin" />
        <p className="text-[13px] text-[#141414]/40">Checking permissions…</p>
      </div>
    );
  }

  const micAuthorized = permissions.microphone === 'authorized';
  const screenAuthorized = permissions.screen_recording === 'authorized';

  return (
    <div className="flex flex-col items-center gap-6 py-4">
      <div className="w-16 h-16 rounded-full bg-amber-50 flex items-center justify-center">
        <ShieldAlert className="w-8 h-8 text-amber-500" />
      </div>

      <div className="text-center">
        <p className="text-[16px] font-semibold text-[#141414] mb-1">Permissions Required</p>
        <p className="text-[13px] text-[#141414]/50 max-w-[320px]">
          Wisprnote AI needs access to your microphone and system audio to record meetings.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch gap-3 w-full max-w-md">
        {/* Microphone Permission */}
        <button
          type="button"
          onClick={handleMicAction}
          disabled={micAuthorized || requesting === 'mic'}
          className={`group flex-1 flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-all ${
            micAuthorized
              ? 'border border-green-200 bg-green-50/50 cursor-default'
              : 'border border-[#141414] bg-[#141414] text-white shadow-md hover:bg-[#333] active:scale-[0.98] cursor-pointer'
          } ${requesting === 'mic' ? 'opacity-60 cursor-wait' : ''}`}
        >
          <div
            className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
              micAuthorized ? 'bg-green-100 text-green-600' : 'bg-white/10 text-white'
            }`}
          >
            {micAuthorized ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : requesting === 'mic' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Mic className="w-4 h-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <span className={`text-[13px] font-medium ${micAuthorized ? 'text-green-700' : 'text-white'}`}>
              {micAuthorized ? 'Microphone enabled' : 'Allow microphone'}
            </span>
            <p className={`text-[11px] ${micAuthorized ? 'text-green-600/70' : 'text-white/60'}`}>
              {micAuthorized ? 'Access granted' : 'Record your voice'}
            </p>
          </div>
          {!micAuthorized && (
            <ArrowRight className="w-4 h-4 text-white/60 shrink-0 group-hover:translate-x-0.5 transition-transform" />
          )}
        </button>

        {/* Screen Recording (System Audio) Permission */}
        <button
          type="button"
          onClick={handleScreenAction}
          disabled={screenAuthorized || requesting === 'screen'}
          className={`group flex-1 flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-all ${
            screenAuthorized
              ? 'border border-green-200 bg-green-50/50 cursor-default'
              : 'border border-[#141414] bg-[#141414] text-white shadow-md hover:bg-[#333] active:scale-[0.98] cursor-pointer'
          } ${requesting === 'screen' ? 'opacity-60 cursor-wait' : ''}`}
        >
          <div
            className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
              screenAuthorized ? 'bg-green-100 text-green-600' : 'bg-white/10 text-white'
            }`}
          >
            {screenAuthorized ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : requesting === 'screen' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Monitor className="w-4 h-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <span className={`text-[13px] font-medium ${screenAuthorized ? 'text-green-700' : 'text-white'}`}>
              {screenAuthorized ? 'System audio enabled' : 'Allow system audio'}
            </span>
            <p className={`text-[11px] ${screenAuthorized ? 'text-green-600/70' : 'text-white/60'}`}>
              {screenAuthorized ? 'Access granted' : 'Capture meeting audio'}
            </p>
          </div>
          {!screenAuthorized && (
            <ArrowRight className="w-4 h-4 text-white/60 shrink-0 group-hover:translate-x-0.5 transition-transform" />
          )}
        </button>
      </div>

      {!screenAuthorized && (
        <p className="text-[11px] text-[#141414]/40 text-center max-w-[340px]">
          System audio requires <span className="font-medium">Screen Recording</span> permission.
          Click to open System Settings, then enable Wisprnote AI.
        </p>
      )}
    </div>
  );
}
