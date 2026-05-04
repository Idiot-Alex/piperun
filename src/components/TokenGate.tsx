import { useState, useEffect } from 'react';
import { getToken, setToken, clearToken } from '../api';

interface Props {
  children: React.ReactNode;
}

type State = 'checking' | 'open' | 'gate';

export default function TokenGate({ children }: Props) {
  const [state, setState] = useState<State>('checking');
  const [input, setInput] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const r = await fetch('/api/ping');
        const data: { authRequired: boolean } = await r.json();
        if (cancelled) return;
        if (!data.authRequired) {
          setState('open');
        } else if (getToken()) {
          setState('open');
        } else {
          setState('gate');
        }
      } catch {
        if (!cancelled) setState('gate');
      }
    }

    init();

    const onLogout = () => {
      clearToken();
      setState('gate');
      setInput('');
      setErrorMsg('');
    };
    window.addEventListener('auth:logout', onLogout);

    return () => {
      cancelled = true;
      window.removeEventListener('auth:logout', onLogout);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = input.trim();
    if (!token) return;
    setVerifying(true);
    setErrorMsg('');
    try {
      const r = await fetch('/api/pipelines', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (r.ok) {
        setToken(token);
        setState('open');
      } else if (r.status === 401) {
        setErrorMsg('Token 不正确，请重试。');
      } else {
        setErrorMsg(`验证失败 (${r.status})，请重试。`);
      }
    } catch {
      setErrorMsg('连接失败，请检查网络。');
    } finally {
      setVerifying(false);
    }
  };

  if (state === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-base-200">
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  if (state === 'open') {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-base-200">
      <div className="card w-full max-w-sm bg-base-100 shadow-xl">
        <div className="card-body gap-4">
          <div className="flex items-center gap-2">
            <span className="text-2xl">⚡</span>
            <h2 className="card-title text-xl">PipeRun</h2>
          </div>
          <p className="text-sm text-base-content/60">
            此实例已启用访问控制，请输入 Token 以继续。
          </p>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <input
              type="password"
              className="input input-bordered w-full font-mono"
              placeholder="输入 Bearer Token"
              value={input}
              onChange={e => setInput(e.target.value)}
              autoFocus
              autoComplete="current-password"
            />
            {errorMsg && (
              <p className="text-error text-sm">{errorMsg}</p>
            )}
            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={verifying || !input.trim()}
            >
              {verifying
                ? <span className="loading loading-spinner loading-sm"></span>
                : '验证'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
