import React, { useState, useEffect, useCallback } from 'react';
import { Mic, Monitor, CheckCircle2, ArrowRight, Loader2, ShieldAlert, Users } from 'lucide-react';
import {
  checkPermissions,
  requestMicrophonePermission,
  openScreenRecordingSettings,
  openMicrophoneSettings,
  PermissionStatus,
} from '../services/permissionService';
import {
  isAccessibilityTrusted,
  requestAccessibilityTrust,
  openAccessibilitySettings,
} from '../services/speakerCaptureService';

interface PermissionsGateProps {
  onAllGranted: () => void;
}

export default function PermissionsGate({ onAllGranted }: PermissionsGateProps) {
  const [permissions, setPermissions] = useState<PermissionStatus | null>(null);
  const [requesting, setRequesting] = useState<'mic' | 'screen' | 'ax' | null>(null);
  // Accessibility is OPTIONAL: without it recording works exactly as before, you
  // just don't get participant names. It must never gate the record button.
  const [axTrusted, setAxTrusted] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const ok = await isAccessibilityTrusted();
      if (alive) setAxTrusted(ok);
    };
    void poll();
    // macOS grants take effect without an app restart, so re-check while the
    // user is in System Settings rather than making them relaunch.
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const handleAxAction = async () => {
    setRequesting('ax');
    try {
      const granted = await requestAccessibilityTrust();
      // macOS shows its prompt only once per app; after a prior denial the call
      // returns false silently, so send the user somewhere that can actually help.
      if (!granted) await openAccessibilitySettings();
      setAxTrusted(await isAccessibilityTrusted());
    } finally {
      setRequesting(null);
    }
  };

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

      {/* Optional: participant names. Deliberately OUTSIDE the required row and
          never part of the auto-continue check — a user who declines this still
          gets a full recording, just with "Speaker 1/2" instead of names. */}
      <button
        type="button"
        onClick={handleAxAction}
        disabled={axTrusted === true || requesting === 'ax'}
        className={`w-full max-w-md flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-all border ${
          axTrusted
            ? 'border-green-200 bg-green-50/50 cursor-default'
            : 'border-[#141414]/15 bg-white hover:bg-[#141414]/[0.03] active:scale-[0.99] cursor-pointer'
        } ${requesting === 'ax' ? 'opacity-60 cursor-wait' : ''}`}
      >
        <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
          axTrusted ? 'bg-green-100 text-green-600' : 'bg-[#141414]/5 text-[#141414]/60'
        }`}>
          {axTrusted ? <CheckCircle2 className="w-4 h-4" />
            : requesting === 'ax' ? <Loader2 className="w-4 h-4 animate-spin" />
            : <Users className="w-4 h-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <span className={`text-[13px] font-medium ${axTrusted ? 'text-green-700' : 'text-[#141414]'}`}>
            {axTrusted ? 'Participant names enabled' : 'Allow participant names'}
          </span>
          <p className={`text-[11px] ${axTrusted ? 'text-green-600/70' : 'text-[#141414]/45'}`}>
            {axTrusted
              ? 'Speakers are named from your meeting app'
              : 'Optional — reads names from Zoom, Meet, Teams or Slack'}
          </p>
        </div>
        {!axTrusted && <ArrowRight className="w-4 h-4 text-[#141414]/30 shrink-0" />}
      </button>

      {!screenAuthorized && (
        <p className="text-[11px] text-[#141414]/40 text-center max-w-[340px]">
          System audio requires <span className="font-medium">Screen Recording</span> permission.
          Click to open System Settings, then enable Wisprnote AI.
        </p>
      )}
    </div>
  );
}
