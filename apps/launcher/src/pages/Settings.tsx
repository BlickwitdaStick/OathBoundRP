import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { describeGamePathProblem } from '../gamePathProblem';
import { ArrowLeft, Bug, FolderOpen, RefreshCw, Search, Wrench } from 'lucide-react';

export function Settings() {
  const navigate = useNavigate();
  const [gamePath, setGamePath] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [busy, setBusy] = useState<string>('');
  const [report, setReport] = useState<string>('');
  const [launcherUpdate, setLauncherUpdate] = useState<string>('');

  // Launcher self-update from the OATHBOUND GitHub releases: check, confirm,
  // then download the installer, run it and close the launcher.
  const handleLauncherUpdate = async () => {
    setError(''); setSuccess('');
    setBusy('Checking for a launcher update');
    try {
      const r = await window.electronAPI.checkLauncherUpdate();
      if (!r.ok) { setError(r.error || 'Could not check for a launcher update.'); return; }
      if (!r.available || !r.latest) { setSuccess(`The launcher is up to date (v${r.current}).`); return; }
      const latest = r.latest;
      if (!window.confirm(`Launcher v${latest.version} is available (you have v${r.current}). Download and install it now? The launcher will close.`)) return;
      const off = window.electronAPI.onLauncherUpdateProgress((p) => {
        setLauncherUpdate(p.total ? `Downloading v${latest.version}: ${Math.floor((100 * p.done) / p.total)}%` : 'Downloading...');
      });
      setBusy(`Updating the launcher to v${latest.version}`);
      const done = await window.electronAPI.installLauncherUpdate();
      off();
      if (!done.ok) setError(done.error || 'The launcher update failed.');
      else setSuccess(`Installing v${done.version}. The launcher will close and the installer will open.`);
    } finally {
      setBusy('');
    }
  };

  const location = useLocation();
  useEffect(() => {
    // Sent here by PLAY: say why, instead of leaving the player guessing.
    const notice = (location.state as { notice?: string } | null)?.notice;
    if (notice) setError(notice);
    window.electronAPI.getLauncherConfig().then(async (config) => {
      if (!config.gamePath) { if (!notice) setError(describeGamePathProblem('empty')); return; }
      setGamePath(config.gamePath);
      const check = await window.electronAPI.checkGamePath(config.gamePath);
      if (!check.ok && !notice) setError(describeGamePathProblem(check.reason));
    });
  }, []);

  const resetMessages = () => {
    setError('');
    setSuccess('');
    setReport('');
  };

  const requirePath = () => {
    if (!gamePath) {
      setError('Select the Skyrim directory first.');
      return false;
    }
    resetMessages();
    return true;
  };

  const handleSelectPath = async () => {
    resetMessages();
    try {
      const selected = await window.electronAPI.selectGamePath();
      if (!selected) return;
      const valid = await window.electronAPI.saveGamePath(selected);
      if (valid.ok) {
        setGamePath(selected);
        setSuccess('Directory validated and saved successfully.');
      } else {
        setError(describeGamePathProblem(valid.reason));
      }
    } catch (e: any) {
      setError(e.message || 'Failed to select directory.');
    }
  };

  const handleRepairIni = async () => {
    if (!requirePath()) return;
    setBusy('repair-ini');
    try {
      const result = await window.electronAPI.ensureSkyrimIni({ mode: 'borderless' });
      if (result.ok) setSuccess(result.skipped ? 'INI was already valid.' : `INI repaired: ${result.width}x${result.height} ${result.mode}.`);
      else setError(result.error || 'Failed to repair INI.');
    } catch (e: any) {
      setError(e.message || 'Failed to repair INI.');
    } finally {
      setBusy('');
    }
  };

  const handleRepairUi = async () => {
    if (!requirePath()) return;
    setBusy('repair-ui');
    try {
      const result = await window.electronAPI.ensureSkympUi(gamePath);
      if (!result.ok) setError(result.error || 'Failed to repair the interface.');
      else if (result.repaired.length > 0) setSuccess(`Interface repaired: ${result.repaired.length} file(s).`);
      else setSuccess(`Interface valid: ${result.files || 0} file(s).`);
    } catch (e: any) {
      setError(e.message || 'Failed to repair the interface.');
    } finally {
      setBusy('');
    }
  };

  const handleAnalyze = async () => {
    if (!requirePath()) return;
    setBusy('analyze-mods');
    try {
      const verify = await window.electronAPI.verifyMods(gamePath);
      if (!verify.success) {
        setError(verify.error || 'Failed to verify mods.');
        return;
      }
      if (verify.loadOrder) await window.electronAPI.syncLoadorder(gamePath, verify.loadOrder);
      const analysis = await window.electronAPI.analyzePlugins(gamePath, verify.loadOrder || []);
      if (analysis.ok) {
        setSuccess(`Mods and load order OK. Plugins analyzed: ${analysis.plugins.length}.`);
      } else {
        setError('Load-order problems found.');
        setReport(analysis.problems.slice(0, 8).join('\n'));
      }
    } catch (e: any) {
      setError(e.message || 'Failed to analyze mods.');
    } finally {
      setBusy('');
    }
  };

  const handleReportCrashes = async () => {
    resetMessages();
    setBusy('crash-report');
    try {
      const result = await window.electronAPI.reportRecentCrashes();
      if (result.ok) {
        setSuccess(result.sent ? `Crash report sent (${result.sent} file(s)).` : 'No recent crashes found.');
      } else {
        setError(result.error || 'Failed to send crash report.');
      }
    } catch (e: any) {
      setError(e.message || 'Failed to send crash report.');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="page-container">
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '32px' }}>
        <button className="btn-secondary" onClick={() => navigate('/home')} style={{ padding: '8px' }}>
          <ArrowLeft size={20} />
        </button>
        <h1 style={{ fontSize: '24px', color: 'var(--text-main)' }}>Settings</h1>
      </div>

      <div style={{ background: 'var(--bg-panel)', padding: '24px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
        <h2 style={{ fontSize: '18px', color: 'var(--accent-gold)', marginBottom: '16px' }}>Game Directory</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: '16px', fontSize: '14px' }}>
          Select the folder where Steam Skyrim Special Edition is installed.
        </p>

        <div style={{ display: 'flex', gap: '12px' }}>
          <input
            type="text"
            readOnly
            value={gamePath}
            placeholder="Ex: C:\\Program Files (x86)\\Steam\\steamapps\\common\\Skyrim Special Edition"
            style={{
              flex: 1,
              padding: '12px',
              backgroundColor: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-main)',
              borderRadius: '4px',
              fontFamily: 'monospace'
            }}
          />
          <button className="btn-primary" onClick={handleSelectPath} style={{ padding: '12px 16px' }}>
            <FolderOpen size={18} />
          </button>
        </div>

        {error && <p style={{ color: 'var(--error)', marginTop: '12px', fontSize: '14px' }}>{error}</p>}
        {success && <p style={{ color: 'var(--success)', marginTop: '12px', fontSize: '14px' }}>{success}</p>}
      </div>

      <div style={{ background: 'var(--bg-panel)', padding: '24px', borderRadius: '8px', border: '1px solid var(--border-color)', marginTop: '20px' }}>
        <h2 style={{ fontSize: '18px', color: 'var(--accent-gold)', marginBottom: '16px' }}>Maintenance & Diagnostics</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px' }}>
          <button className="btn-secondary" onClick={handleRepairIni} disabled={!!busy}>
            <Wrench size={18} /> Repair INI
          </button>
          <button className="btn-secondary" onClick={handleRepairUi} disabled={!!busy}>
            <Wrench size={18} /> Repair Interface
          </button>
          <button className="btn-secondary" onClick={handleAnalyze} disabled={!!busy}>
            <Search size={18} /> Analyze Mods
          </button>
          <button className="btn-secondary" onClick={handleReportCrashes} disabled={!!busy}>
            <Bug size={18} /> Send Crash Report
          </button>
          <button className="btn-secondary" onClick={handleLauncherUpdate} disabled={!!busy}>
            <RefreshCw size={18} /> Update Launcher
          </button>
        </div>
        {busy && <p style={{ color: 'var(--accent-gold)', marginTop: '12px' }}>Working: {busy}</p>}
        {launcherUpdate && <p style={{ color: 'var(--accent-gold)', marginTop: '6px' }}>{launcherUpdate}</p>}
        {report && (
          <pre style={{
            whiteSpace: 'pre-wrap',
            marginTop: '12px',
            padding: '12px',
            background: 'rgba(0,0,0,0.35)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            color: 'var(--text-muted)',
            fontSize: '13px'
          }}>{report}</pre>
        )}
      </div>
    </div>
  );
}



