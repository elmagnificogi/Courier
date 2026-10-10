$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
namespace CourierCodexLaunch {
  public enum ActivateOptions {
    None = 0
  }
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IApplicationActivationManager {
    void ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, ActivateOptions options, out uint processId);
    void ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
    void ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, out uint processId);
  }
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  public class ApplicationActivationManager : IApplicationActivationManager {
    [MethodImpl(MethodImplOptions.InternalCall)]
    public extern void ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, ActivateOptions options, out uint processId);
    [MethodImpl(MethodImplOptions.InternalCall)]
    public extern void ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
    [MethodImpl(MethodImplOptions.InternalCall)]
    public extern void ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, out uint processId);
  }
}
"@

function Show-Note([string]$message) {
  [System.Windows.Forms.MessageBox]::Show(
    $message,
    "Codex debug",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  ) | Out-Null
}

$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if (-not $package) {
  Show-Note "OpenAI Codex is not installed from the Microsoft Store."
  exit 1
}

$family = $package.PackageFamilyName
$aumid = "$family!App"
$arguments = "--remote-debugging-port=9225 --remote-allow-origins=*"
$processId = [uint32]0
$manager = New-Object CourierCodexLaunch.ApplicationActivationManager
try {
  $manager.ActivateApplication($aumid, $arguments, [CourierCodexLaunch.ActivateOptions]::None, [ref]$processId)
} catch {
  Show-Note ("Codex failed to start: {0}" -f $_.Exception.Message)
  exit 1
}

exit 0
