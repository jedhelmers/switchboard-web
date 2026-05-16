// Thin TipTap wrappers used by the chat composer (editable) and message
// renderer (readonly). Storing TipTap JSON in messages.payload gives us a
// lossless round-trip; messages.text holds the plaintext fallback so search,
// notifications, and accessibility never depend on the rich layer.

import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { useEffect, useRef } from 'react'

const editorClasses = [
  // Layout
  'min-h-[2.25rem] max-h-60 overflow-y-auto',
  // Typography fallbacks (we don't pull in @tailwindcss/typography to avoid the
  // bundle weight; everything below targets only the small set of nodes/marks
  // emitted by our editor).
  'text-sm text-zinc-100',
  // Element-specific spacing — nothing fancy, just readable defaults.
  '[&_p]:my-1',
  '[&_strong]:font-semibold',
  '[&_em]:italic',
  '[&_u]:underline',
  '[&_s]:line-through',
  '[&_a]:text-sky-400 [&_a]:underline [&_a:hover]:text-sky-300',
  '[&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-1',
  '[&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-1',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-zinc-600 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-300',
  // Code: orange-on-dark for both inline `code` and code blocks.
  '[&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em] [&_code]:font-mono [&_code]:text-orange-400',
  '[&_pre]:my-1.5 [&_pre]:rounded [&_pre]:bg-zinc-950 [&_pre]:border [&_pre]:border-zinc-800 [&_pre]:p-3 [&_pre]:overflow-x-auto',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-sm [&_pre_code]:text-orange-400',
  // ProseMirror writes `is-empty` on a placeholder paragraph; the placeholder
  // extension drops a data attr we use to render the prompt text.
  '[&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]',
  '[&_p.is-editor-empty:first-child]:before:text-zinc-500',
  '[&_p.is-editor-empty:first-child]:before:float-left',
  '[&_p.is-editor-empty:first-child]:before:pointer-events-none',
  '[&_p.is-editor-empty:first-child]:before:h-0',
  // Kill every flavour of browser focus styling on the contentEditable surface.
  // The parent card owns the visual focus state; we don't want a competing ring.
  '[&_.ProseMirror]:outline-none [&_.ProseMirror]:focus:outline-none [&_.ProseMirror]:focus-visible:outline-none',
  // (padding lives on the composer's wrapper div, not here, so it can be
  // tweaked independently of the readonly MessageRender.)
].join(' ')

export type EditorOpts = {
  placeholder?: string
  // Called whenever the document changes (debounced internally by TipTap).
  // Used by the composer to trigger typing-indicator notify().
  onUpdate?: (e: Editor) => void
  // Called when the user hits ⌘/Ctrl+Enter — the composer maps this to send.
  onSubmit?: () => void
  disabled?: boolean
}

export function useChatEditor(opts: EditorOpts = {}): Editor | null {
  // Forward-reference: editorProps.handleKeyDown is created before useEditor
  // returns the Editor instance, so we read it via a ref that we update
  // immediately after construction below.
  const editorInstanceRef = useRef<Editor | null>(null)
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // We want our own placeholder + link styling.
        link: false,
        // Disable headings and horizontal rule — Slack-style chat doesn't use them.
        heading: false,
        horizontalRule: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false, // we handle clicks via onSubmit-equivalents
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
        },
      }),
      Placeholder.configure({
        placeholder: opts.placeholder ?? 'Message…',
      }),
    ],
    editable: !opts.disabled,
    autofocus: false,
    editorProps: {
      attributes: {
        class: editorClasses,
      },
      handleKeyDown(_, event) {
        if (event.key !== 'Enter') return false
        // Editor instance for state queries / commands. We can read the
        // current selection's structural context (list item, code block,
        // blockquote) to decide whether Enter belongs to the editor or to
        // the send action.
        const ed = editorInstanceRef.current
        if (!ed) return false
        const inListItem = ed.isActive('listItem')
        const inCodeBlock = ed.isActive('codeBlock')
        const inBlockquote = ed.isActive('blockquote')

        if (event.shiftKey) {
          // Inside a list, shift+enter creates a new list item ("new row")
          // instead of the default soft line-break.
          if (inListItem) {
            event.preventDefault()
            ed.chain().focus().splitListItem('listItem').run()
            return true
          }
          // Outside a list, fall through so TipTap inserts the default
          // hard-break (line break within the same paragraph).
          return false
        }

        // Plain Enter: inside structural blocks, let the editor do its thing
        // (new list item, new line in code block, exit blockquote, etc.).
        if (inListItem || inCodeBlock || inBlockquote) return false

        // Otherwise plain Enter sends the message.
        if (opts.onSubmit) {
          event.preventDefault()
          opts.onSubmit()
          return true
        }
        return false
      },
    },
    onUpdate({ editor }) {
      opts.onUpdate?.(editor as Editor)
    },
  })

  // Keep the disabled state in sync without blowing up the editor on every change.
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!opts.disabled)
  }, [editor, opts.disabled])

  // Update the ref so handleKeyDown can query the current selection state.
  editorInstanceRef.current = editor
  return editor
}

// EditorView is the editable surface used by the composer.
export function EditorView({ editor }: { editor: Editor | null }) {
  return <EditorContent editor={editor} />
}

// MessageRender is the readonly rendering of a TipTap JSON document, used in
// the message list. `useEditor` only takes `content` as an initializer — it
// won't update when the prop changes — so a follow-up effect calls
// setContent whenever the JSON shape actually differs. Without this, an
// edit that lands via realtime would leave the on-screen message frozen at
// its pre-edit text.
export function MessageRender({ doc }: { doc: JSONContent }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false, heading: false, horizontalRule: false }),
      Underline,
      Link.configure({
        openOnClick: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
        },
      }),
    ],
    editable: false,
    content: doc,
    editorProps: {
      attributes: {
        class: editorClasses + ' [&_.ProseMirror]:!p-0',
      },
    },
  })

  // Compare by serialized content rather than reference: parent re-renders
  // hand us a new object identity each time even when the doc is unchanged,
  // and we don't want to thrash setContent on every render.
  const serialized = JSON.stringify(doc)
  const lastSerializedRef = useRef<string>(serialized)
  useEffect(() => {
    if (!editor) return
    if (serialized === lastSerializedRef.current) return
    lastSerializedRef.current = serialized
    editor.commands.setContent(doc, { emitUpdate: false })
  }, [editor, serialized, doc])

  return <EditorContent editor={editor} />
}

// docIsEmpty returns true when a TipTap JSON document is the blank starter
// (a single empty paragraph). Use this on the send path so we don't store a
// useless rich payload alongside the plaintext.
export function docIsEmpty(doc: JSONContent | undefined): boolean {
  if (!doc || !doc.content) return true
  if (doc.content.length === 0) return true
  if (doc.content.length === 1) {
    const only = doc.content[0]
    if (only?.type === 'paragraph' && (!only.content || only.content.length === 0)) {
      return true
    }
  }
  return false
}
