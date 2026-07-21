// Compile with: csc /nologo /target:winexe /win32icon:icon.ico /out:LightKaTeXEditor.exe LightKaTeXEditorLauncher.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("Light KaTeX Editor")]
[assembly: AssemblyProduct("Light KaTeX Editor")]
[assembly: AssemblyDescription("Lightweight Markdown editor with KaTeX preview")]
[assembly: AssemblyCompany("Light KaTeX Editor")]
[assembly: AssemblyCopyright("Local build")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string launcherDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string root = Directory.GetParent(launcherDir).FullName;
            string electron = Path.Combine(root, "node_modules", "electron", "dist", "electron.exe");
            string mainJs = Path.Combine(root, "dist-electron", "main.js");

            if (!File.Exists(electron))
            {
                MessageBox.Show(
                    "找不到 Electron 运行时：\n" + electron + "\n\n请先在项目目录执行 npm install。",
                    "Light KaTeX Editor",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 1;
            }

            if (!File.Exists(mainJs))
            {
                MessageBox.Show(
                    "找不到应用构建产物：\n" + mainJs + "\n\n请先在项目目录执行 npm run build。",
                    "Light KaTeX Editor",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 1;
            }

            var sb = new StringBuilder();
            sb.Append("\".\"");
            foreach (string arg in args)
            {
                if (string.IsNullOrWhiteSpace(arg)) continue;
                sb.Append(' ');
                sb.Append('"');
                sb.Append(arg.Replace("\"", "\\\""));
                sb.Append('"');
            }

            var psi = new ProcessStartInfo
            {
                FileName = electron,
                Arguments = sb.ToString(),
                WorkingDirectory = root,
                UseShellExecute = false
            };
            Process.Start(psi);
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "启动失败：\n" + ex.Message,
                "Light KaTeX Editor",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }
}
