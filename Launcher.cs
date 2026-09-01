using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AntigravityFingerprintBrowser
{
    static class Program
    {
        private const string AppGuid = "Global\\Antigravity_Fingerprint_Browser_Studio_2026";
        private const int Port = 3000;
        private const string Host = "127.0.0.1";
        private static readonly string TargetUrl = string.Format("http://{0}:{1}", Host, Port);

        private static Mutex mutex = null;
        private static NotifyIcon trayIcon = null;
        private static Process backendProcess = null;

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [STAThread]
        static void Main()
        {
            bool createdNew;
            mutex = new Mutex(true, AppGuid, out createdNew);

            if (!createdNew)
            {
                // 已经有实例在运行，直接唤醒并打开窗口
                LaunchAppWindow(TargetUrl);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // 1. 初始化托盘图标
            InitializeTray();

            // 2. 启动后台引擎守护线程
            ThreadPool.QueueUserWorkItem((state) =>
            {
                EnsureBackendRunning();
                LaunchAppWindow(TargetUrl);
            });

            Application.Run();
        }

        private static void InitializeTray()
        {
            trayIcon = new NotifyIcon();
            trayIcon.Text = "👑 Antigravity 商业级指纹浏览器";
            trayIcon.Icon = SystemIcons.Shield; // 原生安全盾牌图标
            trayIcon.Visible = true;

            ContextMenu menu = new ContextMenu();
            menu.MenuItems.Add("🚀 打开指纹浏览器工作台", (s, e) => LaunchAppWindow(TargetUrl));
            menu.MenuItems.Add("🌐 快速直达 AI 对话", (s, e) => LaunchAppWindow("https://chat.deepseek.com/"));
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("❌ 彻底退出系统", (s, e) =>
            {
                trayIcon.Visible = false;
                if (backendProcess != null && !backendProcess.HasExited)
                {
                    try { backendProcess.Kill(); } catch { }
                }
                Application.Exit();
                Environment.Exit(0);
            });

            trayIcon.ContextMenu = menu;
            trayIcon.DoubleClick += (s, e) => LaunchAppWindow(TargetUrl);
        }

        private static void EnsureBackendRunning()
        {
            if (CheckHealth()) return;

            string appDir = AppDomain.CurrentDomain.BaseDirectory;

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = "/c npm run studio";
            psi.WorkingDirectory = appDir;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;

            try
            {
                backendProcess = Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动后台引擎失败: " + ex.Message, "指纹浏览器启动提示", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            // 等待后台 HTTP 端口就绪
            for (int i = 0; i < 30; i++)
            {
                Thread.Sleep(500);
                if (CheckHealth())
                {
                    break;
                }
            }
        }

        private static bool CheckHealth()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(string.Format("http://{0}:{1}/api/v1/health", Host, Port));
                req.Timeout = 800;
                req.Method = "GET";
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        public static void LaunchAppWindow(string url)
        {
            string[] possibleLaunchers = new string[]
            {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                @"D:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"D:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"D:\Program Files\Google\Chrome\Application\chrome.exe",
                @"D:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
            };

            string launcher = null;
            foreach (string path in possibleLaunchers)
            {
                if (!string.IsNullOrEmpty(path) && File.Exists(path))
                {
                    launcher = path;
                    break;
                }
            }

            if (!string.IsNullOrEmpty(launcher))
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = launcher;
                psi.Arguments = string.Format("--app={0} --window-size=1366,860 --disable-extensions --no-first-run --no-default-browser-check", url);
                psi.UseShellExecute = false;
                try
                {
                    Process.Start(psi);
                    return;
                }
                catch { }
            }

            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                return;
            }
            catch { }

            try
            {
                ProcessStartInfo cmdPsi = new ProcessStartInfo("cmd.exe", string.Format("/c start \"\" \"{0}\"", url));
                cmdPsi.CreateNoWindow = true;
                cmdPsi.WindowStyle = ProcessWindowStyle.Hidden;
                cmdPsi.UseShellExecute = false;
                Process.Start(cmdPsi);
            }
            catch { }
        }
    }
}
