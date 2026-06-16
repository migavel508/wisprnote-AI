import React from 'react';

/**
 * Markdown renderers for AI assistant messages — shared by the global AI Chat
 * (ChatPage) and the workspace-scoped chat (WorkspaceChat) so both render
 * assistant answers identically. Pass as the `components` prop to <Markdown>.
 */
export const assistantMarkdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mt-4 mb-2 text-[16px] font-semibold text-zinc-900 dark:text-zinc-100 first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mt-3 mb-1.5 text-[14px] font-semibold text-zinc-900 dark:text-zinc-100 first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-2.5 mb-1 text-[13px] font-semibold text-zinc-800 dark:text-zinc-200 first:mt-0">{children}</h3>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-2 list-disc pl-5 space-y-0.5">{children}</ul>
  ),
  ol: ({ children, start }: { children?: React.ReactNode; start?: number }) => (
    <ol start={start} className="my-2 list-decimal pl-5 space-y-0.5">{children}</ol>
  ),
  li: ({ children, value }: { children?: React.ReactNode; value?: number }) => (
    <li value={value} className="text-[13px] leading-[1.7] text-zinc-700 dark:text-zinc-300">{children}</li>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-2 last:mb-0 text-[13px] leading-[1.75] text-zinc-700 dark:text-zinc-300">{children}</p>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-zinc-900 dark:text-zinc-100">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="italic text-zinc-600 dark:text-zinc-400">{children}</em>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2 border-l-2 border-zinc-300 dark:border-zinc-600 pl-3 text-zinc-500 dark:text-zinc-400 text-[13px]">{children}</blockquote>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.includes('language-');
    return isBlock
      ? <pre className="my-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3 overflow-x-auto"><code className="text-[12px] text-zinc-800 dark:text-zinc-200">{children}</code></pre>
      : <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 text-[12px] text-zinc-800 dark:text-zinc-200">{children}</code>;
  },
  hr: () => <hr className="my-3 border-zinc-200 dark:border-zinc-700" />,
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a
      href={href}
      // Open in the system browser. Inside Tauri the shell opener handles external
      // URLs; falling back to a normal new tab on web.
      onClick={(e) => {
        if (!href) return;
        const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
        if (isTauri) {
          e.preventDefault();
          import('@tauri-apps/plugin-shell').then(({ open }) => open(href)).catch(() => { window.open(href, '_blank'); });
        }
      }}
      target="_blank"
      rel="noreferrer noopener"
      className="text-app-accent font-medium hover:underline underline-offset-2 break-words"
    >
      {children}
    </a>
  ),
};
