import { useEffect } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { Bold, Code, Heading2, Italic, List, ListOrdered } from 'lucide-react'

/**
 * The description editor of the create form: it FORMATS AS YOU TYPE — `# ` becomes a heading, `- ` or
 * `1. ` a list, `**x**` bold, `` `x` `` code, ``` ``` ``` a code block — and what it hands back is MARKDOWN
 * (`onChange(markdown)`), so the stored detail is the same text every other reader of a task's detail
 * already renders. TipTap (ProseMirror) with its official Markdown extension; loaded lazily by the dialog
 * so the board never pays for it.
 */
const CSS = `
.ag-md-editor .ProseMirror{outline:none;min-height:var(--md-min,110px);padding:8px 10px;font-size:13px;line-height:1.6;color:var(--text-primary)}
.ag-md-editor .ProseMirror h1{font-size:1.35em;margin:.5em 0 .3em}.ag-md-editor .ProseMirror h2{font-size:1.2em;margin:.5em 0 .3em}.ag-md-editor .ProseMirror h3{font-size:1.07em;margin:.5em 0 .3em}
.ag-md-editor .ProseMirror p{margin:.3em 0}.ag-md-editor .ProseMirror ul,.ag-md-editor .ProseMirror ol{margin:.3em 0;padding-left:1.4em}
.ag-md-editor .ProseMirror code{background:var(--bg-elevated);border-radius:4px;padding:1px 4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em}
.ag-md-editor .ProseMirror pre{background:var(--bg-elevated);border-radius:6px;padding:8px 10px;overflow-x:auto}.ag-md-editor .ProseMirror pre code{background:none;padding:0}
.ag-md-editor .ProseMirror blockquote{border-left:3px solid var(--border);margin:.4em 0;padding-left:.8em;color:var(--text-secondary)}
`

export function MarkdownEditor({ value, onChange, ariaLabel, minHeight = 110, isMobile }: {
  value: string
  onChange: (markdown: string) => void
  ariaLabel: string
  minHeight?: number
  isMobile?: boolean
}) {
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: value,
    contentType: 'markdown',
    editorProps: { attributes: { 'aria-label': ariaLabel, role: 'textbox', 'aria-multiline': 'true', 'data-md-editor': '' } },
    onUpdate: ({ editor: e }) => onChange(e.getMarkdown()),
  })
  useEffect(() => () => { editor?.destroy() }, [editor])
  const tool = (label: string, on: boolean, run: () => void, icon: React.ReactNode) => (
    <button
      type="button" aria-label={label} title={label} aria-pressed={on}
      onMouseDown={e => e.preventDefault()}
      onClick={run}
      style={{
        display: 'grid', placeItems: 'center', width: isMobile ? 36 : 26, height: isMobile ? 36 : 26, borderRadius: 6, border: 'none', cursor: 'pointer',
        background: on ? 'var(--anthropic-orange-dim)' : 'transparent', color: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
      }}
    >{icon}</button>
  )
  const c = () => editor!.chain().focus()
  return (
    <div className="ag-md-editor" style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-elevated)', ['--md-min' as string]: `${minHeight}px` }}>
      <style>{CSS}</style>
      {editor && (
        <div role="toolbar" aria-label={ariaLabel} style={{ display: 'flex', gap: 2, padding: '3px 5px', borderBottom: '1px solid var(--border)' }}>
          {tool('Heading', editor.isActive('heading'), () => c().toggleHeading({ level: 2 }).run(), <Heading2 size={14} />)}
          {tool('Bold', editor.isActive('bold'), () => c().toggleBold().run(), <Bold size={14} />)}
          {tool('Italic', editor.isActive('italic'), () => c().toggleItalic().run(), <Italic size={14} />)}
          {tool('Code', editor.isActive('code'), () => c().toggleCode().run(), <Code size={14} />)}
          {tool('Bulleted list', editor.isActive('bulletList'), () => c().toggleBulletList().run(), <List size={14} />)}
          {tool('Numbered list', editor.isActive('orderedList'), () => c().toggleOrderedList().run(), <ListOrdered size={14} />)}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  )
}
