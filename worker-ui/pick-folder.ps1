# Shows the standard Windows "Select Folder" dialog on this computer's desktop and prints the
# chosen folder's path as JSON: {"path":"C:\\..."} or {"cancelled":true}. Nothing is read from or
# copied out of the folder; the console only receives its path and validates it as usual.
#   powershell -NoProfile -STA -File pick-folder.ps1
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCom {}

[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFileDialog {
  [PreserveSig] int Show(IntPtr parent);
  void SetFileTypes(uint n, IntPtr spec); void SetFileTypeIndex(uint i); void GetFileTypeIndex(out uint i);
  void Advise(IntPtr sink, out uint cookie); void Unadvise(uint cookie);
  void SetOptions(uint fos); void GetOptions(out uint fos);
  void SetDefaultFolder(IShellItem si); void SetFolder(IShellItem si); void GetFolder(out IShellItem si);
  void GetCurrentSelection(out IShellItem si);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string s); void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string s);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string s); void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string s);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string s);
  void GetResult(out IShellItem si);
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem {
  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
  void GetParent(out IShellItem si);
  void GetDisplayName(uint sigdn, out IntPtr name);
}

public static class FolderPicker {
  const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_NOCHANGEDIR = 0x8, FOS_PATHMUSTEXIST = 0x800;
  const uint SIGDN_FILESYSPATH = 0x80058000;
  public static string Pick(string title) {
    var dlg = (IFileDialog)new FileOpenDialogCom();
    uint fos; dlg.GetOptions(out fos);
    dlg.SetOptions(fos | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR | FOS_PATHMUSTEXIST);
    dlg.SetTitle(title);
    // An invisible topmost owner, so the dialog opens in front of the browser rather than behind it.
    using (var owner = new Form { TopMost = true, ShowInTaskbar = false, Opacity = 0, FormBorderStyle = FormBorderStyle.None, Width = 1, Height = 1, StartPosition = FormStartPosition.CenterScreen }) {
      owner.Show(); owner.Activate();
      int hr = dlg.Show(owner.Handle);
      if (hr != 0) return null; // cancelled (or closed)
    }
    IShellItem item; dlg.GetResult(out item);
    IntPtr p; item.GetDisplayName(SIGDN_FILESYSPATH, out p);
    try { return Marshal.PtrToStringUni(p); } finally { Marshal.FreeCoTaskMem(p); }
  }
}
"@
$path = [FolderPicker]::Pick("Choose a workspace folder")
if ($null -eq $path) { '{"cancelled":true}' } else { ConvertTo-Json -Compress @{ path = $path } }
