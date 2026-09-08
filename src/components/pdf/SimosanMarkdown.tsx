import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  text: string;
  isRtl: boolean;
  onJumpToPage: (page: number) => void;
}

/**
 * Renders one of Simosan's answers.
 *
 * WHY A LIBRARY, when RichContent.tsx next door is proudly zero-dependency:
 * that renderer walks a block format this app itself produces, so its shape is
 * known and fixed. Gemini emits free-form markdown - nested lists, GFM tables,
 * emphasis inside table cells - and it drifts as prompts change. Hand-rolling
 * that is where custom markdown parsers reliably break, and a mangled dosage
 * table is worse than no table.
 *
 * The repo's real rule survives: react-markdown builds React elements and never
 * touches dangerouslySetInnerHTML, so the app still needs no sanitiser. Raw
 * HTML in the source is escaped rather than parsed, because `rehype-raw` is
 * deliberately not installed.
 *
 * Citations are applied as a post-pass over TEXT NODES rather than over the raw
 * string. Rewriting the markdown before parsing would break `[[p:12]]` inside a
 * table cell or list item - exactly where the persona is most likely to put one.
 */

// Mirrors CITATION_RE in shared/simosanChat.ts: a marker may carry a LIST of
// pages. A live answer produced `[[p:7, 8]]`, which a single-number pattern
// leaves in the text for the student to read raw.
const CITATION = /\[\[p:\s*(\d+(?:\s*,\s*\d+)*)\s*\]\]/g;

/** Split a rendered text node on `[[p:N]]`, turning each into a tappable chip. */
function withCitations(
  node: React.ReactNode,
  isRtl: boolean,
  onJumpToPage: (p: number) => void,
): React.ReactNode {
  if (typeof node === 'string') {
    if (!node.includes('[[p:')) return node;
    const out: React.ReactNode[] = [];
    let last = 0;
    for (const m of node.matchAll(CITATION)) {
      if (m.index! > last) out.push(node.slice(last, m.index));
      for (const part of m[1].split(',')) {
        const page = Number(part.trim());
        if (!page) continue;
        out.push(
          <button
            key={`${m.index}-${page}`}
            onClick={() => onJumpToPage(page)}
            className="mx-1 inline-flex items-center rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[11px] font-black text-violet-600 dark:text-violet-300 align-middle active:scale-95 transition"
          >
            {isRtl ? `ص ${page}` : `p.${page}`}
          </button>,
        );
      }
      last = m.index! + m[0].length;
    }
    if (last < node.length) out.push(node.slice(last));
    return out;
  }
  if (Array.isArray(node)) {
    return node.map((c, i) => <React.Fragment key={i}>{withCitations(c, isRtl, onJumpToPage)}</React.Fragment>);
  }
  return node;
}

export default function SimosanMarkdown({ text, isRtl, onJumpToPage }: Props) {
  const components = useMemo(() => {
    const cite = (children: React.ReactNode) => withCitations(children, isRtl, onJumpToPage);

    return {
      p: ({ children }: any) => (
        <p className="mb-2 last:mb-0 leading-relaxed">{cite(children)}</p>
      ),
      strong: ({ children }: any) => (
        // Bold is how the persona marks the English keywords a grader looks
        // for, so it earns real weight rather than a subtle shade.
        <strong className="font-black text-slate-900 dark:text-white">{cite(children)}</strong>
      ),
      em: ({ children }: any) => <em className="italic">{cite(children)}</em>,

      h1: ({ children }: any) => <h3 className="text-sm font-black mt-3 mb-1.5 first:mt-0">{cite(children)}</h3>,
      h2: ({ children }: any) => <h3 className="text-sm font-black mt-3 mb-1.5 first:mt-0">{cite(children)}</h3>,
      h3: ({ children }: any) => <h4 className="text-[13px] font-black mt-2.5 mb-1 first:mt-0">{cite(children)}</h4>,
      h4: ({ children }: any) => <h4 className="text-[13px] font-black mt-2.5 mb-1 first:mt-0">{cite(children)}</h4>,

      ul: ({ children }: any) => (
        <ul className="mb-2 space-y-1 ps-4 list-disc marker:text-violet-400">{children}</ul>
      ),
      ol: ({ children }: any) => (
        <ol className="mb-2 space-y-1 ps-4 list-decimal marker:text-violet-400 marker:font-black">{children}</ol>
      ),
      li: ({ children }: any) => <li className="leading-relaxed">{cite(children)}</li>,

      // Tables are the reason remark-gfm is here: the persona is told to use
      // them for drug-vs-drug comparisons. They must scroll in their own box -
      // a wide table that widens the drawer would break the layout on a phone.
      table: ({ children }: any) => (
        <div className="my-2 -mx-1 overflow-x-auto">
          <table className="w-full text-[12px] border-collapse">{children}</table>
        </div>
      ),
      thead: ({ children }: any) => (
        <thead className="bg-slate-100 dark:bg-zinc-800">{children}</thead>
      ),
      th: ({ children }: any) => (
        <th className="border border-slate-200 dark:border-zinc-700 px-2 py-1.5 font-black text-start whitespace-nowrap">
          {cite(children)}
        </th>
      ),
      td: ({ children }: any) => (
        <td className="border border-slate-200 dark:border-zinc-700 px-2 py-1.5 align-top text-start">
          {cite(children)}
        </td>
      ),

      code: ({ inline, children }: any) =>
        inline ? (
          <code className="rounded bg-slate-200/70 dark:bg-zinc-700 px-1 py-0.5 text-[11px] font-mono">
            {children}
          </code>
        ) : (
          <code className="block overflow-x-auto rounded-lg bg-slate-100 dark:bg-zinc-800 p-2 text-[11px] font-mono my-2">
            {children}
          </code>
        ),
      pre: ({ children }: any) => <>{children}</>,

      blockquote: ({ children }: any) => (
        <blockquote className="border-s-4 border-violet-300 dark:border-violet-700 ps-3 my-2 text-slate-600 dark:text-slate-300">
          {children}
        </blockquote>
      ),
      hr: () => <hr className="my-3 border-slate-200 dark:border-zinc-700" />,
      a: ({ children, href }: any) => (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-sky-600 dark:text-sky-400 underline">
          {children}
        </a>
      ),
    };
  }, [isRtl, onJumpToPage]);

  // dir="auto" per block, not on the wrapper: an answer mixes Arabic prose with
  // English drug names, and letting the browser resolve direction per element
  // keeps a line starting with "Paracetamol" from flipping the whole paragraph.
  return (
    <div dir="auto" className="simosan-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as any}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
