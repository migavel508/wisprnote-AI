import React, { useRef, useCallback, useState } from 'react';
import Image from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { GripVertical, AlignCenter, Maximize2 } from 'lucide-react';

// ─── Inline SVG icons for float-left / float-right ───────────────────────────

const FloatLeftIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.85"/>
    <rect x="9" y="2" width="6" height="1.5" rx="0.75" fill="currentColor" opacity="0.5"/>
    <rect x="9" y="5" width="4" height="1.5" rx="0.75" fill="currentColor" opacity="0.5"/>
    <rect x="1" y="9" width="14" height="1.5" rx="0.75" fill="currentColor" opacity="0.5"/>
    <rect x="1" y="12" width="10" height="1.5" rx="0.75" fill="currentColor" opacity="0.5"/>
  </svg>
);

const FloatRightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.85"/>
    <rect x="1" y="2" width="6" height="1.5" rx="0.75" fill="currentColor" opacity="0.5"/>
    <rect x="1" y="5" width="4" height="1.5" rx="0.75" fill="currentColor" opacity="0.5"/>
    <rect x="1" y="9" width="14" height="1.5" rx="0.75" fill="currentColor" opacity="0.5"/>
    <rect x="1" y="12" width="10" height="1.5" rx="0.75" fill="currentColor" opacity="0.5"/>
  </svg>
);

// ─── ResizableImageNodeView ────────────────────────────────────────────────────

interface NodeViewProps {
  node: any;
  updateAttributes: (attrs: Record<string, any>) => void;
  selected: boolean;
  editor: any;
}

type Align = 'float-left' | 'float-right' | 'center' | 'block';

function ResizableImageNodeView({ node, updateAttributes, selected }: NodeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  const { src, alt, title, width, align = 'block' } = node.attrs as {
    src: string; alt?: string; title?: string; width?: number; align: Align;
  };
  const showUI = selected || isHovered;
  const isFloating = align === 'float-left' || align === 'float-right';

  // ── Compute NodeViewWrapper style based on alignment ──────────────────────
  // For float-left/right the wrapper itself must be floated so surrounding
  // ProseMirror paragraphs flow beside it.
  const wrapperStyle: React.CSSProperties = (() => {
    const w = width ? `${width}px` : isFloating ? '42%' : '100%';
    switch (align) {
      case 'float-left':
        return { float: 'left', width: w, maxWidth: '65%', margin: '4px 16px 8px 0', position: 'relative', lineHeight: 0 };
      case 'float-right':
        return { float: 'right', width: w, maxWidth: '65%', margin: '4px 0 8px 16px', position: 'relative', lineHeight: 0 };
      case 'center':
        return { display: 'block', width: w, maxWidth: '100%', margin: '12px auto', position: 'relative', lineHeight: 0 };
      default: // 'block'
        return { display: 'block', width: w, maxWidth: '100%', margin: '12px 0', position: 'relative', lineHeight: 0 };
    }
  })();

  // ── Resize: drag right edge or corner ─────────────────────────────────────
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = containerRef.current?.offsetWidth ?? (width ?? 400);

    const onMove = (ev: MouseEvent) => {
      const delta = align === 'float-right' ? startX - ev.clientX : ev.clientX - startX;
      updateAttributes({ width: Math.max(80, Math.round(startW + delta)) });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [width, align, updateAttributes]);

  const setAlign = (a: Align) => {
    // When switching to float, set a sensible default width if none set
    if ((a === 'float-left' || a === 'float-right') && !width) {
      updateAttributes({ align: a, width: 280 });
    } else {
      updateAttributes({ align: a });
    }
  };

  return (
    // NodeViewWrapper renders as a <div>; setting its style to float directly
    // is the only way to make surrounding ProseMirror paragraphs wrap beside it.
    <NodeViewWrapper style={wrapperStyle}>
      <div
        ref={containerRef}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={{ position: 'relative', width: '100%', lineHeight: 0 }}
      >
        {/* ── Drag handle (top-left grip) ── */}
        <div
          data-drag-handle
          contentEditable={false}
          style={{
            position: 'absolute', top: 6, left: 6,
            display: showUI ? 'flex' : 'none',
            alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24,
            background: 'rgba(255,255,255,0.92)',
            borderRadius: 6, boxShadow: '0 1px 6px rgba(0,0,0,0.2)',
            cursor: 'grab', zIndex: 10,
          }}
        >
          <GripVertical style={{ width: 14, height: 14, color: '#555' }} />
        </div>

        {/* ── Floating toolbar ── */}
        {selected && (
          <div
            contentEditable={false}
            style={{
              position: 'absolute', top: -44, left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', gap: 1,
              background: 'white', border: '1px solid #e5e5e5',
              borderRadius: 10, padding: '4px 6px',
              boxShadow: '0 4px 20px rgba(0,0,0,0.13)',
              zIndex: 100, whiteSpace: 'nowrap',
            }}
          >
            <ToolbarBtn active={align === 'float-left'} title="Float left — text wraps right"
              onClick={() => setAlign('float-left')}>
              <FloatLeftIcon />
            </ToolbarBtn>
            <ToolbarBtn active={align === 'float-right'} title="Float right — text wraps left"
              onClick={() => setAlign('float-right')}>
              <FloatRightIcon />
            </ToolbarBtn>
            <div style={{ width: 1, height: 20, background: '#e5e5e5', margin: '0 2px' }} />
            <ToolbarBtn active={align === 'center'} title="Center (no text wrap)"
              onClick={() => setAlign('center')}>
              <AlignCenter style={{ width: 14, height: 14 }} />
            </ToolbarBtn>
            <ToolbarBtn active={align === 'block' || !align} title="Full width block"
              onClick={() => { updateAttributes({ align: 'block', width: null }); }}>
              <Maximize2 style={{ width: 14, height: 14 }} />
            </ToolbarBtn>
          </div>
        )}

        {/* ── Image ── */}
        <img
          src={src}
          alt={alt ?? ''}
          title={title ?? ''}
          draggable={false}
          style={{
            display: 'block', width: '100%', height: 'auto',
            borderRadius: 8,
            outline: showUI ? '2px solid #2563eb' : '2px solid transparent',
            outlineOffset: 2,
            transition: 'outline 0.1s ease',
            userSelect: 'none',
          }}
        />

        {/* ── Right-edge resize handle ── */}
        {showUI && (
          <div
            onMouseDown={startResize}
            contentEditable={false}
            title="Drag to resize"
            style={{
              position: 'absolute', right: -5, top: '50%',
              transform: 'translateY(-50%)',
              width: 10, height: 36,
              background: '#2563eb', borderRadius: 5,
              cursor: 'ew-resize', border: '2px solid white',
              boxShadow: '0 2px 6px rgba(37,99,235,0.4)',
              zIndex: 10,
            }}
          />
        )}

        {/* ── Corner resize handle ── */}
        {showUI && (
          <div
            onMouseDown={startResize}
            contentEditable={false}
            title="Drag to resize"
            style={{
              position: 'absolute', right: -5, bottom: -5,
              width: 12, height: 12,
              background: '#2563eb', borderRadius: 3,
              cursor: 'se-resize', border: '2px solid white',
              boxShadow: '0 2px 6px rgba(37,99,235,0.4)',
              zIndex: 10,
            }}
          />
        )}
      </div>
    </NodeViewWrapper>
  );
}

function ToolbarBtn({ active, title, onClick, children }: {
  active: boolean; title: string; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 30, height: 28, borderRadius: 6, border: 'none',
        cursor: 'pointer',
        background: active ? '#eff6ff' : 'transparent',
        color: active ? '#2563eb' : '#555',
        transition: 'background 0.1s',
      }}
    >
      {children}
    </button>
  );
}

// ─── TipTap extension ─────────────────────────────────────────────────────────

export const ResizableImage = Image.extend({
  draggable: true,

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: el => el.getAttribute('data-width') ? Number(el.getAttribute('data-width')) : null,
        renderHTML: attrs => attrs.width ? { 'data-width': attrs.width } : {},
      },
      align: {
        default: 'block',
        parseHTML: el => (el.getAttribute('data-align') as Align) ?? 'block',
        renderHTML: attrs => ({ 'data-align': attrs.align ?? 'block' }),
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageNodeView);
  },
});
