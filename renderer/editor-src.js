import { EditorState, Compartment, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

const themeComp = new Compartment();

const lightTheme = EditorView.theme({
  '&': { fontSize: '14px', height: '100%', backgroundColor: 'var(--bg-alt)' },
  '.cm-scroller': { fontFamily: '"SF Mono", Menlo, Consolas, monospace', lineHeight: '1.6' },
  '.cm-content': { padding: '12px 0' },
  '.cm-gutters': { backgroundColor: 'var(--bg-alt)', color: 'var(--fg-muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.03)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(0,0,0,0.05)' },
}, { dark: false });

export function createEditor(parent, opts = {}) {
  const { initial = '', onChange, onScroll, onCursor, dark = false } = opts;

  const listener = EditorView.updateListener.of(u => {
    if (u.docChanged && onChange) onChange(u.state.doc.toString());
    if ((u.selectionSet || u.docChanged) && onCursor) {
      const sel = u.state.selection.main;
      const line = u.state.doc.lineAt(sel.head);
      onCursor({ line: line.number, col: sel.head - line.from + 1 });
    }
  });

  const scrollHandler = EditorView.domEventHandlers({
    scroll(e, view) { if (onScroll) onScroll(view.scrollDOM); }
  });

  const state = EditorState.create({
    doc: initial,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      search({ top: true }),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      keymap.of([
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
        ...historyKeymap, ...foldKeymap, ...completionKeymap,
        indentWithTab,
      ]),
      listener,
      scrollHandler,
      themeComp.of(dark ? oneDark : lightTheme),
    ],
  });

  const view = new EditorView({ state, parent });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (s) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s } }),
    setDark: (d) => view.dispatch({ effects: themeComp.reconfigure(d ? oneDark : lightTheme) }),
    focus: () => view.focus(),
    getScrollDOM: () => view.scrollDOM,
    insertText: (text) => {
      const s = view.state.selection.main;
      view.dispatch({
        changes: { from: s.from, to: s.to, insert: text },
        selection: { anchor: s.from + text.length },
      });
    },
    wrapSelection: (pre, post) => {
      const s = view.state.selection.main;
      const sel = view.state.sliceDoc(s.from, s.to) || 'texte';
      const inserted = pre + sel + post;
      view.dispatch({
        changes: { from: s.from, to: s.to, insert: inserted },
        selection: EditorSelection.range(s.from + pre.length, s.from + pre.length + sel.length),
      });
    },
    prefixLine: (prefix) => {
      const s = view.state.selection.main;
      const line = view.state.doc.lineAt(s.head);
      view.dispatch({
        changes: { from: line.from, insert: prefix },
        selection: { anchor: s.head + prefix.length },
      });
    },
    onDocChange: (cb) => EditorView.updateListener.of(u => { if (u.docChanged) cb(); }),
  };
}

window.createEditor = createEditor;
