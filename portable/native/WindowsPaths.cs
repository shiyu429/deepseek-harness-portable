using System;
using System.IO;
using System.Linq;
using System.Text;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]

// Use extended Win32 paths inside our own I/O, independently of the machine's long-path policy.
// Public paths, manifests, child arguments and shell locations remain ordinary absolute paths.
static class WindowsPaths {
    public static string Extended(string path) {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        if (path.StartsWith(@"\\.\", StringComparison.Ordinal)) throw new IOException("不支持设备路径。");
        string absolute = Path.GetFullPath(path);
        return absolute.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + absolute.Substring(2) : @"\\?\" + absolute;
    }
    public static string Ordinary(string path) {
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + path.Substring(8);
        return path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path.Substring(4) : path;
    }
    public static long Length(string path) { return new FileInfo(Extended(path)).Length; }
}
sealed class WindowsFileStream : FileStream {
    public WindowsFileStream(string path, FileMode mode, FileAccess access, FileShare share, int bufferSize = 4096)
        : base(WindowsPaths.Extended(path), mode, access, share, bufferSize) { }
}
static class WindowsFile {
    public static bool Exists(string path) { return !String.IsNullOrEmpty(path) && File.Exists(WindowsPaths.Extended(path)); }
    public static FileAttributes GetAttributes(string path) { return File.GetAttributes(WindowsPaths.Extended(path)); }
    public static string ReadAllText(string path, Encoding encoding) { return File.ReadAllText(WindowsPaths.Extended(path), encoding); }
    public static byte[] ReadAllBytes(string path) { return File.ReadAllBytes(WindowsPaths.Extended(path)); }
    public static void Copy(string source, string target) { File.Copy(WindowsPaths.Extended(source), WindowsPaths.Extended(target)); }
    public static void Delete(string path) { File.Delete(WindowsPaths.Extended(path)); }
}
static class WindowsDirectory {
    public static bool Exists(string path) { return !String.IsNullOrEmpty(path) && Directory.Exists(WindowsPaths.Extended(path)); }
    public static DirectoryInfo CreateDirectory(string path) { return Directory.CreateDirectory(WindowsPaths.Extended(path)); }
    public static void Delete(string path) { Directory.Delete(WindowsPaths.Extended(path)); }
    public static void Move(string source, string target) { Directory.Move(WindowsPaths.Extended(source), WindowsPaths.Extended(target)); }
    public static string[] GetFiles(string path, string pattern = "*", SearchOption option = SearchOption.TopDirectoryOnly) { return Directory.GetFiles(WindowsPaths.Extended(path), pattern, option).Select(WindowsPaths.Ordinary).ToArray(); }
    public static string[] GetDirectories(string path, string pattern = "*") { return Directory.GetDirectories(WindowsPaths.Extended(path), pattern).Select(WindowsPaths.Ordinary).ToArray(); }
    public static string[] GetFileSystemEntries(string path) { return Directory.GetFileSystemEntries(WindowsPaths.Extended(path)).Select(WindowsPaths.Ordinary).ToArray(); }
    public static System.Collections.Generic.IEnumerable<string> EnumerateFileSystemEntries(string path) { return GetFileSystemEntries(path); }
}
