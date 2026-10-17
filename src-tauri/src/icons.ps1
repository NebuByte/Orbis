# Orbis: save Start-menu app icons as transparent PNGs (desktop and Store apps alike), using the
# shell's own image factory on shell:AppsFolder\<AppID>. Called by Orbis with a JSON job file:
#   [{ "id": "<AppID>", "file": "<png path>" }, ...]
param([Parameter(Mandatory)][string]$Job, [int]$Size = 48)
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class OrbisIcon {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; public SIZE(int x, int y) { cx = x; cy = y; } }
  [StructLayout(LayoutKind.Sequential)] struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public ushort bmPlanes, bmBitsPixel; public IntPtr bmBits; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);
  [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int c, out BITMAP bm);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  public static bool Save(string parse, string file, int px) {
    IShellItemImageFactory f;
    SHCreateItemFromParsingName(parse, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
    IntPtr h;
    if (f.GetImage(new SIZE(px, px), 0x4 /* icon only */, out h) != 0) return false;
    try {
      BITMAP bm; GetObject(h, Marshal.SizeOf(typeof(BITMAP)), out bm);
      if (bm.bmBits == IntPtr.Zero || bm.bmBitsPixel != 32) return false;
      // keep the alpha channel: wrap the DIB's own pixels (premultiplied), then copy out
      using (var src = new Bitmap(bm.bmWidth, bm.bmHeight, bm.bmWidthBytes, PixelFormat.Format32bppPArgb, bm.bmBits))
      using (var dst = new Bitmap(src)) { dst.RotateFlip(RotateFlipType.RotateNoneFlipY); dst.Save(file, ImageFormat.Png); }
      return true;
    } finally { DeleteObject(h); }
  }
}
'@
$ok = 0
foreach ($it in (Get-Content -LiteralPath $Job -Raw | ConvertFrom-Json)) {
  $saved = $false
  try { $saved = [OrbisIcon]::Save('shell:AppsFolder\' + $it.id, $it.file, $Size) } catch { }
  if ($saved) { $ok++ } else { New-Item -ItemType File -Force -Path $it.file | Out-Null }   # no icon: don't ask again
}
"saved $ok"
