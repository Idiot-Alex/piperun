import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { oneDark } from '@codemirror/theme-one-dark';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

const shellLang = StreamLanguage.define(shell);

export default function ShellEditor({ value, onChange, placeholder }: Props) {
  return (
    <div className="flex-1 min-h-0 rounded-lg overflow-hidden border border-base-300 focus-within:border-primary transition-colors" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13px' }}>
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={[shellLang]}
        theme={oneDark}
        placeholder={placeholder}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          foldGutter: false,
          dropCursor: false,
          allowMultipleSelections: false,
          indentOnInput: true,
          bracketMatching: true,
          autocompletion: false,
          highlightActiveLine: true,
          highlightSelectionMatches: false,
        }}
        style={{ minHeight: '200px' }}
      />
    </div>
  );
}
