import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useEditor, EditorContent, Extension } from '@tiptap/react';
import { logger } from '../../lib/logger';

const log = logger.scope('SlashEditor');
import StarterKit from '@tiptap/starter-kit';
import { ResizableImage } from './ResizableImage';
import Placeholder from '@tiptap/extension-placeholder';
import Suggestion from '@tiptap/suggestion';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import {
  Type, Heading1, Heading2, Heading3,
  List, ListOrdered, Quote, Code2, Minus, Image as ImageIcon,
  Loader2, CheckSquare, Bold, Italic, UnderlineIcon, Highlighter,
  Link as LinkIcon, Strikethrough, AlignLeft, AlignCenter, AlignRight,
} from 'lucide-react';
import { uploadNoteImage } from '../../services/awsService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function extractImageFiles(dataTransfer: DataTransfer): File[] {
  const files: File[] = [];
  for (let i = 0; i < dataTransfer.items.length; i++) {
    const item = dataTransfer.items[i];
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

// ─── Command definitions ──────────────────────────────────────────────────────

export interface SlashCommandItem {
  title: string;
  description: string;
  icon: React.ReactNode;
  keywords: string[];
  command: (editor: any, range: any) => void;
}

const ALL_COMMANDS: SlashCommandItem[] = [
  {
    title: 'Text',
    description: 'Start with plain paragraph',
    icon: <Type className="w-[15px] h-[15px]" />,
    keywords: ['text', 'paragraph', 'p'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: 'Heading 1',
    description: 'Large section heading',
    icon: <Heading1 className="w-[15px] h-[15px]" />,
    keywords: ['h1', 'heading', 'title', 'large'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    description: 'Medium section heading',
    icon: <Heading2 className="w-[15px] h-[15px]" />,
    keywords: ['h2', 'heading', 'subtitle', 'medium'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    description: 'Small section heading',
    icon: <Heading3 className="w-[15px] h-[15px]" />,
    keywords: ['h3', 'heading', 'small'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(),
  },
  {
    title: 'Task List',
    description: 'Checklist with checkboxes',
    icon: <CheckSquare className="w-[15px] h-[15px]" />,
    keywords: ['task', 'todo', 'checkbox', 'checklist'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: 'Bullet List',
    description: 'Unordered list of items',
    icon: <List className="w-[15px] h-[15px]" />,
    keywords: ['bullet', 'list', 'ul', 'unordered'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: 'Numbered List',
    description: 'Ordered numbered list',
    icon: <ListOrdered className="w-[15px] h-[15px]" />,
    keywords: ['numbered', 'list', 'ol', 'ordered'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: 'Quote',
    description: 'Capture a blockquote',
    icon: <Quote className="w-[15px] h-[15px]" />,
    keywords: ['quote', 'blockquote', 'callout'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).setBlockquote().run(),
  },
  {
    title: 'Code',
    description: 'Monospace code block',
    icon: <Code2 className="w-[15px] h-[15px]" />,
    keywords: ['code', 'snippet', 'pre', 'codeblock'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).setCodeBlock().run(),
  },
  {
    title: 'Divider',
    description: 'Visual horizontal rule',
    icon: <Minus className="w-[15px] h-[15px]" />,
    keywords: ['divider', 'hr', 'rule', 'separator', 'line'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    title: 'Bold',
    description: 'Make text bold',
    icon: <Bold className="w-[15px] h-[15px]" />,
    keywords: ['bold', 'strong', 'b'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).toggleBold().run(),
  },
  {
    title: 'Italic',
    description: 'Make text italic',
    icon: <Italic className="w-[15px] h-[15px]" />,
    keywords: ['italic', 'emphasis', 'em', 'i'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).toggleItalic().run(),
  },
  {
    title: 'Underline',
    description: 'Underline text',
    icon: <UnderlineIcon className="w-[15px] h-[15px]" />,
    keywords: ['underline', 'u'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).toggleUnderline().run(),
  },
  {
    title: 'Strikethrough',
    description: 'Strikethrough text',
    icon: <Strikethrough className="w-[15px] h-[15px]" />,
    keywords: ['strikethrough', 'strike', 'del', 's'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).toggleStrike().run(),
  },
  {
    title: 'Highlight',
    description: 'Highlight text with color',
    icon: <Highlighter className="w-[15px] h-[15px]" />,
    keywords: ['highlight', 'mark', 'color', 'bg'],
    command: (editor, range) => editor.chain().focus().deleteRange(range).toggleHighlight().run(),
  },
  {
    title: 'Image',
    description: 'Upload an image file',
    icon: <ImageIcon className="w-[15px] h-[15px]" />,
    keywords: ['image', 'photo', 'picture', 'img', 'upload'],
    command: (_editor, _range) => {
      document.getElementById('slash-img-input')?.click();
    },
  },
];

// ─── Slash menu popup ─────────────────────────────────────────────────────────

interface SlashMenuState {
  items: SlashCommandItem[];
  selectedIndex: number;
  rect: DOMRect | null;
  onSelect: (item: SlashCommandItem) => void;
}

function SlashMenu({ state }: { state: SlashMenuState | null }) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-sel="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [state?.selectedIndex]);

  if (!state || !state.rect || state.items.length === 0) return null;

  const r = state.rect;
  const top = Math.min(r.bottom + 6, window.innerHeight - 330);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 280));

  return (
    <div
      className="fixed z-[9999] w-[268px] bg-app-panel rounded-xl border border-zinc-200 dark:border-zinc-600 shadow-[0_8px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.45)] overflow-hidden text-app-fg"
      style={{ top, left }}
    >
      <div className="px-3 pt-2.5 pb-1">
        <span className="text-[10px] font-semibold tracking-widest uppercase text-[#b0b0b0]">Commands</span>
      </div>
      <div ref={listRef} className="max-h-[280px] overflow-y-auto pb-1.5">
        {state.items.map((item, i) => (
          <button
            key={item.title}
            data-sel={i === state.selectedIndex ? 'true' : 'false'}
            onMouseDown={(e) => { e.preventDefault(); state.onSelect(item); }}
            className={`w-full flex items-center gap-3 px-2.5 py-1.5 text-left transition-colors ${
              i === state.selectedIndex
                ? 'bg-[#f0f0ee] text-[#1a1a1a]'
                : 'text-[#3a3a3a] hover:bg-[#f8f8f7]'
            }`}
          >
            <div className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 border transition-colors ${
              i === state.selectedIndex
                ? 'bg-zinc-50 dark:bg-app-chip border-zinc-200 dark:border-app-border text-app-fg'
                : 'bg-[#f4f4f3] border-transparent text-[#595959]'
            }`}>
              {item.icon}
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium leading-snug">{item.title}</p>
              <p className="text-[11px] text-[#a0a0a0] leading-snug truncate">{item.description}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Shared editor CSS injected once ─────────────────────────────────────────

const EDITOR_CSS = `
  .notion-editor .ProseMirror { font-size: 15px; line-height: 1.8; color: #1a1a1a; }
  .notion-editor .ProseMirror p.is-editor-empty:first-child::before {
    content: attr(data-placeholder); float: left; color: #c8c8c8;
    pointer-events: none; height: 0;
  }
  .notion-editor .ProseMirror:focus { outline: none; }
  .notion-editor .ProseMirror > * + * { margin-top: 0.35em; }
  .notion-editor .ProseMirror h1 { font-size: 1.875rem; font-weight: 700; margin-top: 1.5rem; margin-bottom: 0.25rem; line-height: 1.25; }
  .notion-editor .ProseMirror h2 { font-size: 1.375rem; font-weight: 650; margin-top: 1.25rem; margin-bottom: 0.2rem; }
  .notion-editor .ProseMirror h3 { font-size: 1.125rem; font-weight: 600; margin-top: 1rem; margin-bottom: 0.15rem; }
  .notion-editor .ProseMirror blockquote {
    border-left: 3px solid #d6d6d4; padding-left: 1rem;
    color: #595959; margin: 0.75rem 0; font-style: italic;
  }
  .notion-editor .ProseMirror code {
    background: #f4f4f3; padding: 0.15em 0.35em; border-radius: 4px;
    font-size: 0.875em; font-family: 'JetBrains Mono', 'Fira Code', monospace;
  }
  .notion-editor .ProseMirror pre {
    background: #1a1a1a; color: #e4e3e0; padding: 1rem 1.25rem;
    border-radius: 8px; overflow-x: auto; margin: 0.75rem 0;
  }
  .notion-editor .ProseMirror pre code { background: transparent; color: inherit; padding: 0; }
  .notion-editor .ProseMirror hr { border: none; border-top: 1px solid #e5e5e5; margin: 1.5rem 0; }
  .notion-editor .ProseMirror ul { list-style: disc; padding-left: 1.5rem; margin: 0.35rem 0; }
  .notion-editor .ProseMirror ol { list-style: decimal; padding-left: 1.5rem; margin: 0.35rem 0; }
  .notion-editor .ProseMirror li { margin: 0.15rem 0; }
  .notion-editor .ProseMirror img { border-radius: 8px; max-width: 100%; display: block; }
  .notion-editor .ProseMirror .ProseMirror-selectednode { outline: none; }
  .notion-editor .ProseMirror a { color: #2563eb; text-decoration: underline; text-underline-offset: 3px; }
  .notion-editor .ProseMirror::after { content: ''; display: table; clear: both; }
  .notion-editor .ProseMirror p { min-height: 1.5em; }
`;

// ─── Public component ─────────────────────────────────────────────────────────

export interface SlashEditorProps {
  content: string;
  placeholder?: string;
  autoFocus?: boolean;
  onUpdate?: (html: string) => void;
  className?: string;
  enableImageUpload?: boolean;
}

export function SlashEditor({
  content,
  placeholder = "Type '/' for commands…",
  autoFocus = false,
  onUpdate,
  className = '',
  enableImageUpload = false,
}: SlashEditorProps) {
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);

  // Refs for bridging the TipTap plugin ↔ React state
  const suggestionRef = useRef<any>(null);
  const selectedIdxRef = useRef(0);
  const itemsRef = useRef<SlashCommandItem[]>([]);

  // Stable callbacks object — updated every render, read from within the plugin
  const cb = useRef({
    onStart: (_p: any) => {},
    onUpdate: (_p: any) => {},
    onExit: () => {},
    up: () => {},
    down: () => {},
    enter: () => {},
  });

  const makeOnSelect = () => (item: SlashCommandItem) => {
    suggestionRef.current?.command(item);
    setSlashMenu(null);
  };

  cb.current = {
    onStart: (p: any) => {
      suggestionRef.current = p;
      selectedIdxRef.current = 0;
      itemsRef.current = p.items;
      setSlashMenu({ items: p.items, selectedIndex: 0, rect: p.clientRect?.() ?? null, onSelect: makeOnSelect() });
    },
    onUpdate: (p: any) => {
      suggestionRef.current = p;
      itemsRef.current = p.items;
      setSlashMenu(prev =>
        prev ? { ...prev, items: p.items, rect: p.clientRect?.() ?? null, onSelect: makeOnSelect() } : null
      );
    },
    onExit: () => { setSlashMenu(null); suggestionRef.current = null; },
    up: () => {
      const idx = Math.max(0, selectedIdxRef.current - 1);
      selectedIdxRef.current = idx;
      setSlashMenu(prev => prev ? { ...prev, selectedIndex: idx } : null);
    },
    down: () => {
      const idx = Math.min(itemsRef.current.length - 1, selectedIdxRef.current + 1);
      selectedIdxRef.current = idx;
      setSlashMenu(prev => prev ? { ...prev, selectedIndex: idx } : null);
    },
    enter: () => {
      const item = itemsRef.current[selectedIdxRef.current];
      if (item && suggestionRef.current) suggestionRef.current.command(item);
      setSlashMenu(null);
    },
  };

  // Extension created once; reads cb.current dynamically at call time
  const [slashExt] = useState(() =>
    Extension.create({
      name: 'slashCommands',
      addProseMirrorPlugins() {
        return [
          Suggestion({
            editor: this.editor,
            char: '/',
            allowSpaces: false,
            allowedPrefixes: null,
            items: ({ query }: { query: string }) => {
              const q = query.toLowerCase();
              return ALL_COMMANDS.filter(
                c => c.title.toLowerCase().includes(q) || c.keywords.some(k => k.includes(q))
              );
            },
            render: () => ({
              onStart:   (p: any) => cb.current.onStart(p),
              onUpdate:  (p: any) => cb.current.onUpdate(p),
              onExit:    ()       => cb.current.onExit(),
              onKeyDown: ({ event }: { event: KeyboardEvent }) => {
                if (event.key === 'ArrowUp')   { cb.current.up();    return true; }
                if (event.key === 'ArrowDown') { cb.current.down();  return true; }
                if (event.key === 'Enter')     { cb.current.enter(); return true; }
                if (event.key === 'Escape')    { cb.current.onExit(); return true; }
                return false;
              },
            }),
            command: ({ editor, range, props: item }: any) => {
              item.command(editor, range);
            },
          }),
        ];
      },
    })
  );

  // Ref-based image handler so paste/drop closures always see the latest editor
  const imageHandlerRef = useRef<(file: File) => void>(() => {});

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: false,
        underline: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { class: 'editor-link' },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Underline,
      Highlight.configure({ multicolor: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      ResizableImage.configure({ inline: false, allowBase64: true }),
      Placeholder.configure({ placeholder, emptyEditorClass: 'is-editor-empty' }),
      slashExt,
    ],
    content,
    autofocus: autoFocus,
    onUpdate: ({ editor: e }) => onUpdate?.(e.getHTML()),
    editorProps: {
      attributes: { class: 'focus:outline-none' },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          return false;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        if (!enableImageUpload) return false;
        const clipboardData = event.clipboardData;
        if (!clipboardData) return false;
        const imageFiles = extractImageFiles(clipboardData);
        if (imageFiles.length === 0) return false;
        event.preventDefault();
        for (const file of imageFiles) {
          imageHandlerRef.current(file);
        }
        return true;
      },
      handleDrop: (_view, event) => {
        if (!enableImageUpload) return false;
        const dataTransfer = event.dataTransfer;
        if (!dataTransfer) return false;
        const imageFiles = extractImageFiles(dataTransfer);
        if (imageFiles.length === 0) return false;
        event.preventDefault();
        for (const file of imageFiles) {
          imageHandlerRef.current(file);
        }
        return true;
      },
    },
  });

  // Image handler: base64-first strategy.
  // 1. Convert to base64 immediately → insert into editor (always valid, always persists in saved HTML)
  // 2. Try Supabase upload in background → if successful, swap base64 for the permanent URL
  // This eliminates the race condition where auto-save captures a dead blob URL.
  useEffect(() => {
    imageHandlerRef.current = async (file: File) => {
      if (!editor) return;

      // Step 1: Convert to base64 first — this is the durable source that will survive saves/reloads
      let base64Src: string;
      try {
        base64Src = await fileToBase64(file);
      } catch (err) {
        log.error('image_base64_conversion_failed', { error: err instanceof Error ? err : undefined });
        return;
      }

      editor.chain().focus().setImage({ src: base64Src }).run();
      log.info('image_inserted_as_base64', { size: file.size, type: file.type });

      // Step 2: Try uploading to Supabase Storage in the background for a lighter permanent URL
      try {
        const permanentUrl = await uploadNoteImage(file);
        // Replace base64 with the permanent URL (smaller HTML, CDN-served)
        const { doc } = editor.state;
        let replaced = false;
        doc.descendants((node, pos) => {
          if (replaced) return false;
          if (node.type.name === 'resizableImage' && node.attrs.src === base64Src) {
            editor.chain().focus()
              .command(({ tr }) => {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: permanentUrl });
                return true;
              })
              .run();
            replaced = true;
            return false;
          }
        });
        if (replaced) {
          log.info('image_upgraded_to_permanent_url', { url: permanentUrl.substring(0, 80) });
        }
      } catch {
        // Upload failed — base64 is already in the document, image works fine
        log.info('image_keeping_base64', { reason: 'supabase_upload_failed' });
      }
    };
  }, [editor]);

  const handleImageFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    imageHandlerRef.current(file);
  }, []);

  if (!editor) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-5 h-5 animate-spin text-[#c0c0c0]" />
      </div>
    );
  }

  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('URL', previousUrl);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  return (
    <div className={`notion-editor relative ${className}`}>
      <style dangerouslySetInnerHTML={{ __html: EDITOR_CSS }} />

      {enableImageUpload && (
        <input id="slash-img-input" type="file" accept="image/*" className="hidden" onChange={handleImageFile} />
      )}

      {/* Selection toolbar — custom impl since BubbleMenu JSX isn't in TipTap v3 */}
      <SelectionToolbar editor={editor} onSetLink={setLink} />

      <EditorContent editor={editor} />
      <SlashMenu state={slashMenu} />
    </div>
  );
}

function SelectionToolbar({ editor, onSetLink }: { editor: any; onSetLink: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const onSelectionUpdate = () => {
      const { from, to, empty } = editor.state.selection;
      if (empty || from === to) {
        setRect(null);
        return;
      }
      const domRange = editor.view.domAtPos(from);
      const range = document.createRange();
      range.setStart(domRange.node, domRange.offset);
      const endDom = editor.view.domAtPos(to);
      range.setEnd(endDom.node, endDom.offset);
      setRect(range.getBoundingClientRect());
      forceUpdate(n => n + 1);
    };
    editor.on('selectionUpdate', onSelectionUpdate);
    editor.on('blur', () => setRect(null));
    return () => {
      editor.off('selectionUpdate', onSelectionUpdate);
    };
  }, [editor]);

  if (!rect || !editor) return null;

  const top = rect.top - 44 + window.scrollY;
  const left = rect.left + rect.width / 2;

  return (
    <div
      className="fixed z-[9999] flex items-center gap-0.5 bg-[#1a1a1a] rounded-lg px-1 py-0.5 shadow-xl"
      style={{ top: Math.max(4, rect.top - 44), left: Math.max(8, left - 120), transform: 'translateX(0)' }}
    >
      <FmtBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="w-3.5 h-3.5" />
      </FmtBtn>
      <FmtBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="w-3.5 h-3.5" />
      </FmtBtn>
      <FmtBtn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <UnderlineIcon className="w-3.5 h-3.5" />
      </FmtBtn>
      <FmtBtn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough className="w-3.5 h-3.5" />
      </FmtBtn>
      <FmtBtn active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()}>
        <Highlighter className="w-3.5 h-3.5" />
      </FmtBtn>
      <FmtBtn active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code2 className="w-3.5 h-3.5" />
      </FmtBtn>
      <div className="w-px h-4 bg-white/20 mx-0.5" />
      <FmtBtn active={editor.isActive('link')} onClick={onSetLink}>
        <LinkIcon className="w-3.5 h-3.5" />
      </FmtBtn>
    </div>
  );
}

function FmtBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className={`p-1.5 rounded-md transition-colors ${
        active ? 'bg-white/20 text-white' : 'text-white/60 hover:text-white hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}
