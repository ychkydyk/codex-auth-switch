param([ValidateSet('Api','ChatGPT','Status')][string]$Mode='Status',[switch]$FromVSCode,[switch]$UseSavedKey)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$codexUserRoot=Join-Path $env:USERPROFILE '.codex'
$localStore=Join-Path $env:LOCALAPPDATA 'WedoCodexAuth'
$encryptedKeyPath=Join-Path $localStore 'api-key.dpapi'
$receiptPath='C:\Clodex\setup\codex-auth-switch-20261101\status.json'
$extension=Get-ChildItem (Join-Path $env:USERPROFILE '.vscode\extensions') -Directory -Filter 'openai.chatgpt-*-win32-x64' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if(-not $extension){throw 'Installed OpenAI Codex extension not found.'}
$codexExe=Join-Path $extension.FullName 'bin\windows-x86_64\codex.exe'
if(-not(Test-Path -LiteralPath $codexExe)){throw 'Bundled Codex CLI not found.'}

function Save-Status([string]$status,[string]$message){
    New-Item -ItemType Directory -Force -Path (Split-Path $receiptPath) | Out-Null
    @{updated_utc=[DateTime]::UtcNow.ToString('o');status=$status;message=$message;mode_requested=$Mode;credentials_in_workspace=$false} | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8
}
function Invoke-Codex([string]$arguments,[string]$inputSecret=''){
    $info=New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName=$codexExe;$info.Arguments=$arguments;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.EnvironmentVariables['CODEX_HOME']=$codexUserRoot
    $process=New-Object System.Diagnostics.Process;$process.StartInfo=$info
    [void]$process.Start()
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if($inputSecret){$process.StandardInput.WriteLine($inputSecret)}
    $process.StandardInput.Close();$process.WaitForExit()
    # Never print CLI auth output, which can include a key prefix or OAuth URL.
    $output=$stdout.Result+' '+$stderr.Result
    return @{exit=$process.ExitCode;output=$output}
}
function Read-AuthStatus {
    $result=Invoke-Codex 'login status'
    if($result.exit-ne 0){return 'signed_out'}
    if($result.output -match '(?i)api key|api_key|apikey'){return 'api'}
    if($result.output -match '(?i)chatgpt'){return 'chatgpt'}
    return 'unknown'
}
if($Mode-eq'Status'){
    $status=Read-AuthStatus;Save-Status $status 'Read-only login status.'
    Write-Output ('Codex authentication: '+$status);exit
}
if($Mode-eq'ChatGPT'){
    Save-Status 'waiting_chatgpt_login' 'Complete the official browser login.'
    if(-not $FromVSCode){[System.Windows.Forms.MessageBox]::Show('The official ChatGPT login will open in your browser. After login, reload the VS Code window before continuing the chat.','Codex: ChatGPT') | Out-Null}
    $result=Invoke-Codex 'login'
    $status=Read-AuthStatus;Save-Status $status 'Official ChatGPT login completed; reload VS Code to refresh the extension.'
    if($result.exit-ne 0 -or $status-ne'chatgpt'){throw 'ChatGPT login not confirmed. Use the Codex profile menu to sign in.'}
    Write-Output 'ChatGPT login confirmed. VS Code: Developer: Reload Window.';exit
}

$form=New-Object System.Windows.Forms.Form
$form.Text='Codex API login';$form.ClientSize=New-Object System.Drawing.Size(590,255);$form.StartPosition='CenterScreen';$form.TopMost=$true;$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false
$label=New-Object System.Windows.Forms.Label
$label.Text='Enter an OpenAI Platform project API key locally. Never paste it into chat.';$label.SetBounds(18,15,555,35)
$keyBox=New-Object System.Windows.Forms.TextBox;$keyBox.UseSystemPasswordChar=$true;$keyBox.SetBounds(18,56,550,26)
$remember=New-Object System.Windows.Forms.CheckBox;$remember.Text='Remember encrypted for this Windows user (fast API switch)';$remember.Checked=$true;$remember.SetBounds(18,95,550,25)
$saved=Test-Path -LiteralPath $encryptedKeyPath
$hint=New-Object System.Windows.Forms.Label;$hint.SetBounds(18,126,550,43)
$hint.Text=if($saved){'A saved encrypted key exists. Leave the field empty to reuse it.'}else{'No saved key. Create a key in the official OpenAI Platform dashboard.'}
$link=New-Object System.Windows.Forms.LinkLabel;$link.Text='Open OpenAI API keys';$link.SetBounds(18,179,245,25)
$link.Add_LinkClicked({Start-Process 'https://platform.openai.com/api-keys'})
$connect=New-Object System.Windows.Forms.Button;$connect.Text='Connect API';$connect.SetBounds(332,200,115,32);$connect.DialogResult='OK'
$cancel=New-Object System.Windows.Forms.Button;$cancel.Text='Cancel';$cancel.SetBounds(453,200,115,32);$cancel.DialogResult='Cancel'
$form.Controls.AddRange(@($label,$keyBox,$remember,$hint,$link,$connect,$cancel));$form.AcceptButton=$connect;$form.CancelButton=$cancel
Save-Status 'waiting_api_key' 'Local masked API-key dialog is open; current ChatGPT login is unchanged.'
if(-not($UseSavedKey -and $saved)){
    if($form.ShowDialog()-ne'OK'){Save-Status 'unchanged' 'User closed API login; existing credentials preserved.';$form.Dispose();exit 2}
}
$plain=$null;$secure=$null;$ptr=[IntPtr]::Zero
try{
    if($keyBox.Text.Trim()){$plain=$keyBox.Text.Trim();$secure=ConvertTo-SecureString $plain -AsPlainText -Force}
    elseif($saved){$secure=Get-Content -LiteralPath $encryptedKeyPath -Raw | ConvertTo-SecureString;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);$plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
    else{throw 'No API key was entered.'}
    $rememberKey=$remember.Checked
    $keyBox.Clear();$form.Dispose()
    if($plain.Length-lt 20 -or $plain-match'\s'){throw 'Invalid API-key format.'}
    # Read-only account validation; no inference, no paid generation.
    try{$response=Invoke-WebRequest -Uri 'https://api.openai.com/v1/models' -Headers @{Authorization=('Bearer '+$plain)} -UseBasicParsing -TimeoutSec 30}
    catch{throw 'API validation failed. Check the key, project permissions, and connection. Existing login was not changed.'}
    if($response.StatusCode-ne 200){throw 'API key validation was not successful.'}
    $result=Invoke-Codex 'login --with-api-key' $plain
    if($result.exit-ne 0){throw 'Codex API login failed. No credential output was logged.'}
    $status=Read-AuthStatus
    if($status-ne'api'){throw 'API login is not confirmed. Check the Codex profile menu.'}
    if($rememberKey){New-Item -ItemType Directory -Force -Path $localStore | Out-Null; $secure | ConvertFrom-SecureString | Set-Content -LiteralPath $encryptedKeyPath -Encoding ASCII}
    Save-Status 'api' 'API login confirmed. Reload VS Code before continuing. No billable inference was submitted by this helper.'
    if(-not $FromVSCode){[System.Windows.Forms.MessageBox]::Show('API login confirmed. In VS Code run Developer: Reload Window, then reopen the chat. API usage is billed separately from the ChatGPT subscription.','Codex: API ready') | Out-Null}
    Write-Output 'API login confirmed. VS Code: Developer: Reload Window.'
}catch{
    Save-Status 'error' 'Authentication failed. No credential output was recorded.'
    if(-not $FromVSCode){[System.Windows.Forms.MessageBox]::Show('Authentication failed. Check the key, project permissions or browser login.','Codex login') | Out-Null}
    exit 1
}finally{
    if($ptr-ne[IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
    $plain=$null;if($secure){$secure.Dispose()}
}
