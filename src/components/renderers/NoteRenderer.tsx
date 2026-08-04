import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

interface NoteRendererProps {
  text: string;
  onChange: (text: string) => void;
}

/**
 * A free-text note, edited in place.
 *
 * Deliberately not driven through ParamControls: a note is prose, and a
 * single-line text input is the wrong shape for it. Editing starts on click
 * and commits on blur or Ctrl/Cmd+Enter, so the common case — type, click
 * away — saves without a button to find.
 */
export default function NoteRenderer({ text, onChange }: NoteRendererProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Adopt an external change (a reload, or an import) unless the user is
  // mid-edit, where overwriting the draft would discard what they typed.
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== text) onChange(draft);
  };

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        className="note-editor"
        value={draft}
        aria-label="Note text"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            // Abandon the edit rather than commit it: Escape means cancel
            // everywhere else in the app.
            setDraft(text);
            setEditing(false);
          }
          // The card sits in a drag-and-drop grid; without this, typing a
          // space or an arrow key reaches the grid's key handling.
          e.stopPropagation();
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={`note-view ${text.trim() ? "" : "empty"}`}
      onClick={() => setEditing(true)}
      aria-label={text.trim() ? "Edit note" : "Add a note"}
    >
      {text.trim() ? (
        <div className="note-markdown">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      ) : (
        <span className="note-placeholder">Click to add a note…</span>
      )}
    </button>
  );
}
