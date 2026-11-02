using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using File = WindowsFile;
using Directory = WindowsDirectory;
using FileStream = WindowsFileStream;

static class MaintenanceEngine {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool MoveFileExW(string from, string to, uint flags);
    public static string Pointer(string root) { string file = Path.Combine(root, "app/portable.json"); return File.Exists(file) ? file : Path.Combine(root, "portable.json"); }
    public static FileStream ReadLock(string root) {
        string app = Path.Combine(root, "app"); Directory.CreateDirectory(app); Launcher.NoLinks(app, root);
        string file = Path.Combine(app, ".program-use.lock");
        if (!File.Exists(file)) using (var created = new FileStream(file, FileMode.OpenOrCreate, FileAccess.Write, FileShare.ReadWrite)) { }
        try { return new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read); }
        catch (IOException error) { throw new IOException("维护工具正在处理程序文件，请稍后再启动 DSH。", error); }
    }
    sealed class Locks : IDisposable {
        FileStream program, data;
        public Locks(string root) {
            string app = Path.Combine(root, "app"); Directory.CreateDirectory(app); Launcher.NoLinks(app, root);
            try {
                program = new FileStream(Path.Combine(app, ".program-use.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                string file = Path.Combine(root, "data/.running.lock");
                if (File.Exists(file)) { Launcher.NoLinks(file, root); data = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
            } catch (IOException error) { Dispose(); throw new IOException("DSH 仍在运行或另一项维护尚未完成，请从托盘完整退出后重试。", error); }
        }
        public void Dispose() { if (data != null) data.Dispose(); if (program != null) program.Dispose(); }
    }
    public static void Atomic(string file, byte[] bytes) {
        string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
            if (!MoveFileExW(WindowsPaths.Extended(temporary), WindowsPaths.Extended(file), 9)) throw new IOException("文件正被占用，原文件未被替换。", new System.ComponentModel.Win32Exception());
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    static void AtomicJson(string file, object value) { Atomic(file, new UTF8Encoding(false).GetBytes(Json.Serialize(value))); }
    static string Pending(string root) { return Path.Combine(root, "app/.update.pending.json"); }
    static string Result(string root) { return Path.Combine(root, "app/.updates/result.json"); }
    static bool Allowed(string name, string program) {
        return name == program || name.StartsWith(program + "/", StringComparison.Ordinal)
            || name == "DSH Portable.exe" || name == "DSH 维护工具.exe"
            || name == "app/portable.json" || name == "app/checksums.json"
            || name == "app/说明与许可" || name.StartsWith("app/说明与许可/", StringComparison.Ordinal);
    }
    public static string Prepare(string root, string archive, bool quiet, Action<string> progress = null, bool inPlace = false) {
        root = Path.GetFullPath(root); archive = Path.GetFullPath(archive);
        using (var locks = new Locks(root)) {
            bool replacingPending = File.Exists(Pending(root));
            if(replacingPending&&CanResume(root))throw new IOException("已有未完成的安装，请继续安装；不会创建重复任务。");
            string updates = Path.Combine(root, "app/.updates"); Directory.CreateDirectory(updates); Launcher.NoLinks(updates, root);
            if(!replacingPending)CleanCache(root);
            string stage = Path.Combine(updates, "stage-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(stage);
            AtomicJson(stage + ".owner.json", new { format = 1, root = root, stage = stage });
            if (progress != null) progress("正在检查更新包");
            using (var input = new FileStream(archive, FileMode.Open, FileAccess.Read, FileShare.Read)) using (var zip = new ZipArchive(input, ZipArchiveMode.Read)) {
                if (zip.Entries.Count > 100000) throw new IOException("更新包包含过多文件，已停止安装。");
                var pointers=zip.Entries.Where(item=>item.FullName.EndsWith("app/portable.json",StringComparison.Ordinal)).ToArray();
                if(pointers.Length!=1)throw new IOException("程序包必须包含唯一的 app/portable.json。");
                string pointerName=pointers[0].FullName;while(pointerName.StartsWith("./"))pointerName=pointerName.Substring(2);
                string prefix=pointerName.Substring(0,pointerName.Length-"app/portable.json".Length);
                if(prefix.Length!=0&&!prefix.EndsWith("/",StringComparison.Ordinal))throw new IOException("程序包外层目录无效。");
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase); var entries = new List<Tuple<ZipArchiveEntry,string,bool>>(); long bytes = 0;
                foreach (var item in zip.Entries) {
                    string name = item.FullName; while (name.StartsWith("./", StringComparison.Ordinal)) name = name.Substring(2);
                    if(prefix.Length!=0){if(name.TrimEnd('/')==prefix.TrimEnd('/'))continue;if(!name.StartsWith(prefix,StringComparison.Ordinal))throw new IOException("程序包包含外层目录之外的文件。");name=name.Substring(prefix.Length);}
                    bool directory = name.EndsWith("/", StringComparison.Ordinal); name = name.TrimEnd('/'); if (name.Length == 0) continue;
                    if(directory&&name=="data")continue;
                    Launcher.Safe(stage, name);
                    if (!names.Add(name) || ((item.ExternalAttributes >> 16) & 0xF000) == 0xA000) throw new IOException("更新包包含重复路径或文件链接，已停止安装。");
                    if (name == "data" || name.StartsWith("data/", StringComparison.OrdinalIgnoreCase) || name == "backups" || name.StartsWith("backups/", StringComparison.OrdinalIgnoreCase)) throw new IOException("更新包包含用户数据路径，已拒绝安装；data 未修改。");
                    if (!directory) bytes = checked(bytes + item.Length);
                    if (bytes > 8L * 1024 * 1024 * 1024) throw new IOException("更新包解压体积超出本版支持范围。");
                    entries.Add(Tuple.Create(item, name, directory));
                }
                var pointerEntry = entries.SingleOrDefault(item => item.Item2 == "app/portable.json" && !item.Item3);
                if (pointerEntry == null) throw new IOException("请选择完整便携程序 ZIP。");
                if (pointerEntry.Item1.Length > 1024 * 1024) throw new IOException("更新包的程序标识过大，已停止安装。");
                IDictionary<string,object> pointer;
                using (var reader = new StreamReader(pointerEntry.Item1.Open(), Encoding.UTF8)) pointer = Json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
                string program = Launcher.Text(pointer, "program");
                if (!System.Text.RegularExpressions.Regex.IsMatch(program, @"\Aapp/[A-Za-z0-9._-]+\z")) throw new IOException("更新包的程序目录无效。");
                foreach (var item in entries) if (item.Item2 != "app" && !Allowed(item.Item2, program)) throw new IOException("更新包包含非程序路径，已停止安装：" + item.Item2);
                if (new DriveInfo(Path.GetPathRoot(root)).AvailableFreeSpace < bytes + 64L * 1024 * 1024) throw new IOException("空间不足，尚未替换程序或修改数据。请先释放空间。");
                if (progress != null) progress("正在准备新程序，原数据保持原位");
                foreach (var item in entries) {
                    string target = Launcher.Safe(stage, item.Item2);
                    Directory.CreateDirectory(item.Item3 ? target : Path.GetDirectoryName(target)); Launcher.NoLinks(Path.GetDirectoryName(target), root);
                    if (item.Item3) continue;
                    using (var source = item.Item1.Open()) using (var destination = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { source.CopyTo(destination); destination.Flush(true); }
                }
            }
            if (progress != null) progress("正在校验程序与数据兼容性");
            var candidate = Launcher.Read(Path.Combine(stage, "app/portable.json"));
            string programRoot = Launcher.VerifyProgram(stage, candidate, null, false);
            Launcher.CheckData(root, Launcher.Read(Path.Combine(programRoot, "portable.json")));
            ValidateRootFiles(stage);
            string transaction = Path.Combine(updates, "update-" + Guid.NewGuid().ToString("N") + ".json");
            AtomicJson(transaction, new { format = 1, root = root, stage = stage, quiet = quiet, version = Launcher.Text(candidate, "portableVersion") });
            if (replacingPending) { Launcher.NoLinks(Pending(root), root); Atomic(Path.Combine(updates, "superseded-" + Guid.NewGuid().ToString("N") + ".json"), File.ReadAllBytes(Pending(root))); }
            AtomicJson(Pending(root), new { format = 1, transaction = transaction });
            if(!inPlace)StartWorker(root, transaction); return transaction;
        }
    }
    static bool CanResume(string root) {
        try {
            Launcher.NoLinks(Pending(root),root);
            string transaction=Launcher.Text(Launcher.Read(Pending(root)),"transaction");ValidateTransactionPath(root,transaction);
            var record=Launcher.Read(transaction);string stage=Path.GetFullPath(Launcher.Text(record,"stage"));
            string updates=Path.GetFullPath(Path.Combine(root,"app/.updates"))+Path.DirectorySeparatorChar;
            if(!stage.StartsWith(updates,StringComparison.OrdinalIgnoreCase))return false;
            Launcher.NoLinks(stage,root);var pointer=Launcher.Read(Path.Combine(stage,"app/portable.json"));
            string name=Launcher.Text(pointer,"program"),source=Launcher.Safe(stage,name);
            if(Directory.Exists(source)){ValidateRootFiles(stage);Launcher.VerifyProgram(stage,pointer,null,false);}
            else{Launcher.VerifyProgram(root,pointer,Launcher.Safe(root,name),true);ValidateRootFiles(stage,root);}
            return true;
        }catch(Exception){return false;}
    }
    static void ValidateRootFiles(string stage, string installedRoot = null) {
        var index = Launcher.Read(Path.Combine(stage, "app/checksums.json"));
        var pointer = Launcher.Read(Path.Combine(stage, "app/portable.json"));
        string program = Launcher.Text(pointer, "program");
        if (!Launcher.FormatOne(index["format"])) throw new IOException("更新包校验清单无效。");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in (IList)index["files"]) {
            var record = (IDictionary<string,object>)item; string name = Launcher.Text(record, "path"), file = Launcher.Safe(stage, name);
            if (!Allowed(name, program) || !seen.Add(name)) throw new IOException("更新包校验条目无效。");
            if (installedRoot != null && name.StartsWith(program + "/", StringComparison.Ordinal)) file = Launcher.Safe(installedRoot, name);
            Launcher.NoLinks(file, installedRoot != null && name.StartsWith(program + "/", StringComparison.Ordinal) ? installedRoot : stage);
            if (!File.Exists(file) || WindowsPaths.Length(file) != Convert.ToInt64(record["bytes"]) || Launcher.Hash(file) != Launcher.Text(record, "sha256")) throw new IOException("更新包校验未通过：" + name);
        }
        foreach (string name in new[] { "DSH Portable.exe", "DSH 维护工具.exe", "app/portable.json", program + "/checksums.json" }) if (!seen.Contains(name)) throw new IOException("更新包校验清单缺少必要文件：" + name);
        foreach (string file in Directory.GetFiles(stage, "*", SearchOption.AllDirectories)) {
            string name = file.Substring(stage.Length + 1).Replace('\\', '/');
            if (name != "app/checksums.json" && !seen.Contains(name)) throw new IOException("更新包包含未校验文件：" + name);
        }
        foreach (string name in new[] { "DSH Portable.exe", "DSH 维护工具.exe" }) { byte[] icon = EmbeddedIcon.Extract(Path.Combine(stage, name)); if (BitConverter.ToUInt16(icon, 4) == 0) throw new IOException("更新包缺少内嵌应用图标。"); }
    }
    static void StartWorker(string root, string transaction) {
        string worker = Path.Combine(root, "app/.updates/worker-" + Guid.NewGuid().ToString("N") + ".exe");
        File.Copy(System.Windows.Forms.Application.ExecutablePath, worker);
        var owner = Process.GetCurrentProcess();
        Process.Start(new ProcessStartInfo { FileName = worker, Arguments = "--finish-update " + Launcher.Quote(transaction) + " " + Launcher.Quote(owner.Id + ":" + owner.StartTime.ToUniversalTime().Ticks), UseShellExecute = false, CreateNoWindow = true });
    }
    public static void Resume(string root) {
        var pending = Launcher.Read(Pending(root)); string transaction = Launcher.Text(pending, "transaction");
        ValidateTransactionPath(root, transaction); StartWorker(root, transaction);
    }
    public static void ResumeInPlace(string root) {
        var pending=Launcher.Read(Pending(root));string transaction=Launcher.Text(pending,"transaction");ValidateTransactionPath(root,transaction);
        if(Finish(transaction,null,true)!=0)throw new IOException(ResultMessage(root));
    }
    public static string ResultMessage(string root) {
        var result=Launcher.Read(Result(root));
        if(!Convert.ToBoolean(result["ok"]))return Launcher.Text(result,"message");
        var remaining=result.ContainsKey("cleanupPending")?(IList)result["cleanupPending"]:null;
        return remaining!=null&&remaining.Count!=0
            ? "程序已安装。部分旧文件仍被占用，请关闭相关程序后，在“程序检查”中重试清理：\r\n"+String.Join("\r\n",remaining.Cast<object>().Select(item=>Convert.ToString(item)).ToArray())
            : "安装完成，程序已切换到新版本。";
    }
    public static void OpenHost(string root) {
        string cache=Path.Combine(root,"app/.maintenance-host");Directory.CreateDirectory(cache);Launcher.NoLinks(cache,root);
        foreach(var old in Directory.GetFiles(cache,"host-*.exe")){try{Launcher.NoLinks(old,root);File.Delete(old);}catch(IOException){}catch(UnauthorizedAccessException){}}
        string host=Path.Combine(cache,"host-"+Guid.NewGuid().ToString("N")+".exe");File.Copy(System.Windows.Forms.Application.ExecutablePath,host);
        Process.Start(new ProcessStartInfo{FileName=host,Arguments="--portable-maintenance-host "+Launcher.Quote(root),WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true});
    }
    static void RemoveProgramTree(string root,string folder) {
        string app=Path.GetFullPath(Path.Combine(root,"app"))+Path.DirectorySeparatorChar;
        if(!Path.GetFullPath(folder).StartsWith(app,StringComparison.OrdinalIgnoreCase))throw new IOException("拒绝清理程序目录之外的路径。");
        Launcher.NoLinks(folder,root);
        foreach(string item in Directory.GetFileSystemEntries(folder)){Launcher.NoLinks(item,root);if(Directory.Exists(item))RemoveProgramTree(root,item);else File.Delete(item);}
        Directory.Delete(folder);
    }
    static string[] CleanPrevious(string root,string current) {
        var residual=new List<string>();
        var candidates=new List<string>(Directory.GetDirectories(Path.Combine(root,"app")));
        string updates=Path.Combine(root,"app/.updates");if(Directory.Exists(updates))candidates.AddRange(Directory.GetDirectories(updates,"replaced-*"));
        var owned=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        if(Directory.Exists(updates))foreach(string file in Directory.GetFiles(updates,"delete-*.json"))try {
            Launcher.NoLinks(file,root);var record=Launcher.Read(file);string folder=Path.GetFullPath(Launcher.Text(record,"folder"));
            if(Launcher.FormatOne(record["format"])&&Path.GetFullPath(Launcher.Text(record,"root")).Equals(Path.GetFullPath(root),StringComparison.OrdinalIgnoreCase)&&Launcher.Text(record,"dataContract")==Launcher.Text(Launcher.Read(Path.Combine(current,"portable.json")),"dataContract")){owned[folder]=file;candidates.Add(folder);}
        }catch(Exception){residual.Add(file);}
        foreach(var directory in candidates.Distinct(StringComparer.OrdinalIgnoreCase)) {
            if(Path.GetFullPath(directory).Equals(Path.GetFullPath(current),StringComparison.OrdinalIgnoreCase))continue;
            bool replaced=Path.GetFullPath(Path.GetDirectoryName(directory)).Equals(Path.GetFullPath(updates),StringComparison.OrdinalIgnoreCase)&&System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(directory),@"\Areplaced-[a-f0-9]{32}\z");
            bool compact=Path.GetFileName(directory)=="bin";
            if(!replaced&&!compact&&!System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(directory),@"\A\d+\.\d+\.\d+-[a-f0-9]{16}\z"))continue;
            if(!Path.GetFullPath(Path.GetDirectoryName(directory)).Equals(Path.GetFullPath(replaced?updates:Path.Combine(root,"app")),StringComparison.OrdinalIgnoreCase))continue;
            try{if(!Directory.Exists(directory)&&owned.ContainsKey(directory)){Launcher.NoLinks(Path.GetDirectoryName(directory),root);File.Delete(owned[directory]);continue;}Launcher.NoLinks(directory,root);
                if(!owned.ContainsKey(directory)){
                var manifest=Launcher.Read(Path.Combine(directory,"portable.json"));
                if(!manifest.ContainsKey("payloadLayout")||!Launcher.FormatOne(manifest["payloadLayout"]))continue;
                if(Launcher.Text(manifest,"dataContract")!=Launcher.Text(Launcher.Read(Path.Combine(current,"portable.json")),"dataContract")||Directory.Exists(Path.Combine(directory,"data")))continue;
                if(compact&&(!manifest.ContainsKey("programLayout")||Launcher.Text(manifest,"programLayout")!="compact-1"))continue;
                if(!replaced&&!compact&&Path.GetFileName(directory)!=Launcher.Text(manifest,"portableVersion")+"-"+Launcher.Hash(Path.Combine(directory,"checksums.json")).Substring(0,16))continue;
                string owner=Path.Combine(updates,"delete-"+Guid.NewGuid().ToString("N")+".json");
                AtomicJson(owner,new{format=1,root=root,folder=Path.GetFullPath(directory),dataContract=Launcher.Text(manifest,"dataContract")});owned[directory]=owner;
                }
                if(Directory.Exists(Path.Combine(directory,"data")))throw new IOException("旧程序中存在数据目录，停止清理。");
                if(Directory.Exists(directory))RemoveProgramTree(root,directory);
                File.Delete(owned[directory]);
            }catch(Exception){residual.Add(directory);}
        }return residual.ToArray();
    }
    static string[] CleanCache(string root) {
        string updates=Path.GetFullPath(Path.Combine(root,"app/.updates"));
        if(!Directory.Exists(updates))return new string[0];
        Launcher.NoLinks(updates,root);
        var residual=new List<string>();var activeStage="";
        if(File.Exists(Pending(root))) {
            var pending=Launcher.Read(Pending(root));string active=Launcher.Text(pending,"transaction");ValidateTransactionPath(root,active);
            activeStage=Path.GetFullPath(Launcher.Text(Launcher.Read(active),"stage"));
        }
        // Only recorded, app-owned staging directories are eligible; unknown files stay untouched.
        var owners=Directory.GetFiles(updates,"stage-*.owner.json").Concat(Directory.GetFiles(updates,"update-*.json")).ToArray();
        foreach(string owner in owners)try {
            Launcher.NoLinks(owner,root);var record=Launcher.Read(owner);
            if(!Launcher.FormatOne(record["format"])||!Path.GetFullPath(Launcher.Text(record,"root")).Equals(Path.GetFullPath(root),StringComparison.OrdinalIgnoreCase))continue;
            string stage=Path.GetFullPath(Launcher.Text(record,"stage"));
            if(!Path.GetDirectoryName(stage).Equals(updates,StringComparison.OrdinalIgnoreCase)||!System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(stage),@"\Astage-[a-f0-9]{32}\z")||stage.Equals(activeStage,StringComparison.OrdinalIgnoreCase))continue;
            if(Directory.Exists(stage))RemoveProgramTree(root,stage);
            File.Delete(owner);
        }catch(Exception){residual.Add(owner);}
        return residual.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }
    public static string[] Cleanup(string root) {
        using(var locks=new Locks(root)) {
            var pointer=Launcher.Read(Pointer(root));string current=Launcher.VerifyProgram(root,pointer,null,false);
            return CleanPrevious(root,current).Concat(CleanCache(root)).ToArray();
        }
    }
    static void ValidateTransactionPath(string root, string file) {
        // Transaction files stay inside the maintenance cache.
        string updates = Path.GetFullPath(Path.Combine(root, "app/.updates")) + Path.DirectorySeparatorChar;
        if (!Path.GetFullPath(file).StartsWith(updates, StringComparison.OrdinalIgnoreCase)) throw new IOException("更新记录位置无效。");
        Launcher.NoLinks(file, root);
    }
    public static int Finish(string transaction, string ownerText, bool inPlace = false) {
        string root = null; bool quiet = true; string errorText = null;
        try {
            var record = Launcher.Read(transaction); root = Path.GetFullPath(Launcher.Text(record, "root")); quiet = Convert.ToBoolean(record["quiet"]);
            ValidateTransactionPath(root, transaction);
            if (ownerText != null) {
                string[] owner = ownerText.Split(':');
                try { using (var process = Process.GetProcessById(Int32.Parse(owner[0]))) { if (process.StartTime.ToUniversalTime().Ticks == Int64.Parse(owner[1])) process.WaitForExit(); } }
                catch (ArgumentException exitedOwner) { /* The requesting process has already exited. */ }
            }
            using (var locks = new Locks(root)) {
                var pending = Launcher.Read(Pending(root));
                if (!Path.GetFullPath(Launcher.Text(pending, "transaction")).Equals(Path.GetFullPath(transaction), StringComparison.OrdinalIgnoreCase)) return 1;
                string stage = Path.GetFullPath(Launcher.Text(record, "stage"));
                if (!stage.StartsWith(Path.GetFullPath(Path.Combine(root, "app/.updates")) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("更新暂存目录无效。");
                Launcher.NoLinks(stage, root); var pointer = Launcher.Read(Path.Combine(stage, "app/portable.json"));
                string name = Launcher.Text(pointer, "program"), source = Launcher.Safe(stage, name), target = Launcher.Safe(root, name);
                if (Directory.Exists(source)) {
                    ValidateRootFiles(stage);
                    Launcher.VerifyProgram(stage, pointer, null, false); Launcher.CheckData(root, Launcher.Read(Path.Combine(source, "portable.json")));
                    if (Directory.Exists(target)) { Launcher.NoLinks(target, root); Directory.Move(target, Path.Combine(root, "app/.updates/replaced-" + Guid.NewGuid().ToString("N"))); }
                    Directory.Move(source, target);
                } else { Launcher.VerifyProgram(root, pointer, target, true); ValidateRootFiles(stage, root); }
                foreach (string file in Directory.GetFiles(stage, "*", SearchOption.AllDirectories)) {
                    string relative = file.Substring(stage.Length + 1).Replace('\\', '/');
                    if (relative == "app/portable.json" || relative.StartsWith("app/", StringComparison.Ordinal) && !relative.StartsWith("app/说明与许可/", StringComparison.Ordinal) && relative != "app/checksums.json") continue;
                    if (!Allowed(relative, name)) throw new IOException("更新记录包含无效路径。");
                    string destination = Launcher.Safe(root, relative); Directory.CreateDirectory(Path.GetDirectoryName(destination)); Launcher.NoLinks(Path.GetDirectoryName(destination), root);
                    Atomic(destination, File.ReadAllBytes(file));
                }
                Launcher.VerifyProgram(root, pointer, target, true);
                Atomic(Path.Combine(root, "app/portable.json"), File.ReadAllBytes(Path.Combine(stage, "app/portable.json")));
                var residual=new List<string>(CleanPrevious(root,target));
                AtomicJson(Result(root), new { ok = true, transaction=transaction, version = Launcher.Text(pointer, "portableVersion"), finishedAt = DateTime.UtcNow.ToString("O"), dataCopied = false, dataMigrated = false, cleanupPending=residual });
                File.Delete(Pending(root));
                // Keep the stage available until the resumable transaction has committed.
                try{residual.AddRange(CleanCache(root));}catch(Exception){residual.Add(stage);}
                AtomicJson(Result(root), new { ok = true, transaction=transaction, version = Launcher.Text(pointer, "portableVersion"), finishedAt = DateTime.UtcNow.ToString("O"), dataCopied = false, dataMigrated = false, cleanupPending=residual.Distinct().ToArray() });
            }
        } catch (Exception error) {
            errorText = error.Message;
            if (root != null) { try { AtomicJson(Result(root), new { ok = false, message = errorText, dataCopied = false, dataMigrated = false }); } catch (IOException statusFailure) { Console.Error.WriteLine(statusFailure.Message); } }
        }
        if (!inPlace && !quiet && root != null) {
            string ui = Path.Combine(root, "DSH 维护工具.exe");
            if (File.Exists(ui)) Process.Start(new ProcessStartInfo { FileName = ui, UseShellExecute = false, CreateNoWindow = true });
        }
        if (errorText != null) { Console.Error.WriteLine(errorText); return 1; }
        return 0;
    }
}
