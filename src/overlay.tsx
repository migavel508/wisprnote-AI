import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import RecordingIndicator from './components/RecordingIndicator';
import MeetingDetectionPrompt from './components/MeetingDetectionPrompt';
import './index.css';

// Dedicated, lightweight entry for the always-on-top overlay windows. It does
// NOT import App.tsx (the full ~5k-line app + every service), so these windows
// spin up instantly and stay cheap — opening them no longer parses/evaluates
// the whole app bundle. The Rust side opens them with `?window=...`.
const overlay = new URLSearchParams(window.location.search).get('window');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {overlay === 'meeting-prompt' ? <MeetingDetectionPrompt /> : <RecordingIndicator />}
  </StrictMode>,
);
