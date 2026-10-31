const vscode = require('vscode');
const {execFile, spawn} = require('node:child_process');
const path = require('node:path');

// No secret files are read by JavaScript; official CLI reports the stored auth mode.
const parseMode = output => /api key|api_key|apikey/i.test(output) ? 'api' : /chatgpt/i.test(output) ? 'chatgpt' : 'unknown';
const label = mode => ({api:'API',chatgpt:'Подписка',signed_out:'Нет входа',unknown:'Проверить вход'})[mode];
const RELOAD='Перезагрузить сейчас', LATER='Позже';

function activate(context) {
  let storedMode='unknown', busy=false, pendingReload=false, disposed=false, refreshInFlight=null;
  let initialMode=null;
  const item=vscode.window.createStatusBarItem('wedoCodexAuth.mode',vscode.StatusBarAlignment.Right,1000);
  item.name='Codex: API / Подписка';item.command='wedoCodexAuth.switch';
  function draw(){
    item.text=busy?'$(sync~spin) Codex: вход…':`$(account) Codex: ${label(storedMode)}${pendingReload?' ↻':''}`;
    item.tooltip=`Сохранённый вход Codex: ${label(storedMode)}.\nНажмите для выбора API / подписки.${pendingReload?'\nВход изменён. Перезагрузите окно для обновления расширения.':''}\nЭто статус входа CLI, а не подтверждение биллинга выполняющегося запроса.`;
    item.accessibilityInformation={label:`Codex, ${label(storedMode)}${pendingReload?', ожидает перезагрузки':''}`};
    item.show();
  }
  function cliPath(){
    const extension=vscode.extensions.getExtension('openai.chatgpt');
    if(!extension||process.platform!=='win32')return null;
    return path.join(extension.extensionPath,'bin','windows-x86_64','codex.exe');
  }
  function refresh(){
    if(disposed||busy)return Promise.resolve(storedMode);
    if(refreshInFlight)return refreshInFlight;
    const executable=cliPath();
    if(!executable){storedMode='unknown';draw();return Promise.resolve(storedMode);}
    refreshInFlight=new Promise(resolve=>execFile(executable,['login','status'],{windowsHide:true,timeout:15000,maxBuffer:32768},(error,stdout,stderr)=>{
      if(!disposed){
        storedMode=error?(error.code===1?'signed_out':'unknown'):parseMode(String(stdout)+' '+String(stderr));
        if(initialMode===null)initialMode=storedMode;
        else if(storedMode!==initialMode&&storedMode!=='unknown')pendingReload=true;
        draw();
      }
      // Never log stdout/stderr: API status can contain part of a secret.
      resolve(storedMode);
    })).finally(()=>{refreshInFlight=null;});
    return refreshInFlight;
  }
  async function offerReload(){
    const choice=await vscode.window.showInformationMessage(`Вход Codex: ${label(storedMode)}. Перезагрузить окно, чтобы расширение перечитало вход? Дождитесь окончания текущего ответа.`,RELOAD,LATER);
    if(choice===RELOAD)await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
  async function change(mode){
    if(busy)return;
    await refresh();
    if(storedMode===mode){
      if(pendingReload)await offerReload();
      else await vscode.window.showInformationMessage(`Сохранённый вход уже ${label(mode)}.`, 'OK');
      return;
    }
    if(!vscode.workspace.isTrusted){await vscode.window.showWarningMessage('Переключение доступно в доверенном окне VS Code.');return;}
    if(!cliPath()){await vscode.window.showErrorMessage('Нужно локальное расширение OpenAI Codex для Windows.');return;}
    busy=true;draw();
    let code;
    try{
      code=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:mode==='api'?'Codex: вход через API':'Codex: завершите вход ChatGPT в браузере',cancellable:false},()=>new Promise((resolve,reject)=>{
        const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
        const args=['-NoProfile','-STA','-File',path.join(context.extensionPath,'switch-auth.ps1'),'-Mode',mode==='api'?'Api':'ChatGPT','-FromVSCode'];
        if(mode==='api')args.push('-UseSavedKey');
        const child=spawn(shell,args,{windowsHide:true,stdio:'ignore'});
        child.once('error',()=>reject(new Error('Не удалось запустить локальный вход Codex.')));
        child.once('exit',exitCode=>resolve(exitCode));
      }));
    }catch{
      busy=false;draw();
      await vscode.window.showErrorMessage('Не удалось запустить локальный вход Codex.');
      return;
    }finally{busy=false;}
    await refresh();
    if(code===2){draw();return;}
    if(code!==0||storedMode!==mode){await vscode.window.showErrorMessage('Смена входа не подтверждена. Проверьте ключ, доступ к API или завершение входа в браузере.');draw();return;}
    pendingReload=true;draw();await offerReload();
  }
  async function menu(){
    if(busy)return;
    await refresh();
    const choice=await vscode.window.showQuickPick([
      {label:'$(key) API',description:storedMode==='api'?'Сохранённый вход':'Оплата по API-балансу',mode:'api'},
      {label:'$(account) Подписка ChatGPT',description:storedMode==='chatgpt'?'Сохранённый вход':'Штатный вход через браузер',mode:'chatgpt'},
      ...(pendingReload?[{label:'$(refresh) Перезагрузить окно…',description:'С подтверждением',mode:'reload'}]:[]),
      {label:'$(info) Вход внутри Codex',description:'Открыть панель: меню аккаунта → Log out → другой способ входа',mode:'native'}
    ],{title:'Codex: способ оплаты',placeHolder:'Изменение вступает в силу для новых запросов после обновления входа расширения'});
    if(!choice)return;
    if(choice.mode==='reload'){await offerReload();return;}
    if(choice.mode==='native'){
      await vscode.commands.executeCommand('chatgpt.openSidebar');
      await vscode.window.showInformationMessage('В меню аккаунта Codex выберите Log out, затем Use API Key или Sign in with ChatGPT. Встроенный вход обновляет панель; текущий ответ сначала завершите.');return;
    }
    await change(choice.mode);
  }
  context.subscriptions.push(item,
    vscode.commands.registerCommand('wedoCodexAuth.switch',menu),
    vscode.commands.registerCommand('wedoCodexAuth.api',()=>change('api')),
    vscode.commands.registerCommand('wedoCodexAuth.chatgpt',()=>change('chatgpt')),
    vscode.commands.registerCommand('wedoCodexAuth.refresh',refresh),
    vscode.window.onDidChangeWindowState(state=>{if(state.focused)void refresh();}),
    vscode.tasks.onDidEndTaskProcess(async event=>{
      if(!['Codex: API','Codex: ChatGPT'].includes(event.execution.task.name)||event.exitCode!==0||busy)return;
      await refresh();if(pendingReload)await offerReload();
    }),
    {dispose(){disposed=true;}});
  draw();void refresh();
}
module.exports={activate,parseMode};
