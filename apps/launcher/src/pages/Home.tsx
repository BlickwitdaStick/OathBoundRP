import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthData, LaunchGameResult, ServerModsCheck } from '../types/electron';
import { Play, Settings as SettingsIcon, LogOut, FolderOpen, RefreshCw } from 'lucide-react';
import heroBg from '../assets/launcher-bg.png';

interface HomeProps {
  auth: AuthData;
  setAuth: (auth: AuthData | null) => void;
}

type AppInfo = {
  launcherVersion: string;
  clientVersion: string | null;
  modsVersion: string | null;
  gamePath: string | null;
};

const QUEUE_POLL_INTERVAL_MS = 4000;
const SERVER_STATUS_POLL_INTERVAL_MS = 15000;

const launchFailureMessage = (result: LaunchGameResult) => {
  const detail = result.error?.trim() || result.code?.trim();
  return detail
    ? `Failed to launch Skyrim: ${detail}`
    : 'Failed to launch Skyrim. Verifique a instalacao e tente novamente.';
};

export function Home({ auth, setAuth }: HomeProps) {
  const navigate = useNavigate();
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState<string>('');
  // null = ainda checando. Antes disto o card mostrava "Online" fixo no JSX,
  // sem nenhuma chamada por tras — bolinha verde e texto que nunca mudavam
  // mesmo com o apps/game-api fora do ar.
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateResult, setUpdateResult] = useState<string>('');
  // Server-hosted mods prompt (SkyUI, RaceMenu...): shown when the server
  // requires files the player does not have; resolves true on "Download".
  const [modPrompt, setModPrompt] = useState<{ check: ServerModsCheck; resolve: (accepted: boolean) => void } | null>(null);

  const askToInstallServerMods = (check: ServerModsCheck) =>
    new Promise<boolean>((resolve) => {
      setModPrompt({
        check,
        resolve: (accepted) => {
          setModPrompt(null);
          resolve(accepted);
        }
      });
    });

  const formatMb = (bytes: number) => bytes >= 1073741824
    ? `${(bytes / 1073741824).toFixed(1)} GB`
    : `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;

  // Texture packs bring thousands of files: show plugins/archives at the root
  // individually and everything else grouped by its top-level folder.
  const groupMissingFiles = (files: Array<{ path: string; size: number }>) => {
    const groups = new Map<string, { label: string; count: number; size: number }>();
    for (const f of files) {
      const slash = f.path.indexOf('/');
      const label = slash === -1 ? f.path : `${f.path.slice(0, slash)}/`;
      const key = label.toLowerCase();
      const g = groups.get(key) || { label, count: 0, size: 0 };
      g.count += 1;
      g.size += f.size;
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.size - a.size);
  };
  const queuePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAppInfo = () => {
    window.electronAPI.getAppInfo().then(setAppInfo).catch(() => {});
  };

  const stopQueuePolling = () => {
    if (queuePollRef.current !== null) {
      clearInterval(queuePollRef.current);
      queuePollRef.current = null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    const checkStatus = async () => {
      try {
        const result = await window.electronAPI.checkServerStatus();
        if (!cancelled) setServerOnline(result.online);
      } catch {
        if (!cancelled) setServerOnline(false);
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, SERVER_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    return () => stopQueuePolling();
  }, []);

  useEffect(() => {
    loadAppInfo();
  }, []);

  // `invalid_ticket`/`not_authenticated` do apps/game-api significam que nem
  // a sessao de launcher (30 dias, ver migration-v25) conseguiu emitir um
  // ticket valido — a unica saida real e' logar de novo. Antes disto o
  // jogador so via "Erro: invalid_ticket" cru na tela, sem indicacao de que
  // precisava relogar.
  const isSessionExpiredMessage = (message: unknown) =>
    message === 'invalid_ticket' || message === 'not_authenticated';

  const handleSessionExpired = async () => {
    stopQueuePolling();
    setIsPlaying(false);
    setStatus('Session expired. Please sign in again...');
    await window.electronAPI.discordLogout();
    setTimeout(() => setAuth(null), 1500);
  };

  const startQueuePolling = (gamePath: string) => {
    stopQueuePolling();
    queuePollRef.current = setInterval(async () => {
      try {
        const pollRes = await window.electronAPI.pollQueue();
        if (pollRes.status === 'queued') {
          setStatus(`In queue (position: ${pollRes.position})`);
          return;
        }
        stopQueuePolling();
        if (pollRes.status === 'success') {
          setStatus('Launching Skyrim...');
          setIsPlaying(true);
          try {
            const launchResult = await window.electronAPI.launchGame(gamePath, pollRes.ticket);
            setStatus(launchResult.ok ? 'Skyrim launched.' : launchFailureMessage(launchResult));
          } finally {
            setIsPlaying(false);
          }
          return;
        }
        if (isSessionExpiredMessage(pollRes.message)) {
          await handleSessionExpired();
          return;
        }
        setStatus(`Erro: ${pollRes.message || 'queue unavailable'}`);
      } catch (e: any) {
        stopQueuePolling();
        setStatus(`Erro: ${e.message}`);
      }
    }, QUEUE_POLL_INTERVAL_MS);
  };

  const handleLogout = async () => {
    stopQueuePolling();
    await window.electronAPI.discordLogout();
    setAuth(null);
  };

  const handleChangePath = async () => {
    const selected = await window.electronAPI.selectGamePath();
    if (!selected) return;
    const valid = await window.electronAPI.saveGamePath(selected);
    if (valid.ok) loadAppInfo();
  };

  // Mesma checagem que Configuracoes ja fazia (handleCheckUpdates) — so
  // reexposta aqui pra nao obrigar o jogador a sair da Home pra saber se ha
  // atualizacao. A instalacao em si continua so em Configuracoes.
  const handleCheckUpdates = async () => {
    if (!appInfo?.gamePath) {
      navigate('/settings');
      return;
    }
    setCheckingUpdates(true);
    setUpdateResult('');
    try {
      const client = await window.electronAPI.checkClientUpdate(appInfo.gamePath);
      const mods = await window.electronAPI.checkModsUpdate(appInfo.gamePath);
      const parts: string[] = [];
      if (client.updateAvailable) parts.push(`client ${client.version}`);
      if (mods.updateAvailable) parts.push(`mods ${mods.version}`);
      setUpdateResult(parts.length > 0 ? `Update available: ${parts.join(', ')}.` : 'Everything is up to date.');
    } catch (e: any) {
      setUpdateResult(`Erro: ${e.message}`);
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handlePlay = async () => {
    setIsPlaying(true);
    setStatus('Checking game folder...');
    try {
      const config = await window.electronAPI.getLauncherConfig();
      const gamePath = config.gamePath;
      if (!gamePath) {
        setStatus('Configure the Skyrim directory before playing.');
        navigate('/settings');
        return;
      }

      const pathOk = await window.electronAPI.checkGamePath(gamePath);
      if (!pathOk.ok) {
        setStatus(`Invalid game directory: ${pathOk.reason}`);
        navigate('/settings');
        return;
      }

      setStatus('Checking interface do jogo...');
      const ui = await window.electronAPI.ensureSkympUi(gamePath);
      if (!ui.ok) {
        setStatus(`Failed to install the interface: ${ui.error || 'bundle unavailable'}`);
        return;
      }

      // Voz por proximidade: opcional, nunca trava o PLAY. Se o helper nao veio
      // no pacote (skipped) ou a copia falhou, segue — a voz so nao funciona.
      const voice = await window.electronAPI.ensureVoiceHelper(gamePath);
      if (!voice.ok) {
        console.warn('[launcher] voice-helper nao instalado:', voice.error);
      }

      setStatus('Validating client version...');
      const clientUpdate = await window.electronAPI.checkClientUpdate(gamePath);
      if (clientUpdate.error) {
        setStatus(`Could not validate the client version: ${clientUpdate.error}`);
        return;
      }
      if (clientUpdate.updateAvailable) {
        setStatus(`Required client update: ${clientUpdate.version}. Install it from Settings.`);
        navigate('/settings');
        return;
      }

      await window.electronAPI.ensureSkyrimIni({ repairOnly: true });

      // Mods the server hosts (skymp/client-mods). Must run before verifyMods:
      // the parity gate expects these plugins to be installed and enabled.
      setStatus('Checking server mods...');
      const serverMods = await window.electronAPI.checkServerMods(gamePath);
      if (!serverMods.ok) {
        setStatus(`Could not check the server's mods: ${serverMods.error || 'server unavailable'}`);
        return;
      }
      if (serverMods.missingBase && serverMods.missingBase.length > 0) {
        // Not downloadable: these come with Skyrim Anniversary Edition.
        setStatus(`This server needs base-game files you don't have: ${serverMods.missingBase.join(', ')}. ` +
          'They come with Skyrim Anniversary Edition (free Creation Club content) - verify your game files in Steam.');
        return;
      }
      if (serverMods.missing && serverMods.missing.length > 0) {
        const accepted = await askToInstallServerMods(serverMods);
        if (!accepted) {
          setStatus('This server requires its mods to play. Click PLAY again when you want to install them.');
          return;
        }
        window.electronAPI.onServerModsProgress((p) => {
          const pct = p.bytesTotal > 0 ? Math.floor((p.bytesDone / p.bytesTotal) * 100) : 100;
          setStatus(`Downloading server mods (${p.index + 1}/${p.count}): ${p.file} — ${pct}%`);
        });
        setStatus('Downloading server mods...');
        const installed = await window.electronAPI.installServerMods(gamePath);
        if (!installed.ok) {
          setStatus(`Server mods download failed: ${installed.error || 'unknown error'}`);
          return;
        }
      } else {
        // Files already present: still make sure the plugins are enabled.
        const enabled = await window.electronAPI.enableServerPlugins(gamePath);
        if (!enabled.ok) {
          setStatus(`Could not enable the server's plugins: ${enabled.error || 'unknown error'}`);
          return;
        }
      }

      setStatus('Validating mods with the server...');
      const verify = await window.electronAPI.verifyMods(gamePath);
      if (!verify.success) {
        setStatus(`Invalid mods: ${verify.error || 'validation failed'}`);
        return;
      }

      if (verify.loadOrder) {
        await window.electronAPI.syncLoadorder(gamePath, verify.loadOrder);
        const analysis = await window.electronAPI.analyzePlugins(gamePath, verify.loadOrder);
        if (!analysis.ok) {
          setStatus(`Load-order problem: ${analysis.problems[0]}`);
          return;
        }
      }

      setStatus('Joining queue...');
      const queueRes = await window.electronAPI.joinQueue();
      if (queueRes.status === 'queued') {
        setStatus(`In queue (position: ${queueRes.position})`);
        startQueuePolling(gamePath);
        return;
      }
      if (queueRes.status === 'success') {
        setStatus('Launching Skyrim...');
        const launchResult = await window.electronAPI.launchGame(gamePath, queueRes.ticket);
        setStatus(launchResult.ok ? 'Skyrim launched.' : launchFailureMessage(launchResult));
        return;
      }
      if (isSessionExpiredMessage(queueRes.message)) {
        await handleSessionExpired();
        return;
      }
      setStatus(`Erro: ${queueRes.message || 'queue unavailable'}`);
    } catch (e: any) {
      setStatus(`Erro: ${e.message}`);
    } finally {
      setIsPlaying(false);
    }
  };

  const statusDotClass = serverOnline === null ? 'checking' : serverOnline ? 'online' : 'offline';
  const statusLabel = serverOnline === null ? 'Checking' : serverOnline ? 'Online' : 'Offline';

  return (
    <div className="hero-shell has-image" style={{ ['--hero-image' as any]: `url(${heroBg})` }}>
      <nav className="dashboard-nav">
        <div className="nav-brand">
          <img src="/logo.png" alt="" />
          <span>OATHBOUND RP</span>
        </div>

        <div className="nav-tabs">
          <button className="nav-tab active">Home</button>
          <button className="nav-tab" onClick={() => navigate('/settings')}>
            <SettingsIcon size={14} /> Settings
          </button>
        </div>

        <div className="nav-right">
          <div className="status-pill">
            <span className={`status-dot ${statusDotClass}`} />
            {statusLabel}
          </div>
          <div className="identity-chip">
            {auth.avatar ? (
              <img src={auth.avatar} alt="Avatar" />
            ) : (
              <div className="identity-fallback" />
            )}
            <span>{auth.globalName}</span>
          </div>
          <button className="icon-btn" onClick={handleLogout} title="Sign Out">
            <LogOut size={16} />
          </button>
        </div>
      </nav>

      <div className="dashboard-body">
        <aside className="info-sidebar hud-panel">
          <div>
            <div className="info-section-title">Information</div>
            <div className="info-row">
              <span className="info-row-label">Launcher</span>
              <span className="info-row-value">v{appInfo?.launcherVersion ?? '—'}</span>
            </div>
            <div className="info-row">
              <span className="info-row-label">Client</span>
              <span className="info-row-value">{appInfo?.clientVersion ?? '—'}</span>
            </div>
            <div className="info-row">
              <span className="info-row-label">Mods</span>
              <span className="info-row-value">{appInfo?.modsVersion ?? '—'}</span>
            </div>
          </div>

          <div>
            <div className="info-section-title">Game Directory</div>
            <div className="info-path">{appInfo?.gamePath || 'Not configured'}</div>
            <div className="maintenance-list">
              <button className="maintenance-btn" onClick={handleChangePath}>
                <FolderOpen size={14} /> Change Folder
              </button>
            </div>
          </div>

          <div>
            <div className="info-section-title">Maintenance</div>
            <div className="maintenance-list">
              <button className="maintenance-btn" onClick={handleCheckUpdates} disabled={checkingUpdates}>
                <RefreshCw size={14} /> {checkingUpdates ? 'Checking...' : 'Check for Updates'}
              </button>
              <button className="maintenance-btn" onClick={() => navigate('/settings')}>
                <SettingsIcon size={14} /> Advanced Settings
              </button>
            </div>
            {updateResult && (
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px' }}>{updateResult}</p>
            )}
          </div>
        </aside>

        <div className="dashboard-main">
          <h1 className="brand-title" style={{ fontSize: '36px' }}>OATHBOUND RP</h1>

          <div className="brand-flourish">
            <span className="brand-flourish-mark" />
          </div>

          <div className="status-card hud-panel">
            <div className="status-card-label">Server Status</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '8px' }}>
              <span className={`status-dot ${statusDotClass}`} style={{ width: '10px', height: '10px' }} />
              <span style={{ fontSize: '20px', fontWeight: 600 }}>{statusLabel}</span>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Mods validated automatically</p>
          </div>

          <button
            className="btn-primary"
            style={{ width: '100%', maxWidth: '400px', padding: '18px', fontSize: '20px' }}
            onClick={handlePlay}
            disabled={isPlaying || serverOnline === false}
          >
            <Play size={24} />
            {isPlaying ? 'PLEASE WAIT' : 'PLAY'}
          </button>

          {status && <p style={{ color: 'var(--accent-gold)', textAlign: 'center', maxWidth: '620px' }}>{status}</p>}
        </div>
      </div>

      {modPrompt && (
        <div className="mods-prompt-overlay" role="dialog" aria-modal="true" aria-labelledby="mods-prompt-title">
          <div className="mods-prompt hud-panel">
            <h2 id="mods-prompt-title" className="mods-prompt-title">This server requires mods</h2>
            <p className="mods-prompt-text">
              {modPrompt.check.missing?.length} file{modPrompt.check.missing?.length === 1 ? '' : 's'} to download
              ({formatMb(modPrompt.check.bytesNeeded || 0)}) into your Skyrim Data folder.
              {modPrompt.check.plugins && modPrompt.check.plugins.length > 0 && (
                <> Plugins that will be enabled: <strong>{modPrompt.check.plugins.join(', ')}</strong>.</>
              )}
            </p>
            <ul className="mods-prompt-list">
              {groupMissingFiles(modPrompt.check.missing || []).map((g) => (
                <li key={g.label}>
                  <span>{g.label}{g.count > 1 ? ` (${g.count} files)` : ''}</span>
                  <span>{formatMb(g.size)}</span>
                </li>
              ))}
            </ul>
            <div className="mods-prompt-actions">
              <button className="maintenance-btn" onClick={() => modPrompt.resolve(false)}>Not now</button>
              <button className="btn-primary" onClick={() => modPrompt.resolve(true)}>Download and play</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


