import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Bug, Download, FolderOpen, Search, Wrench } from 'lucide-react';

export function Settings() {
  const navigate = useNavigate();
  const [gamePath, setGamePath] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [busy, setBusy] = useState<string>('');
  const [report, setReport] = useState<string>('');

  useEffect(() => {
    window.electronAPI.getLauncherConfig().then((config) => {
      if (config.gamePath) setGamePath(config.gamePath);
    });
    window.electronAPI.onUpdateProgress((value) => setReport(`Client: ${value.phase} ${value.percent}%`));
    window.electronAPI.onModsUpdateProgress((value) => setReport(`Mods: ${value.phase} ${value.percent}%`));
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
        setError(`Invalid directory: ${valid.reason}`);
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
      else if (result.repaired.length > 0) setSuccess(`Interface repaired: ${result.repaired.length} arquivo(s).`);
      else setSuccess(`Interface valid: ${result.files || 0} arquivo(s).`);
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

  const handleCheckUpdates = async () => {
    if (!requirePath()) return;
    setBusy('check-updates');
    try {
      const client = await window.electronAPI.checkClientUpdate(gamePath);
      const mods = await window.electronAPI.checkModsUpdate(gamePath);
      setReport([
        `Client: ${client.error || (client.updateAvailable ? `update ${client.installedVersion || 'none'} -> ${client.version}` : `current ${client.installedVersion || client.version || 'unknown'}`)}`,
        `Mods: ${mods.error || (mods.updateAvailable ? `update ${mods.installedVersion || 'none'} -> ${mods.version}` : `current ${mods.installedVersion || mods.version || 'unknown'}`)}`
      ].join('\n'));
    } catch (e: any) {
      setError(e.message || 'Failed to check for updates.');
    } finally {
      setBusy('');
    }
  };

  const handleInstallClient = async () => {
    if (!requirePath()) return;
    if (!confirm('Update the SkyMP client now? Close the game before continuing.')) return;
    setBusy('client-update');
    try {
      const result = await window.electronAPI.installClientUpdate(gamePath);
      if (result.success) setSuccess(`Client updated to ${result.version}.`);
      else setError(result.error || 'Failed to update client.');
    } catch (e: any) {
      setError(e.message || 'Failed to update client.');
    } finally {
      setBusy('');
    }
  };

  const handleInstallMods = async () => {
    if (!requirePath()) return;
    if (!confirm('Update the modpack now? Close the game before continuing.')) return;
    setBusy('mods-update');
    try {
      const result = await window.electronAPI.installModsUpdate(gamePath, false);
      if (result.success) setSuccess(`Mods updated to ${result.version}.`);
      else setError(result.error || 'Failed to update mods.');
    } catch (e: any) {
      setError(e.message || 'Failed to update mods.');
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
        setSuccess(result.sent ? `Crash report sent (${result.sent} arquivo(s)).` : 'No recent crashes found.');
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
          <button className="btn-secondary" onClick={handleCheckUpdates} disabled={!!busy}>
            <Download size={18} /> Check for Updates
          </button>
          <button className="btn-secondary" onClick={handleInstallClient} disabled={!!busy}>
            <Download size={18} /> Update Client
          </button>
          <button className="btn-secondary" onClick={handleInstallMods} disabled={!!busy}>
            <Download size={18} /> Update Mods
          </button>
          <button className="btn-secondary" onClick={handleReportCrashes} disabled={!!busy}>
            <Bug size={18} /> Send Crash Report
          </button>
        </div>
        {busy && <p style={{ color: 'var(--accent-gold)', marginTop: '12px' }}>Executando: {busy}</p>}
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



