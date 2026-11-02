using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Threading.Tasks;
using File = WindowsFile;
using Directory = WindowsDirectory;
using FileStream = WindowsFileStream;

// This launcher validates immutable program files and compatibility before starting any data writer.
static class Launcher {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
    static readonly HashSet<string> CheckedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static void Emit(string text, bool error = false) {
        byte[] bytes = new UTF8Encoding(false).GetBytes(text + "\n");
        var output = error ? Console.OpenStandardError() : Console.OpenStandardOutput(); output.Write(bytes, 0, bytes.Length); output.Flush();
    }
    internal static string Text(IDictionary<string,object> value, string key) {
        object item; if (!value.TryGetValue(key, out item) || !(item is string)) throw new IOException("程序标识缺少有效字段：" + key);
        return (string)item;
    }
    internal static IDictionary<string,object> Read(string file) { return Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file, Encoding.UTF8)); }
    internal static bool FormatOne(object value) { return value is int && (int)value == 1; }
    internal static string Hash(string file) {
        using (var sha = new SHA256Cng()) using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024)) {
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
    }
    internal static void NoLinks(string file, string root) {
        string current = Path.GetFullPath(file); root = Path.GetFullPath(root);
        while (true) {
            if (CheckedPaths.Contains(current)) break;
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("程序或数据路径不能经过目录链接。");
            CheckedPaths.Add(current);
            if (String.Equals(current, root, StringComparison.OrdinalIgnoreCase)) break;
            current = Path.GetDirectoryName(current); if (current == null) throw new IOException("路径越过便携目录。");
        }
    }
    internal static string Safe(string root, string name) {
        root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        if (String.IsNullOrEmpty(name) || name.Contains("\\") || name.Contains(":") || name.Split('/').Any(p => p.Length == 0 || p == "." || p == ".." || p.EndsWith(".") || p.EndsWith(" "))) throw new IOException("程序校验路径无效。");
        string result = Path.GetFullPath(Path.Combine(root, name.Replace('/', Path.DirectorySeparatorChar)));
        if (!result.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("程序校验路径越界。");
        return result;
    }
    internal static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
            result.Append('\\', slashes); result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    internal static void CheckData(string root, IDictionary<string,object> manifest) {
        if (File.Exists(Path.Combine(root, ".maintenance-transaction.json"))) throw new IOException("尚有未完成的数据维护，已停止启动；原数据未转换。");
        string data = Path.Combine(root, "data"), stateFile = Path.Combine(data, "portable-state.json");
        if (!Directory.Exists(data)) return;
        NoLinks(data, root);
        if (!File.Exists(stateFile)) {
            if (Directory.EnumerateFileSystemEntries(data).Any()) throw new IOException("现有 data 缺少格式记录，已停止启动；不会初始化或覆盖原数据。");
            return;
        }
        NoLinks(stateFile, root); var state = Read(stateFile); object format, roots, contract;
        if (!state.TryGetValue("format", out format) || !FormatOne(format) || !state.TryGetValue("roots", out roots) || !(roots is IList) || ((IList)roots).Cast<object>().Any(item => !(item is string))) throw new IOException("数据格式记录损坏，已停止启动。");
        object programs; if (state.TryGetValue("programRoots", out programs) && (!(programs is IList) || ((IList)programs).Cast<object>().Any(item => !(item is string)))) throw new IOException("程序路径记录损坏，已停止启动。");
        if (!state.TryGetValue("dataContract", out contract)) {
            object legacy, release;
            if (manifest.TryGetValue("legacyPortableReleases", out legacy) && legacy is IList && state.TryGetValue("release", out release) && ((IList)legacy).Contains(release)) contract = Text(manifest, "dataContract");
        }
        if (!(contract is string) || (string)contract != Text(manifest, "dataContract")) throw new IOException("此更新与现有数据格式不兼容，已停止启动；原数据未修改。请使用兼容的数据格式版本。");
    }
    internal static string Verify(string root, StartupWindow waiting = null, Action<string,int,int> progress = null) {
        if (File.Exists(Path.Combine(root, "app/.update.pending.json"))) throw new IOException("程序更新尚未完成，请打开 DSH 维护工具完成更新；data 保持原位。");
        return VerifyProgram(root, Read(MaintenanceEngine.Pointer(root)), null, true, waiting, progress);
    }
    internal static string VerifyProgram(string root, IDictionary<string,object> pointer, string programOverride, bool checkData, StartupWindow waiting = null, Action<string,int,int> progress = null) {
        CheckedPaths.Clear();
        NoLinks(root, root);
        string pointerFile = MaintenanceEngine.Pointer(root); NoLinks(pointerFile, root);
        if (Text(pointer, "layout") != "versioned-1" || !FormatOne(pointer["launcherProtocol"])) throw new IOException("程序启动格式不受支持。");
        string relative = Text(pointer, "program");
        if (!System.Text.RegularExpressions.Regex.IsMatch(relative, @"\Aapp/[A-Za-z0-9._-]+\z")) throw new IOException("程序目录标识无效。");
        string program = programOverride ?? Safe(root, relative); NoLinks(program, root);
        string index = Path.Combine(program, "checksums.json"); NoLinks(index, root);
        if (Hash(index) != Text(pointer, "programManifestSha256")) throw new IOException("更新清单不完整，请重新覆盖完整更新包；不要删除 data。");
        var inventory = Read(index); object files;
        if (!FormatOne(inventory["format"]) || !inventory.TryGetValue("files", out files) || !(files is IList) || ((IList)files).Count == 0) throw new IOException("程序校验清单无效。");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int checkedFiles = 0, fileCount = ((IList)files).Count;
        foreach (object item in (IList)files) {
            var entry = item as IDictionary<string,object>; if (entry == null) throw new IOException("程序校验条目无效。");
            string name = Text(entry, "path"), file = Safe(program, name);
            try {
                NoLinks(file, root);
                if (!seen.Add(file) || !File.Exists(file) || WindowsPaths.Length(file) != Convert.ToInt64(entry["bytes"]) || Hash(file) != Text(entry, "sha256")) throw new IOException("程序文件缺失、无法读取或校验不符：" + name + "\n请使用完整便携 ZIP 重新解压或在维护中心安装，保留 data。");
            } catch (DirectoryNotFoundException error) { throw MissingFile(name, file, error); }
              catch (FileNotFoundException error) { throw MissingFile(name, file, error); }
            checkedFiles++;
            if (checkedFiles % 64 == 0 || checkedFiles == fileCount) {
                if (waiting != null) waiting.Update("正在检查启动文件  " + checkedFiles + " / " + fileCount, checkedFiles, fileCount);
                if (progress != null) progress(name, checkedFiles, fileCount);
            }
        }
        string manifestFile = Path.Combine(program, "portable.json"); NoLinks(manifestFile, root); var manifest = Read(manifestFile);
        if (!seen.Contains(manifestFile) || !seen.Contains(Path.Combine(program, "DSH Portable.exe")) || !FormatOne(manifest["payloadLayout"]) || Text(manifest, "portableVersion") != Text(pointer, "portableVersion") || Text(manifest, "dataContract") != Text(pointer, "dataContract")) throw new IOException("程序更新尚未完整覆盖，已停止启动。");
        if (checkData) CheckData(root, manifest); return program;
    }
    static IOException MissingFile(string name, string fullPath, Exception error) {
        return new IOException("程序包缺少文件：" + name + "\n完整路径：" + fullPath + "\n解压工具可能跳过了长路径文件。请使用新版完整版重新解压，或在维护中心安装完整版；保留 data。", error);
    }
    [STAThread]
    public static int Main(string[] args) {
        bool diagnostic = args.Length > 0 && args[0].StartsWith("--portable-");
        try {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            UiKit.Initialize();
            string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);
            if (Path.GetFileNameWithoutExtension(Application.ExecutablePath) == "DSH 维护工具"
                && args.Length == 1 && new[] { "--help", "-h", "/?" }.Contains(args[0])) {
                Emit("DSH 维护工具\n直接启动：打开维护界面\n--portable-verify：检查程序完整性\n--portable-apply-update <ZIP>：安装兼容覆盖更新包\n--portable-resume-update：继续未完成的程序更新");
                return 0;
            }
            if (args.Length > 0 && args[0] == "--finish-update") return MaintenanceEngine.Finish(args[1], args.Length > 2 ? args[2] : null);
            if (args.Length > 0 && args[0] == "--portable-apply-update") { MaintenanceEngine.Prepare(root, args[1], true); return 0; }
            if (args.Length > 0 && args[0] == "--portable-resume-update") { MaintenanceEngine.Resume(root); return 0; }
            if (args.Length > 0 && args[0] == "--portable-maintenance-check-smoke") return MaintenanceForm.Smoke(root, args[1], true);
            if (args.Length > 0 && args[0] == "--portable-maintenance-smoke") return MaintenanceForm.Smoke(root, args[1]);
            if (args.Length > 0 && args[0] == "--portable-startup-smoke") return StartupWindow.Smoke(args[1]);
            if(args.Length==2&&args[0]=="--portable-maintenance-host"){root=Path.GetFullPath(args[1]);Application.Run(new MaintenanceForm(root));return 0;}
            if (Path.GetFileNameWithoutExtension(Application.ExecutablePath) == "DSH 维护工具" || (args.Length > 0 && args[0] == "--portable-maintenance-ui")) {
                MaintenanceEngine.OpenHost(root); return 0;
            }
            using (var waiting = diagnostic ? null : new StartupWindow())
            using (FileStream programLock = MaintenanceEngine.ReadLock(root)) return Run(root, args, waiting);
        } catch (Exception error) {
            Emit("DSH portable update: " + error.Message, true);
            if (!diagnostic) MessageBox.Show(error.Message + "\n\n请保留 data。可打开 DSH 维护工具检查或重新安装兼容更新。", "DSH 便携版未能启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
    static int Run(string root, string[] args, StartupWindow waiting) {
            string program = Verify(root, waiting);
            if (args.Length > 0 && args[0] == "--portable-probe") { Emit(Json.Serialize(new { ok = true, program = program, dataUntouched = true })); return 0; }
            string executable = Path.Combine(program, "DSH Portable.exe"); var argv = new List<string>(); bool cli = false;
            if (args.Length > 0 && args[0] == "--portable-cli") {
                cli = true; argv.Add("--expose-internals"); argv.Add(Path.Combine(program, "resources/portable/cli-bootstrap.cjs")); argv.AddRange(args.Skip(1));
            } else if (args.Length > 0 && (args[0] == "--portable-verify" || args[0] == "--portable-maintenance")) {
                executable = Path.Combine(program, "resources/runtime/primary-runtime/dependencies/node/bin/node.exe");
                if (args[0] == "--portable-verify") argv.Add(Path.Combine(program, "resources/portable/verify-install.cjs"));
                else { argv.Add(Path.Combine(program, "resources/portable/maintenance.cjs")); argv.Add(args.Length > 1 ? args[1] : ""); argv.Add(root); argv.AddRange(args.Skip(2)); }
            } else argv.AddRange(args);
            var start = new ProcessStartInfo { FileName = executable, Arguments = String.Join(" ", argv.Select(Quote)), WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.EnvironmentVariables.Remove("NODE_OPTIONS"); start.EnvironmentVariables.Remove("NODE_PATH"); start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            if (cli) start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            using (Process child = Process.Start(start)) {
                if (child == null) throw new IOException("未能启动程序。");
                if (waiting != null) waiting.UntilVisible(child);
                Task stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                Task stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                Task.Run(async () => {
                    try { await Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream); }
                    catch (IOException closedInput) { /* The child may exit before the caller closes stdin. */ }
                    catch (ObjectDisposedException closedChild) { /* Process shutdown closes its input stream. */ }
                    finally { try { child.StandardInput.Close(); } catch (InvalidOperationException closedProcess) { /* The child has exited. */ } }
                });
                child.WaitForExit(); Task.WaitAll(stdout, stderr); return child.ExitCode;
            }
    }
}
