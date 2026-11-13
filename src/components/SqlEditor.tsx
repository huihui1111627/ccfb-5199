import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { sql } from '@codemirror/lang-sql';
import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language';

interface Props {
  value: string;
  onChange: (v: string) => void;
  height?: number;
}

/** CodeMirror 6 SQL 编辑器（深色主题、括号匹配、折叠、历史） */
export function SqlEditor({ value, onChange, height = 440 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const editable = new Compartment();
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        bracketMatching(),
        indentOnInput(),
        highlightActiveLine(),
        sql({ dialect: undefined, upperCaseKeywords: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        EditorView.theme({
          '&': { height: `${height}px`, color: '#e6ebf5' },
          '.cm-gutters': { color: '#4f5d7a' },
          '.cm-activeLine': { backgroundColor: 'rgba(59,130,246,.08)' },
          '.cm-activeLineGutter': { backgroundColor: 'rgba(59,130,246,.15)' },
          '&.cm-focused': { outline: 'none' },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部值变更（恢复默认 / 切换任务）时同步到编辑器
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className="cm-host" style={{ height }} />;
}
