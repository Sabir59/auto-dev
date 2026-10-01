# Test helper: operates the real "Choose a workspace folder" dialog the way a person would (type a
# folder in the Folder box and press Select Folder, or press Cancel), without moving the mouse.
# Controls are found with UI Automation and driven with their own window messages (WM_SETTEXT,
# BM_CLICK): this dialog exposes its buttons as plain panes, without an Invoke pattern.
#   powershell -NoProfile -File dialog-driver.ps1 select "C:\path\to\folder"
#   powershell -NoProfile -File dialog-driver.ps1 cancel
param([string]$Mode, [string]$Folder)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr SendMessage(System.IntPtr h, uint m, System.IntPtr w, string l);'
$AE = [System.Windows.Automation.AutomationElement]; $S = [System.Windows.Automation.TreeScope]
$cond = { param($name, $class) New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)),
  (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, $class))) }
$deadline = (Get-Date).AddSeconds(20); $dlg = $null
while (-not $dlg -and (Get-Date) -lt $deadline) {
  $dlg = $AE::RootElement.FindFirst($S::Descendants, (& $cond "Choose a workspace folder" "#32770"))
  if (-not $dlg) { Start-Sleep -Milliseconds 300 }
}
if (-not $dlg) { Write-Output "dialog not found"; exit 1 }
Start-Sleep -Milliseconds 500
$hwnd = { param($name, $class) $el = $dlg.FindFirst($S::Descendants, (& $cond $name $class)); if (-not $el) { throw "no '$name' ($class) in the dialog" }; [IntPtr]$el.Current.NativeWindowHandle }
if ($Mode -eq "cancel") {
  [U.W]::SendMessage((& $hwnd "Cancel" "Button"), 0x00F5, [IntPtr]::Zero, $null) | Out-Null
  Write-Output "pressed Cancel"
} else {
  # The Folder box is the classic file-dialog edit control (id 1152); it has no accessible name.
  $edit = $dlg.FindFirst($S::Descendants, (New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "1152")),
    (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, "Edit")))))
  [U.W]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, $Folder) | Out-Null
  [U.W]::SendMessage((& $hwnd "Select Folder" "Button"), 0x00F5, [IntPtr]::Zero, $null) | Out-Null
  Write-Output "typed folder and pressed Select Folder"
}
