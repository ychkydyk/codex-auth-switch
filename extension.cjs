const vscode = require('vscode');
const {spawn} = require('node:child_process');
const {existsSync} = require('node:fs');
const path = require('node:path');

const SECRET_KEY = 'codexAuthSwitch.apiKey.v1';
const RELOAD = 'Reload now';
const LATER = 'Later';
const MODES = new Set(['api', 'chatgpt']);
const statusLabel = mode => ({api: 'API', chatgpt: 'Subscription', signed_out: 'Sign in', unknown: 'Check sign-in'})[mode];
const parseMode = output => /api key|api_key|apikey/i.test(output) ? 'api' : /chatgpt/i.test(output) ? 'chatgpt' : 'unknown';

function platformFolder() {
  if (process.platform === 'win32') return 'windows-x86_64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x86_64';
  return null;
}

function officialCli() {
  const openai = vscode.extensions.getExtension('openai.chatgpt');
  const folder = platformFolder();
  if (!openai || !folder) return null;
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidate = path.join(openai.extensionPath, 'bin', folder, name);
  return existsSync(candidate) ? candidate : null;
}

function runCli(executable, args, input = '') {
  return new Promise(resolve => {
    const child = spawn(executable, args, {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let output = '';
    const add = chunk => { if (output.length < 32768) output += String(chunk).slice(0, 32768 - output.length); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), 120000);
    child.once('error', () => { clearTimeout(timer); resolve({ok: false, output: ''}); });
    child.once('exit', code => { clearTimeout(timer); resolve({ok: code === 0, output}); });
    child.stdin.end(input ? `${input}\n` : '');
  });
}

function activate(context) {
  let mode = 'unknown', initialMode = null, changing = false, reloadPending = false, disposed = false, refreshPromise = null;
  const item = vscode.window.createStatusBarItem('wedoCodexAuth.mode', vscode.StatusBarAlignment.Right, 1000);
  item.name = 'Codex API / Subscription';
  item.command = 'wedoCodexAuth.switch';
  function draw() {
    item.text = changing ? '$(sync~spin) Codex: signing in…' : `$(account) Codex: ${statusLabel(mode)}${reloadPending ? ' ↻' : ''}`;
    item.tooltip = `Codex saved sign-in: ${statusLabel(mode)}. Select to switch API / subscription.${reloadPending ? '\nReload VS Code to refresh the Codex extension.' : ''}`;
    item.accessibilityInformation = {label: `Codex ${statusLabel(mode)}${reloadPending ? ', reload pending' : ''}`}; item.show();
  }
  async function refresh() {
    if (disposed || changing) return mode;
    if (refreshPromise) return refreshPromise;
    const executable = officialCli();
    if (!executable) { mode = 'unknown'; draw(); return mode; }
    refreshPromise = runCli(executable, ['login', 'status']).then(result => {
      if (!disposed) { mode = result.ok ? parseMode(result.output) : (mode === 'unknown' ? 'signed_out' : mode); if (initialMode === null) initialMode = mode; else if (mode !== initialMode && MODES.has(mode)) reloadPending = true; draw(); }
      return mode;
    }).finally(() => { refreshPromise = null; }); return refreshPromise;
  }
  async function promptReload() {
    const choice = await vscode.window.showInformationMessage(`Codex is now using ${statusLabel(mode)}. Reload VS Code so the Codex panel uses the new sign-in for its next request?`, RELOAD, LATER);
    if (choice === RELOAD) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
  async function apiKey() {
    const remembered = await context.secrets.get(SECRET_KEY); if (remembered) return remembered;
    const entered = await vscode.window.showInputBox({title: 'Codex API key', prompt: 'Stored only in VS Code Secret Storage on this device.', password: true, ignoreFocusOut: true, validateInput: value => value.trim().length < 20 || /\s/.test(value) ? 'Enter a valid OpenAI API key.' : undefined});
    return entered?.trim() || null;
  }
  async function change(target) {
    if (!MODES.has(target) || changing) return;
    await refresh(); if (mode === target) { if (reloadPending) await promptReload(); return; }
    if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage('Trust this VS Code window before changing Codex sign-in.'); return; }
    const executable = officialCli(); if (!executable) { await vscode.window.showErrorMessage('The official OpenAI Codex extension for this platform was not found.'); return; }
    changing = true; draw(); let result, key = null;
    try { result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: target === 'api' ? 'Codex API sign-in' : 'Complete ChatGPT sign-in in your browser', cancellable: false}, async () => {
      if (target === 'api') { key = await apiKey(); if (!key) return {ok: false, cancelled: true}; return runCli(executable, ['login', '--with-api-key'], key); }
      return runCli(executable, ['login']);
    }); } finally { changing = false; }
    if (result?.cancelled) { draw(); return; }
    await refresh(); if (!result?.ok || mode !== target) { draw(); await vscode.window.showErrorMessage('Codex sign-in was not confirmed. Current credentials were kept.'); return; }
    if (target === 'api' && key) await context.secrets.store(SECRET_KEY, key);
    reloadPending = true; draw(); await promptReload();
  }
  async function menu() {
    await refresh(); const choice = await vscode.window.showQuickPick([
      {label: '$(key) API', description: mode === 'api' ? 'Current saved sign-in' : 'Use API billing', mode: 'api'},
      {label: '$(account) ChatGPT subscription', description: mode === 'chatgpt' ? 'Current saved sign-in' : 'Use ChatGPT subscription', mode: 'chatgpt'},
      ...(reloadPending ? [{label: '$(refresh) Reload VS Code', description: 'Apply the saved sign-in to Codex panel', mode: 'reload'}] : [])
    ], {title: 'Codex sign-in', placeHolder: 'Switch between requests; an active request stays on its original billing method.'});
    if (!choice) return; if (choice.mode === 'reload') return promptReload(); return change(choice.mode);
  }
  context.subscriptions.push(item, vscode.commands.registerCommand('wedoCodexAuth.switch', menu), vscode.commands.registerCommand('wedoCodexAuth.api', () => change('api')), vscode.commands.registerCommand('wedoCodexAuth.chatgpt', () => change('chatgpt')), vscode.commands.registerCommand('wedoCodexAuth.refresh', refresh), vscode.window.onDidChangeWindowState(state => { if (state.focused) void refresh(); }), {dispose() { disposed = true;}});
  draw(); void refresh();
}

module.exports = {activate, parseMode, platformFolder};
