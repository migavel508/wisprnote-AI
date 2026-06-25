import { useEffect, useState } from 'react';
import { ChevronLeft, House, Lock } from 'lucide-react';
import type { Space } from '../services/workspaceService';
import { getSpaces, getAvatarGradient } from '../services/workspaceService';
import CreateSpaceModal from '../components/CreateSpaceModal';
import { onVaultEvent } from '../lib/vaultEvents';

function SpaceGlyph({ space, size = 30 }: { space: Space; size?: number }) {
  if (space.is_default) {
    return (
      <div className="rounded-lg bg-app-nav-hover-bg flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>
        <Lock size={size * 0.42} strokeWidth={1.8} className="text-app-fg-muted" />
      </div>
    );
  }
  if (space.emoji) {
    return (
      <div className="rounded-lg bg-app-nav-hover-bg flex items-center justify-center flex-shrink-0" style={{ width: size, height: size, fontSize: size * 0.5 }}>
        <span>{space.emoji}</span>
      </div>
    );
  }
  const initial = (space.name.charAt(0) || '?').toUpperCase();
  const [c1, c2, c3] = getAvatarGradient(space.name || 'space');
  return (
    <div
      className="rounded-lg flex items-center justify-center text-white font-semibold flex-shrink-0 overflow-hidden"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${c1} 0%, ${c2} 55%, ${c3} 100%)`, fontSize: size * 0.44 }}
    >
      {initial}
    </div>
  );
}

interface Props {
  onClose: () => void;
  onOpenSpace: (space: Space) => void;
}

const COLS = 'grid grid-cols-[minmax(0,1.8fr)_150px_minmax(0,1fr)_130px] items-center gap-4';

export default function SpacesPage({ onClose, onOpenSpace }: Props) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const load = () => { getSpaces().then(setSpaces).catch(() => {}); };
  useEffect(load, []);
  // Reflect space create/rename/delete + folder changes from anywhere.
  useEffect(() => onVaultEvent('spaces:changed', load), []);

  const memberLabel = (space: Space) => {
    if (space.shared_all) return 'Everyone in workspace';
    const c = space.member_count ?? 0;
    return c <= 0 ? 'Just you' : `${c + 1} members`;
  };

  return (
    <div className="h-full flex flex-col bg-app-panel text-app-fg font-sans">
      {/* Top bar */}
      <div data-tauri-drag-region className="relative flex items-center justify-center h-[46px] flex-shrink-0">
        <button
          onClick={onClose}
          className="absolute left-3 flex items-center gap-1 pl-2 pr-2.5 py-1.5 rounded-full text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"
        >
          <ChevronLeft size={16} strokeWidth={2} />
          <House size={15} strokeWidth={1.8} />
        </button>
        <span className="text-[13px] font-medium text-app-fg-muted">Settings</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1080px] mx-auto px-10 pt-6 pb-20">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <h1 className="text-[34px] font-serif text-app-fg tracking-[-0.02em] leading-tight">Spaces</h1>
              <p className="text-[14px] text-app-fg-subtle mt-1.5 max-w-[680px] leading-relaxed">
                Spaces allow you to organise notes and folders. Any notes that are added to a space can be viewed by anyone in that space.
              </p>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="flex-shrink-0 px-4 py-2.5 rounded-full text-[14px] font-medium bg-app-fg text-app-canvas hover:opacity-90 transition-opacity"
            >
              Create space
            </button>
          </div>

          {/* Table */}
          <div className="mt-9">
            <div className={`${COLS} px-3 pb-2.5 border-b border-app-divider text-[14px] text-app-fg-subtle`}>
              <div>Name</div>
              <div>Folders</div>
              <div>Members</div>
              <div className="text-right">Owner</div>
            </div>

            <div className="px-3 py-2 bg-app-nav-hover-bg/60 text-[14px] text-app-fg-subtle">Default</div>

            {spaces.map(space => (
              <div
                key={space.id}
                onClick={() => onOpenSpace(space)}
                className={`${COLS} px-3 py-3 border-b border-app-divider/60 cursor-pointer hover:bg-app-nav-hover-bg/40 transition-colors`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <SpaceGlyph space={space} size={30} />
                  <span className="text-[16px] text-app-fg truncate">{space.name}</span>
                </div>
                <div className="text-[15px]">
                  {space.folder_count ? space.folder_count : <span className="text-app-fg-subtle">None</span>}
                </div>
                <div className="text-[15px] text-app-fg truncate">{memberLabel(space)}</div>
                <div className="text-right text-app-fg-subtle text-[15px]">—</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showCreate && (
        <CreateSpaceModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}
