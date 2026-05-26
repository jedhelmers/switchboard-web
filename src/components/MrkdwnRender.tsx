// MrkdwnRender — render the SwitchBoard mrkdwn dialect (m.text) as a
// React tree. Used as the fallback when a message arrives WITHOUT a
// TipTap payload (e.g. from native iOS, CLI, bots, third-party clients).
//
// Web users compose via the TipTap RichEditor which writes m.payload —
// that path still goes through MessageRender. This component only kicks
// in for the text-only branch.

import { Fragment, type ReactNode } from 'react'
import { parse, type MrkdwnNode } from '@switchboard/client/mrkdwn'

// Same selector set as RichEditor uses for the TipTap output, minus the
// editor-only bits, so mrkdwn and TipTap messages look identical.
const renderClasses = [
  'text-sm text-zinc-100 break-words',
  '[&_p]:my-1',
  '[&_strong]:font-semibold',
  '[&_em]:italic',
  '[&_s]:line-through',
  '[&_a]:text-sky-400 [&_a]:underline [&_a:hover]:text-sky-300',
  '[&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-1',
  '[&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-1',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-zinc-600 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-300',
  '[&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em] [&_code]:font-mono [&_code]:text-orange-400',
  '[&_pre]:my-1.5 [&_pre]:rounded [&_pre]:bg-zinc-950 [&_pre]:border [&_pre]:border-zinc-800 [&_pre]:p-3 [&_pre]:overflow-x-auto',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-sm [&_pre_code]:font-mono [&_pre_code]:text-white/70',
].join(' ')

// Allowlist of URL schemes. The spec lets users put arbitrary text
// between `<` and `>`, so we have to keep `javascript:` and friends out.
function safeURL(url: string): string | null {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^mailto:/i.test(trimmed)) return trimmed
  return null
}

export function MrkdwnRender({ text }: { text: string }): ReactNode {
  if (!text) return null
  const blocks = parse(text)
  return <div className={renderClasses}>{blocks.map(renderNode)}</div>
}

function renderNode(node: MrkdwnNode, idx: number): ReactNode {
  switch (node.type) {
    case 'text':
      return <Fragment key={idx}>{node.value}</Fragment>
    case 'emphasis': {
      const inner = node.children.map(renderNode)
      if (node.style === 'bold') return <strong key={idx}>{inner}</strong>
      if (node.style === 'italic') return <em key={idx}>{inner}</em>
      return <s key={idx}>{inner}</s>
    }
    case 'code_inline':
      return <code key={idx}>{node.value}</code>
    case 'code_block':
      return (
        <pre key={idx}>
          <code>{node.value}</code>
        </pre>
      )
    case 'link': {
      const href = safeURL(node.url)
      const inner = node.children.map(renderNode)
      if (!href) return <Fragment key={idx}>{inner}</Fragment>
      return (
        <a key={idx} href={href} target="_blank" rel="noopener noreferrer">
          {inner}
        </a>
      )
    }
    case 'paragraph':
      return <p key={idx}>{node.children.map(renderNode)}</p>
    case 'blockquote':
      return <blockquote key={idx}>{node.children.map(renderNode)}</blockquote>
    case 'list': {
      const items = node.items.map((item, i) => (
        <li key={i}>{item.map(renderNode)}</li>
      ))
      return node.ordered ? <ol key={idx}>{items}</ol> : <ul key={idx}>{items}</ul>
    }
  }
}
