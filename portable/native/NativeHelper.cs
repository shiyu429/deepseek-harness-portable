// Windows metadata and recoverable ACL leases. Requires only the Windows .NET Framework.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
using System.Windows.Forms;

public sealed class Entry {
    public string Path { get; set; }
    public string Identity { get; set; }
    public string Security { get; set; }
    public bool Directory { get; set; }
    public bool Reparse { get; set; }
    public string Sddl { get; set; }
    public uint Links { get; set; }
}
public sealed class Lease {
    public int Format { get; set; }
    public string Root { get; set; }
    public string Identity { get; set; }
    public string Sid { get; set; }
    public string Phase { get; set; }
    public int OwnerPid { get; set; }
    public long OwnerStart { get; set; }
    public List<Entry> Original { get; set; }
    public List<Entry> Expected { get; set; }
}
public sealed class Failure : Exception {
    public string Code;
    public Failure(string code, string message) : base(message) { Code = code; }
}
public static class NativeHelper {
    const uint Dacl = 4, Label = 0x10, ProtectedDacl = 0x80000000, UnprotectedDacl = 0x20000000, ProtectedSacl = 0x40000000, UnprotectedSacl = 0x10000000;
    const uint FileReadAttributes = 0x80, ShareAll = 7, OpenExisting = 3;
    const uint BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue, RecursionLimit = 512 };
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] struct FileInfo {
        public uint Attributes; public FileTime Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct Trustee {
        public IntPtr Multiple; public int Operation, Form, Type; public IntPtr Sid;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExplicitAccess {
        public uint Mask; public int Mode; public uint Inheritance; public Trustee Trustee;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string p, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle h, out FileInfo i);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetVolumePathNameW(string p, StringBuilder b, uint n);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetVolumeNameForVolumeMountPointW(string p, StringBuilder b, uint n);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetVolumeInformationW(string p, StringBuilder v, uint n, out uint serial, out uint max, out uint flags, StringBuilder fs, uint fn);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
    static extern uint GetNamedSecurityInfoW(string p, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
    static extern uint SetEntriesInAclW(int count, ExplicitAccess[] entries, IntPtr oldAcl, out IntPtr newAcl);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern uint GetSecurityDescriptorLength(IntPtr p);
    [DllImport("advapi32.dll")]
    static extern uint SetSecurityInfo(SafeFileHandle handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr acl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr acl, out bool defaulted);
    [DllImport("ntdll.dll")]
    static extern int NtSetSecurityObject(SafeFileHandle handle, uint info, byte[] sd);
    [DllImport("ntdll.dll")]
    static extern uint RtlNtStatusToDosError(int status);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(byte[] sd, uint rev, uint info, out IntPtr text, out uint length);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr info, int length, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    static int Integrity() {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 8, out token)) throw new Win32Exception();
        try {
            int length; GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try {
                if (!GetTokenInformation(token, 25, buffer, length, out length)) throw new Win32Exception();
                IntPtr sid = Marshal.ReadIntPtr(buffer); byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
            } finally { Marshal.FreeHGlobal(buffer); }
        } finally { CloseHandle(token); }
    }
    static void RequireDesktopIntegrity() {
        if (Integrity() < 8192) throw new Failure("LOW_INTEGRITY_PROCESS", "当前是低完整性受限进程，不能安全恢复工作文件夹权限。请在普通桌面会话中启动，无需管理员权限。");
    }

    static string Long(string p) { return p.StartsWith("\\\\?\\", StringComparison.Ordinal) ? p : "\\\\?\\" + Path.GetFullPath(p); }
    static string Full(string p) { return Path.GetFullPath(p).TrimEnd('\\'); }
    static bool Inside(string root, string value) {
        return String.Equals(root, value, StringComparison.OrdinalIgnoreCase) || value.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
    }
    static string VolumePath(string p) {
        StringBuilder b = new StringBuilder(1024);
        if (!GetVolumePathNameW(Path.GetFullPath(p), b, (uint)b.Capacity)) throw new Win32Exception();
        return b.ToString();
    }
    static string FileSystem(string p) {
        StringBuilder fs = new StringBuilder(1024), name = new StringBuilder(1024);
        uint serial, max, flags;
        if (!GetVolumeInformationW(VolumePath(p), name, 1024, out serial, out max, out flags, fs, 1024)) throw new Win32Exception();
        return fs.ToString();
    }
    static string Identity(string p) {
        StringBuilder volume = new StringBuilder(1024);
        if (!GetVolumeNameForVolumeMountPointW(VolumePath(p), volume, 1024)) throw new Win32Exception();
        using (SafeFileHandle h = CreateFileW(Long(p), FileReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero)) {
            if (h.IsInvalid) throw new Win32Exception();
            FileInfo i;
            if (!GetFileInformationByHandle(h, out i)) throw new Win32Exception();
            return volume.ToString() + ":" + i.Volume.ToString("x8") + ":" + i.IndexHigh.ToString("x8") + i.IndexLow.ToString("x8");
        }
    }
    static string Machine() {
        object value = Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography", "MachineGuid", null);
        string identifier = value as string;
        if (String.IsNullOrWhiteSpace(identifier)) throw new Failure("COMPUTER_ID_UNAVAILABLE", "无法确认当前电脑身份，未授权电脑工作区。");
        using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identifier.Trim().ToLowerInvariant()))).Replace("-", "").ToLowerInvariant();
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr FindFirstFileNameW(string file, uint flags, ref uint length, StringBuilder name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool FindNextFileNameW(IntPtr search, ref uint length, StringBuilder name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FindClose(IntPtr search);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
    static bool Capability(Entry entry, string sid) {
        var sd = new RawSecurityDescriptor(Convert.FromBase64String(entry.Security), 0);
        if (sd.DiscretionaryAcl == null) return false;
        foreach (GenericAce item in sd.DiscretionaryAcl) {
            var known = item as KnownAce; var qualified = item as QualifiedAce;
            if (known != null && qualified != null && qualified.AceQualifier == AceQualifier.AccessAllowed && known.SecurityIdentifier.Value == sid && (known.AccessMask & 0x110156) == 0x110156) return true;
        }
        return false;
    }
    static string FollowedPath(string file) {
        using (var handle = CreateFileW(Long(file), FileReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception();
            var result = new StringBuilder(32768); uint count = GetFinalPathNameByHandleW(handle, result, (uint)result.Capacity, 0);
            if (count == 0 || count >= result.Capacity) throw new Win32Exception();
            string path = result.ToString(); if (path.StartsWith(@"\\?\UNC\")) path = @"\\" + path.Substring(8); else if (path.StartsWith(@"\\?\")) path = path.Substring(4);
            return Full(path);
        }
    }
    static object CheckWorkspace(string folder, string sid) {
        RequireDesktopIntegrity(); folder = Full(folder);
        if (!sid.StartsWith("S-1-4-")) throw new Failure("WORKSPACE_SID", "工作区写入身份无效，未更改权限。");
        if (FileSystem(folder) != "NTFS" || GetDriveTypeW(VolumePath(folder)) == 4) throw new Failure("WORKSPACE_UNSUPPORTED", "此工作区不能安全使用受限写入。请使用本地 NTFS 项目目录，或明确选择完全权限。");
        var entries = Snapshot(folder); bool prepared = Capability(entries[0], sid) && entries[0].Sddl.Contains(";;;LW)"), refresh = false;
        foreach (var entry in entries.GroupBy(item => item.Identity).Select(group => group.First())) {
            var sd = new RawSecurityDescriptor(Convert.FromBase64String(entry.Security), 0);
            if (sd.DiscretionaryAcl == null) throw new Failure("WORKSPACE_AMBIENT_WRITE", "工作区原有权限允许不受限写入，无法保证工作区边界，未更改权限。");
            foreach (GenericAce item in sd.DiscretionaryAcl) {
                var known = item as KnownAce; var qualified = item as QualifiedAce;
                if (known != null && qualified != null && qualified.AceQualifier == AceQualifier.AccessAllowed
                    && (known.SecurityIdentifier.Value == "S-1-1-0" || known.SecurityIdentifier.Value.StartsWith("S-1-5-5-"))
                    && (unchecked((uint)known.AccessMask) & 0x500d0156u) != 0) throw new Failure("WORKSPACE_AMBIENT_WRITE", "工作区原有“所有人/登录身份”写入权限会绕过保护，已停止；未更改权限。请使用独立且权限合适的项目目录，或明确选择完全权限。");
            }
            if (entry.Sddl.Contains(";;;HI)") || entry.Sddl.Contains(";;;SI)") || entry.Sddl.Contains(";;;MP)")) throw new Failure("WORKSPACE_HIGH_LABEL", "工作区包含不能安全调整的高完整性文件，未更改权限。");
            if (entry.Reparse) {
                if (!Inside(folder, FollowedPath(entry.Path))) throw new Failure("WORKSPACE_EXTERNAL_LINK", "工作区有指向外部目录的链接，已在授权前停止。请使用独立项目目录，或明确选择完全权限。");
                continue;
            }
            if (!entry.Directory && entry.Links > 1) {
                uint length = 32768; var name = new StringBuilder((int)length); IntPtr search = FindFirstFileNameW(Long(entry.Path), 0, ref length, name);
                if (search == new IntPtr(-1)) throw new Win32Exception();
                try {
                    while (true) {
                        string alias = Full(Path.Combine(VolumePath(entry.Path), name.ToString().TrimStart('\\')));
                        if (!Inside(folder, alias)) throw new Failure("WORKSPACE_EXTERNAL_HARDLINK", "工作区文件还在外部位置有硬链接，受限写入可能修改外部原文件；已停止，未更改权限。");
                        length = 32768; name = new StringBuilder((int)length);
                        if (FindNextFileNameW(search, ref length, name)) continue;
                        int error = Marshal.GetLastWin32Error(); if (error != 38) throw new Win32Exception(error); break;
                    }
                } finally { FindClose(search); }
            }
            bool capability = Capability(entry, sid), low = entry.Sddl.Contains(";;;LW)");
            // Protected private children keep their existing ACL. They do not
            // receive a capability grant and cannot disable unrelated commands.
            if (entry.Path != folder && (sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 && !capability) continue;
            if ((sd.ControlFlags & ControlFlags.SystemAclProtected) != 0 && !low) throw new Failure("WORKSPACE_PROTECTED_LABEL", "工作区中有独立保护的安全标签，未更改权限。");
            if (prepared && (!capability || !low)) refresh = true;
            if (!low && entry.Sddl.Contains(";;;ME)")) refresh = true;
        }
        return new { ok = true, refresh = refresh, objects = entries.Count };
    }
    static object RepairWorkspace(string folder, string sid) {
        CheckWorkspace(folder, sid);
        var entries = Snapshot(Full(folder)); int repaired = 0;
        foreach (var entry in entries.Where(item => !item.Reparse).OrderBy(item => item.Path.Length).GroupBy(item => item.Identity).Select(group => group.First())) {
            if (Capability(entry, sid) && entry.Sddl.Contains(";;;LW)")) continue;
            var sd = new RawSecurityDescriptor(Convert.FromBase64String(entry.Security), 0);
            if (entry.Path != Full(folder) && (sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 && !Capability(entry, sid)) continue;
            GrantObject(entry, sid); repaired++;
        }
        return new { ok = true, repaired = repaired };
    }
    static object PrepareWorkspace(string folder, string sid) {
        object report = CheckWorkspace(folder, sid);
        EnsureOwnedLabelAccess(Full(folder));
        return report;
    }
    static void EnsureOwnedLabelAccess(string folder) {
        using (var probe = CreateFileW(Long(folder), 0x00080000, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero)) {
            if (!probe.IsInvalid) return;
            int error = Marshal.GetLastWin32Error();
            if (error != 5) throw new Win32Exception(error, "OpenFile WRITE_OWNER: " + folder);
        }
        var account = WindowsIdentity.GetCurrent().User;
        var security = Directory.GetAccessControl(Long(folder), AccessControlSections.Owner | AccessControlSections.Access);
        if (!account.Equals(security.GetOwner(typeof(SecurityIdentifier)))) throw new Failure("WORKSPACE_LABEL_ACCESS", "当前账户不能为此工作区设置受限执行标签：" + folder);
        // An owner can edit its DACL. Add only its own non-inheriting
        // WRITE_OWNER right; never take ownership or grant another account.
        security.AddAccessRule(new FileSystemAccessRule(account, FileSystemRights.TakeOwnership, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(Long(folder), security);
    }
    static string Security(string p) {
        IntPtr owner, group, dacl, sacl, descriptor;
        using (SafeFileHandle handle = CreateFileW(Long(p), 0x00020000, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception();
        uint result = GetSecurityInfo(handle, 1, Dacl | Label, out owner, out group, out dacl, out sacl, out descriptor);
        if (result != 0) throw new Win32Exception((int)result);
        try {
            byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            return Convert.ToBase64String(bytes);
        } finally { LocalFree(descriptor); }
        }
    }
    static byte[] Bytes(RawSecurityDescriptor sd) { byte[] bytes = new byte[sd.BinaryLength]; sd.GetBinaryForm(bytes, 0); return bytes; }
    static string Text(string security) {
        IntPtr p; uint length;
        if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(Convert.FromBase64String(security), 1, Dacl | Label, out p, out length)) throw new Win32Exception();
        try {
            string text = Marshal.PtrToStringUni(p);
            int label = text.IndexOf("S:", StringComparison.Ordinal);
            // Empty label ACL control bits carry no mandatory-label ACE.
            if (label < 0) return text;
            string labels = text.Substring(label);
            int first = labels.IndexOf('(');
            if (first < 0) return text.Substring(0, label);
            return text;
        } finally { LocalFree(p); }
    }
    static bool Equal(string a, string b) { return Text(a) == Text(b); }
    static void RestoreSecurity(string p, string security) {
        byte[] bytes = Convert.FromBase64String(security);
        RawSecurityDescriptor sd = new RawSecurityDescriptor(bytes, 0);
        uint flags = Dacl | Label | ((sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 ? ProtectedDacl : UnprotectedDacl);
        // MAXIMUM_ALLOWED suppresses propagation to existing children (SetSecurityInfo documentation).
        using (SafeFileHandle handle = CreateFileW(Long(p), 0x02000000, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception();
            IntPtr descriptor = Marshal.AllocHGlobal(bytes.Length), empty = IntPtr.Zero;
            try {
                Marshal.Copy(bytes, 0, descriptor, bytes.Length);
                IntPtr dacl, sacl; bool present, defaulted;
                if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted)) throw new Win32Exception();
                if (!present) dacl = IntPtr.Zero;
                if (!GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted)) throw new Win32Exception();
                if (!present || sacl == IntPtr.Zero) {
                    RawAcl noLabels = new RawAcl(2, 0);
                    byte[] emptyBytes = new byte[noLabels.BinaryLength]; noLabels.GetBinaryForm(emptyBytes, 0);
                    empty = Marshal.AllocHGlobal(emptyBytes.Length); Marshal.Copy(emptyBytes, 0, empty, emptyBytes.Length); sacl = empty;
                }
                uint result = SetSecurityInfo(handle, 1, flags & ~Label, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
                if (result != 0) throw new Win32Exception((int)result);
                if (sd.SystemAcl == null || sd.SystemAcl.Count == 0) {
                    // An explicit empty label ACL removes the temporary mandatory label.
                    sd.SystemAcl = new RawAcl(2, 0);
                    sd.SetFlags(sd.ControlFlags | ControlFlags.SystemAclPresent);
                }
                if ((sd.ControlFlags & ControlFlags.SystemAclAutoInherited) != 0) sd.SetFlags(sd.ControlFlags | ControlFlags.SystemAclAutoInheritRequired);
                int status = NtSetSecurityObject(handle, Label, Bytes(sd));
                if (status < 0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
            } finally { if (empty != IntPtr.Zero) Marshal.FreeHGlobal(empty); Marshal.FreeHGlobal(descriptor); }
        }
        if (!Equal(Security(p), security)) {
            if (Environment.GetEnvironmentVariable("DSH_PORTABLE_ACL_DEBUG") == "1") Console.Error.WriteLine("expected=" + Text(security) + " actual=" + Text(Security(p)));
            throw new Failure("ACL_VERIFY_FAILED", "文件夹权限恢复后校验失败：" + p);
        }
    }
    static Entry Read(string p) {
        FileAttributes attributes = File.GetAttributes(Long(p));
        string security = Security(p);
        uint links = 0;
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0) {
            using (SafeFileHandle handle = CreateFileW(Long(p), FileReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, OpenReparsePoint, IntPtr.Zero)) {
                FileInfo info; if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info)) throw new Win32Exception(); links = info.Links;
            }
        }
        return new Entry { Path = p, Identity = Identity(p), Security = security, Sddl = Text(security), Directory = (attributes & FileAttributes.Directory) != 0, Reparse = (attributes & FileAttributes.ReparsePoint) != 0, Links = links };
    }
    static List<Entry> Snapshot(string root) {
        List<Entry> entries = new List<Entry>(); Stack<string> pending = new Stack<string>(); pending.Push(root);
        while (pending.Count != 0) {
            string p = pending.Pop(); Entry entry;
            try { entry = Read(p); }
            catch (Exception error) { throw new Failure("WORKSPACE_SCAN_FAILED", "读取文件权限失败：" + p + "；" + error.Message); }
            entries.Add(entry);
            if (!entry.Directory || entry.Reparse) continue;
            foreach (string child in Directory.GetFileSystemEntries(Long(p)).OrderBy(x => x, StringComparer.OrdinalIgnoreCase)) {
                string normal = child.StartsWith("\\\\?\\") ? child.Substring(4) : child;
                pending.Push(normal);
            }
        }
        return entries;
    }
    static void Save(string filename, object value) {
        string temp = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
        byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(value) + "\n");
        try {
            using (FileStream f = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.WriteThrough)) { f.Write(bytes, 0, bytes.Length); f.Flush(true); }
            if (File.Exists(filename)) File.Replace(temp, filename, null); else File.Move(temp, filename);
        } finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    static Lease Load(string file) {
        Lease lease = Json.Deserialize<Lease>(File.ReadAllText(file, Encoding.UTF8));
        if (lease == null || lease.Format != 1 || lease.Original == null || lease.Original.Count == 0 || String.IsNullOrEmpty(lease.Sid)) throw new Failure("JOURNAL_INVALID", "权限恢复记录无效，请保留该文件：" + file);
        lease.Root = Full(lease.Root);
        foreach (Entry entry in lease.Original.Concat(lease.Expected ?? new List<Entry>())) {
            if (!Inside(lease.Root, Full(entry.Path))) throw new Failure("JOURNAL_INVALID", "权限恢复记录包含范围外的路径。");
            Convert.FromBase64String(entry.Security);
        }
        new SecurityIdentifier(lease.Sid);
        return lease;
    }
    static long Start(int pid) { using (Process p = Process.GetProcessById(pid)) return p.StartTime.ToUniversalTime().Ticks; }
    static bool Alive(Lease lease) { try { return Start(lease.OwnerPid) == lease.OwnerStart; } catch (ArgumentException) { return false; } }
    static byte[] AceBinary(GenericAce ace) { byte[] bytes = new byte[ace.BinaryLength]; ace.GetBinaryForm(bytes, 0); return bytes; }
    static string AceBytes(GenericAce ace) { return Convert.ToBase64String(AceBinary(ace)); }
    static bool Contains(RawAcl acl, GenericAce ace) {
        if (acl == null) return false;
        string value = AceBytes(ace);
        for (int i = 0; i < acl.Count; i++) if (AceBytes(acl[i]) == value) return true;
        return false;
    }
    static bool WorldDeny(GenericAce ace) {
        CommonAce common = ace as CommonAce;
        return common != null && common.AceQualifier == AceQualifier.AccessDenied && common.SecurityIdentifier.Value == "S-1-1-0" && common.AccessMask == 0x40;
    }
    static bool OwnAce(GenericAce ace, string sid) { KnownAce known = ace as KnownAce; return known != null && known.SecurityIdentifier.Value == sid; }
    static bool ForeignCapability(RawAcl acl, string sid) {
        if (acl == null) return false;
        for (int i = 0; i < acl.Count; i++) {
            KnownAce known = acl[i] as KnownAce;
            if (known != null && known.SecurityIdentifier.Value.StartsWith("S-1-4-") && known.SecurityIdentifier.Value != sid) return true;
        }
        return false;
    }
    static string RemoveLease(Entry current, Entry baseline, string sid, bool fresh) {
        RawSecurityDescriptor sd = new RawSecurityDescriptor(Convert.FromBase64String(current.Security), 0);
        RawSecurityDescriptor original = baseline == null ? null : new RawSecurityDescriptor(Convert.FromBase64String(baseline.Security), 0);
        bool hasOwn = false;
        if (sd.DiscretionaryAcl != null) for (int i = 0; i < sd.DiscretionaryAcl.Count; i++) if (OwnAce(sd.DiscretionaryAcl[i], sid)) hasOwn = true;
        if (!hasOwn && fresh) return current.Security;
        if (ForeignCapability(sd.DiscretionaryAcl, sid)) throw new Failure("ACL_CONFLICT", "另一项权限授权仍在使用此目录。");
        if (sd.DiscretionaryAcl != null) {
            RawAcl clean = new RawAcl(sd.DiscretionaryAcl.Revision, sd.DiscretionaryAcl.Count);
            for (int i = 0; i < sd.DiscretionaryAcl.Count; i++) {
                GenericAce ace = sd.DiscretionaryAcl[i];
                if ((OwnAce(ace, sid) || WorldDeny(ace)) && (original == null || !Contains(original.DiscretionaryAcl, ace))) continue;
                clean.InsertAce(clean.Count, ace);
            }
            sd.DiscretionaryAcl = clean;
        }
        string currentText = Text(current.Security);
        if (currentText.Contains(";;;LW)")) {
            sd.SystemAcl = original == null ? null : original.SystemAcl;
            ControlFlags flags = sd.ControlFlags;
            if (sd.SystemAcl == null) flags &= ~ControlFlags.SystemAclPresent; else flags |= ControlFlags.SystemAclPresent;
            sd.SetFlags(flags);
        }
        return Convert.ToBase64String(Bytes(sd));
    }
    static string Prepare(string journal, string root, string sid, int owner) {
        RequireDesktopIntegrity();
        root = Full(root);
        if (FileSystem(root) != "NTFS" || String.Equals(root + "\\", VolumePath(root), StringComparison.OrdinalIgnoreCase)) throw new Failure("WORKSPACE_UNSUPPORTED", "请选择 NTFS 磁盘中的具体工作文件夹，不能选择整个磁盘。");
        Directory.CreateDirectory(journal);
        foreach (string file in Directory.GetFiles(journal, "*.lease.json")) {
            Lease active = Load(file);
            if (active.Phase == "restored") continue;
            if ((Inside(active.Root, root) || Inside(root, active.Root)) && Identity(active.Root) == active.Identity) {
                throw new Failure("ACL_LEASE_PENDING", "该目录仍有权限授权或待恢复记录。请先退出相关任务并运行权限恢复工具。");
            }
        }
        List<Entry> original = Snapshot(root);
        foreach (Entry entry in original) {
            if (entry.Sddl.Contains(";;;HI)") || entry.Sddl.Contains(";;;SI)") || entry.Sddl.Contains(";;;MP)")) {
                throw new Failure("LABEL_NOT_RESTORABLE", "工作目录包含当前普通用户不能恢复的高完整性标记，未修改任何权限。");
            }
        }
        Lease lease = new Lease { Format = 1, Root = root, Identity = original[0].Identity, Sid = sid, Phase = "prepared", OwnerPid = owner, OwnerStart = Start(owner), Original = original };
        string filename = Path.Combine(journal, Guid.NewGuid().ToString("N") + ".lease.json");
        Save(filename, lease);
        return filename;
    }
    static object Commit(string filename) {
        Lease lease = Load(filename);
        if (Identity(lease.Root) != lease.Identity) throw new Failure("ROOT_CHANGED", "工作目录在授权时发生变化。");
        lease.Expected = Snapshot(lease.Root); lease.Phase = "active"; Save(filename, lease);
        return new { ok = true, journal = filename };
    }
    static IntPtr Allocate(byte[] bytes) { IntPtr p = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, p, bytes.Length); return p; }
    static IntPtr Sid(string value) { SecurityIdentifier sid = new SecurityIdentifier(value); byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0); return Allocate(bytes); }
    static void NormalizePortableAcl(RawSecurityDescriptor original, bool protect = true) {
        if (original.DiscretionaryAcl == null) return;

        RawAcl fixedAcl = new RawAcl(original.DiscretionaryAcl.Revision, original.DiscretionaryAcl.Count);
        foreach (GenericAce item in original.DiscretionaryAcl) {
            GenericAce copy = GenericAce.CreateFromBinaryForm(AceBinary(item), 0);
            copy.AceFlags &= ~AceFlags.Inherited;
            KnownAce known = copy as KnownAce; QualifiedAce qualified = copy as QualifiedAce;
            if (known != null && qualified != null && qualified.AceQualifier == AceQualifier.AccessAllowed
                && (known.SecurityIdentifier.Value == "S-1-1-0" || known.SecurityIdentifier.Value.StartsWith("S-1-5-5-"))) {
                uint mask = unchecked((uint)known.AccessMask); int read = (int)(mask & 0x1200a9);
                if ((mask & 0x10000000) != 0) read |= 0x1200a9;
                if ((mask & 0x80000000) != 0) read |= 0x120089;
                if ((mask & 0x20000000) != 0) read |= 0x1200a0;
                if (read == 0) continue;
                known.AccessMask = read;
            }
            fixedAcl.InsertAce(fixedAcl.Count, copy);
        }
        original.DiscretionaryAcl = fixedAcl;
        original.SetFlags(protect ? original.ControlFlags | ControlFlags.DiscretionaryAclProtected : original.ControlFlags & ~ControlFlags.DiscretionaryAclProtected);
    }
    static void GrantObject(Entry entry, string sid, string allowedRoot = null) {
        if (Identity(entry.Path) != entry.Identity || !Equal(Security(entry.Path), entry.Security)) throw new Failure("WORKSPACE_CHANGED", "工作目录在准备授权时发生变化，未继续执行命令。");
        using (SafeFileHandle handle = CreateFileW(Long(entry.Path), 0x02000000, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception();
            if (allowedRoot != null) {
                StringBuilder finalPath = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandleW(handle, finalPath, (uint)finalPath.Capacity, 0);
                if (length == 0 || length >= finalPath.Capacity) throw new Win32Exception();
                string actual = finalPath.ToString(); if (actual.StartsWith("\\\\?\\")) actual = actual.Substring(4);
                FileInfo info; if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception();
                if (!Inside(allowedRoot, Full(actual)) || (!entry.Directory && info.Links > 1)) throw new Failure("PORTABLE_BOUNDARY", "拒绝修改便携目录之外或具有硬链接别名的文件权限。");
            }
            IntPtr writeSid = Sid(sid), world = Sid("S-1-1-0"), authenticated = allowedRoot == null ? IntPtr.Zero : Sid("S-1-5-11"), descriptor = IntPtr.Zero, merged = IntPtr.Zero, labelDescriptor = IntPtr.Zero;
            try {
                RawSecurityDescriptor original = new RawSecurityDescriptor(Convert.FromBase64String(entry.Security), 0);
                if (allowedRoot != null) NormalizePortableAcl(original);
                descriptor = Allocate(Bytes(original)); IntPtr dacl; bool present, defaulted;
                if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted)) throw new Win32Exception();
                List<ExplicitAccess> entries = new List<ExplicitAccess>();
                entries.Add(new ExplicitAccess { Mask = 0x110156, Mode = 1, Inheritance = entry.Directory ? 3u : 0u, Trustee = new Trustee { Sid = writeSid } });
                if (authenticated != IntPtr.Zero) entries.Add(new ExplicitAccess { Mask = 0x1f01ff, Mode = 1, Inheritance = entry.Directory ? 3u : 0u, Trustee = new Trustee { Sid = authenticated } });
                if (entry.Directory) entries.Add(new ExplicitAccess { Mask = 0x40, Mode = 3, Inheritance = 2, Trustee = new Trustee { Sid = world } });
                uint result = SetEntriesInAclW(entries.Count, entries.ToArray(), present ? dacl : IntPtr.Zero, out merged);
                if (result != 0) throw new Win32Exception((int)result);
                RawSecurityDescriptor label = new RawSecurityDescriptor(entry.Directory ? "S:(ML;OICI;NW;;;LW)" : "S:(ML;;NW;;;LW)");
                labelDescriptor = Allocate(Bytes(label)); IntPtr sacl;
                if (!GetSecurityDescriptorSacl(labelDescriptor, out present, out sacl, out defaulted)) throw new Win32Exception();
                // Handle-based application never follows directory links or propagates into an external target.
                result = SetSecurityInfo(handle, 1, Dacl | (allowedRoot == null ? 0u : ProtectedDacl), IntPtr.Zero, IntPtr.Zero, merged, IntPtr.Zero);
                if (result != 0) throw new Win32Exception((int)result);
                original.SystemAcl = label.SystemAcl;
                original.SetFlags(original.ControlFlags | ControlFlags.SystemAclPresent);
                if ((original.ControlFlags & ControlFlags.SystemAclAutoInherited) != 0) original.SetFlags(original.ControlFlags | ControlFlags.SystemAclAutoInheritRequired);
                int labelStatus = NtSetSecurityObject(handle, Label, Bytes(original));
                if (labelStatus < 0) throw new Win32Exception((int)RtlNtStatusToDosError(labelStatus));
            } finally {
                if (merged != IntPtr.Zero) LocalFree(merged);
                if (descriptor != IntPtr.Zero) Marshal.FreeHGlobal(descriptor);
                if (labelDescriptor != IntPtr.Zero) Marshal.FreeHGlobal(labelDescriptor);
                Marshal.FreeHGlobal(writeSid); Marshal.FreeHGlobal(world); if (authenticated != IntPtr.Zero) Marshal.FreeHGlobal(authenticated);
            }
        }
    }
    static object Grant(string filename) {
        RequireDesktopIntegrity();
        Lease lease = Load(filename);
        if (lease.Phase != "prepared" || Identity(lease.Root) != lease.Identity) throw new Failure("JOURNAL_STATE", "权限授权记录状态无效。");
        foreach (Entry entry in lease.Original.OrderBy(x => x.Path.Length).GroupBy(x => x.Identity).Select(x => x.First())) GrantObject(entry, lease.Sid);
        return Commit(filename);
    }
    static object GrantPortable(string portable, string folder, string sid) {
        RequireDesktopIntegrity(); portable = Full(portable); folder = Full(folder);
        if (!File.Exists(Path.Combine(portable, "portable.json")) || !Inside(portable, folder) || folder == portable
            || FileSystem(portable) != "NTFS" || VolumePath(portable) != VolumePath(folder)) throw new Failure("PORTABLE_BOUNDARY", "固定授权仅允许用于便携包内部的独立工作文件夹。");
        if (!sid.StartsWith("S-1-4-")) throw new Failure("PORTABLE_SID", "工作区写入身份无效。");
        string parent = folder;
        while (Inside(portable, parent)) {
            if ((File.GetAttributes(Long(parent)) & FileAttributes.ReparsePoint) != 0) throw new Failure("PORTABLE_BOUNDARY", "工作区路径不能经过目录链接。");
            parent = Path.GetDirectoryName(parent); if (parent == null) break;
        }
        List<Entry> entries = Snapshot(folder);
        if (entries.Any(entry => entry.Links > 1)) throw new Failure("PORTABLE_HARDLINK", "工作区包含硬链接文件。请改用当前账户权限模式，未修改任何权限。");
        if (entries.Any(entry => entry.Sddl.Contains(";;;HI)") || entry.Sddl.Contains(";;;SI)") || entry.Sddl.Contains(";;;MP)"))) throw new Failure("PORTABLE_LABEL", "工作区包含高完整性标记，未修改任何权限。");
        foreach (Entry entry in entries.Where(entry => !entry.Reparse).OrderBy(entry => entry.Path.Length).GroupBy(entry => entry.Identity).Select(group => group.First())) GrantObject(entry, sid, portable);
        return new { ok = true, persistent = true, objects = entries.Count };
    }
    static Tuple<int,int,int> Restore(string filename, bool recovering) {
        RequireDesktopIntegrity();
        Lease lease = Load(filename);
        if (lease.Phase == "restored") return Tuple.Create(0,0,0);
        if (!Directory.Exists(lease.Root) || Identity(lease.Root) != lease.Identity) return Tuple.Create(0,0,1);
        if (recovering && Alive(lease)) throw new Failure("ACL_IN_USE", "相关任务仍在运行，不能恢复工作目录权限。");
        List<Entry> live = Snapshot(lease.Root);
        Dictionary<string,Entry> originals = lease.Original.GroupBy(x => x.Identity).ToDictionary(x => x.Key, x => x.First());
        Dictionary<string,Entry> expected = (lease.Expected ?? new List<Entry>()).GroupBy(x => x.Identity).ToDictionary(x => x.Key, x => x.First());
        int restored = 0, conflicts = 0;
        // Parents first so an unprotected child inherits its restored parent's ACL.
        foreach (Entry current in live.OrderBy(x => x.Path.Length).GroupBy(x => x.Identity).Select(x => x.First())) {
            Entry original, after;
            originals.TryGetValue(current.Identity, out original); expected.TryGetValue(current.Identity, out after);
            try {
                if (original != null && Equal(current.Security, original.Security)) continue;
                string target;
                if (original != null) {
                    if (after != null && Equal(current.Security, after.Security)) target = original.Security;
                    else {
                        string candidate = RemoveLease(current, original, lease.Sid, false);
                        if (!Equal(candidate, original.Security)) { conflicts++; continue; }
                        target = original.Security;
                    }
                } else {
                    string parent = Path.GetDirectoryName(current.Path);
                    Entry ancestor = lease.Original.Where(x => x.Directory && Inside(x.Path, parent)).OrderByDescending(x => x.Path.Length).FirstOrDefault();
                    target = RemoveLease(current, ancestor, lease.Sid, true);
                    if (Equal(target, current.Security)) continue;
                }
                if (Identity(current.Path) != current.Identity || !Equal(Security(current.Path), current.Security)) { conflicts++; continue; }
                RestoreSecurity(current.Path, target); restored++;
            } catch (Win32Exception error) { Console.Error.WriteLine("ACL restore Win32 " + error.NativeErrorCode + ": " + current.Path); conflicts++; }
              catch (UnauthorizedAccessException) { Console.Error.WriteLine("ACL restore access denied: " + current.Path); conflicts++; }
              catch (Failure error) { Console.Error.WriteLine(error.Code + ": " + current.Path); conflicts++; }
        }
        if (conflicts == 0) { lease.Phase = "restored"; Save(filename, lease); File.Delete(filename); }
        return Tuple.Create(restored, conflicts, 0);
    }
    static object Recover(string directory) {
        Directory.CreateDirectory(directory); int restored = 0, conflicts = 0, foreign = 0, busy = 0;
        foreach (string file in Directory.GetFiles(directory, "*.lease.json").OrderByDescending(x => File.GetLastWriteTimeUtc(x))) {
            try { var result = Restore(file, true); restored += result.Item1; conflicts += result.Item2; foreign += result.Item3; }
            catch (Failure error) { if (error.Code == "ACL_IN_USE") busy++; else throw; }
        }
        return new { ok = conflicts == 0 && busy == 0, restored = restored, conflicts = conflicts, foreign = foreign, busy = busy, code = conflicts > 0 ? "ACL_CONFLICT" : busy > 0 ? "ACL_IN_USE" : "OK", message = conflicts > 0 ? "有文件权限发生并发变化，未覆盖这些权限。请保留恢复记录并检查原工作目录。" : busy > 0 ? "相关任务仍在运行，请先完整退出程序。" : "权限恢复检查完成。" };
    }
    static object Hold(string filename) {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(filename)));
        try {
            using (FileStream stream = new FileStream(filename, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read)) {
                byte[] owner = Encoding.UTF8.GetBytes(Process.GetCurrentProcess().Id.ToString());
                stream.SetLength(0); stream.Write(owner, 0, owner.Length); stream.Flush(true);
                Console.WriteLine(Json.Serialize(new { ok = true, locked = true })); Console.Out.Flush();
                while (Console.ReadLine() != null) { }
            }
        } catch (IOException) { throw new Failure("PORTABLE_BUSY", "便携数据正在使用，请先完整退出 DSH 和其他维护工具。"); }
        return new { ok = true, released = true };
    }
    static object ChooseFolder() {
        Application.EnableVisualStyles();
        using (FolderBrowserDialog chooser = new FolderBrowserDialog { Description = "选择工作文件夹的新位置", ShowNewFolderButton = true }) {
            bool selected = chooser.ShowDialog() == DialogResult.OK;
            return new { ok = true, cancelled = !selected, path = selected ? chooser.SelectedPath : null };
        }
    }
    static object PortableData(string directory) {
        RequireDesktopIntegrity();
        directory = Full(directory);
        string manifest = Path.Combine(Path.GetDirectoryName(directory), "portable.json");
        string nestedManifest = Path.Combine(Path.GetDirectoryName(directory), "app/portable.json");
        if (File.Exists(nestedManifest)) manifest = nestedManifest;
        if (!String.Equals(Path.GetFileName(directory), "data", StringComparison.OrdinalIgnoreCase) || !File.Exists(manifest)
            || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) {
            throw new Failure("PORTABLE_DATA_PATH", "便携数据目录无效，未修改权限。");
        }
        Dictionary<string,object> marker = Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(manifest));
        if (!marker.ContainsKey("format") || Convert.ToInt32(marker["format"]) != 1) throw new Failure("PORTABLE_DATA_PATH", "便携包标识无效。");
        string filesystem = FileSystem(directory).ToUpperInvariant();
        if (filesystem == "FAT32" || filesystem == "EXFAT") return new { ok = true, filesystem = filesystem, acl = false };
        if (filesystem != "NTFS") throw new Failure("PORTABLE_DATA_PATH", "此文件系统不受支持，未修改权限。");
        RawSecurityDescriptor root = new RawSecurityDescriptor(Convert.FromBase64String(Security(directory)), 0);
        string completion = Path.Combine(directory, ".portable-acl-v2.json");
        bool broad = (root.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0;
        if (root.DiscretionaryAcl != null) foreach (GenericAce item in root.DiscretionaryAcl) {
            KnownAce known = item as KnownAce; QualifiedAce qualified = item as QualifiedAce;
            if (known != null && qualified != null && qualified.AceQualifier == AceQualifier.AccessAllowed
                && (known.SecurityIdentifier.Value == "S-1-1-0" || known.SecurityIdentifier.Value.StartsWith("S-1-5-5-"))
                && (unchecked((uint)known.AccessMask) & ~0x1200a9u) != 0) broad = true;
        }
        if (root.DiscretionaryAcl != null) for (int i = 0; i < root.DiscretionaryAcl.Count; i++) {
            CommonAce ace = root.DiscretionaryAcl[i] as CommonAce;
            if (ace != null && ace.AceQualifier == AceQualifier.AccessAllowed && ace.SecurityIdentifier.Value == "S-1-5-11"
                && (ace.AccessMask & 0x1f01ff) == 0x1f01ff && (ace.AceFlags & (AceFlags.ContainerInherit | AceFlags.ObjectInherit)) == (AceFlags.ContainerInherit | AceFlags.ObjectInherit)
                && (ace.AceFlags & AceFlags.InheritOnly) == 0 && !broad && File.Exists(completion)) return new { ok = true, reused = true };
        }
        List<Entry> entries = Snapshot(directory);
        foreach (Entry entry in entries.Where(x => !x.Reparse).OrderBy(x => x.Path.Length).GroupBy(x => x.Identity).Select(x => x.First())) {
            if (String.Equals(entry.Path, Path.Combine(directory, ".running.lock"), StringComparison.OrdinalIgnoreCase)) continue;
            using (SafeFileHandle handle = CreateFileW(Long(entry.Path), 0x02000000, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception();
                IntPtr sid = Sid("S-1-5-11"), sd = IntPtr.Zero, merged = IntPtr.Zero;
                try {
                    RawSecurityDescriptor secured = new RawSecurityDescriptor(Convert.FromBase64String(Security(entry.Path)), 0);
                    bool dataRoot = String.Equals(entry.Path, directory, StringComparison.OrdinalIgnoreCase);
                    NormalizePortableAcl(secured, dataRoot); sd = Allocate(Bytes(secured)); IntPtr dacl; bool present, defaulted;
                    if (!GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted)) throw new Win32Exception();
                    ExplicitAccess access = new ExplicitAccess { Mask = 0x1f01ff, Mode = 1, Inheritance = entry.Directory ? 3u : 0u, Trustee = new Trustee { Sid = sid } };
                    uint result = SetEntriesInAclW(1, new[] { access }, present ? dacl : IntPtr.Zero, out merged);
                    if (result == 0) result = SetSecurityInfo(handle, 1, Dacl | (dataRoot ? ProtectedDacl : UnprotectedDacl), IntPtr.Zero, IntPtr.Zero, merged, IntPtr.Zero);
                    if (result != 0) throw new Win32Exception((int)result);
                } finally { if (sd != IntPtr.Zero) Marshal.FreeHGlobal(sd); if (merged != IntPtr.Zero) LocalFree(merged); Marshal.FreeHGlobal(sid); }
            }
        }
        Save(completion, new { format = 1, completed = true });
        return new { ok = true, reused = false, objects = entries.Count };
    }
    [STAThread]
    public static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            object report;
            if (args.Length == 2 && args[0] == "probe") report = new { ok = true, filesystem = FileSystem(args[1]), identity = Identity(args[1]), integrity = Integrity() };
            else if (args.Length == 2 && args[0] == "identity") report = new { ok = true, filesystem = FileSystem(args[1]), identity = Identity(args[1]), machine = Machine(), integrity = Integrity() };
            else if (args.Length == 1 && args[0] == "machine") report = new { ok = true, machine = Machine() };
            else if (args.Length == 3 && args[0] == "check-workspace") report = CheckWorkspace(args[1], args[2]);
            else if (args.Length == 3 && args[0] == "prepare-workspace") report = PrepareWorkspace(args[1], args[2]);
            else if (args.Length == 3 && args[0] == "repair-workspace") report = RepairWorkspace(args[1], args[2]);
            else if (args.Length == 2 && args[0] == "inspect") report = new { ok = true, entries = Snapshot(Full(args[1])) };
            else if (args.Length == 4 && args[0] == "grant-portable") report = GrantPortable(args[1], args[2], args[3]);
            else if (args.Length == 2 && args[0] == "hold") report = Hold(args[1]);
            else if (args.Length == 1 && args[0] == "choose-folder") report = ChooseFolder();
            else if (args.Length == 2 && args[0] == "portable-data") report = PortableData(args[1]);
            else if (args.Length == 5 && args[0] == "prepare") report = new { ok = true, journal = Prepare(args[1], args[2], args[3], Int32.Parse(args[4])) };
            else if (args.Length == 2 && args[0] == "commit") report = Commit(args[1]);
            else if (args.Length == 2 && args[0] == "grant") report = Grant(args[1]);
            else if (args.Length == 2 && args[0] == "restore") {
                var result = Restore(args[1], false);
                report = new { ok = result.Item2 == 0 && result.Item3 == 0, restored = result.Item1, conflicts = result.Item2, foreign = result.Item3, code = "ACL_RESTORE_INCOMPLETE", message = "权限恢复未完成，请保留恢复记录。" };
            }
            else if (args.Length == 2 && args[0] == "recover") report = Recover(args[1]);
            else throw new Failure("USAGE", "无效的文件元数据或权限恢复命令。");
            string output = Json.Serialize(report); Console.WriteLine(output);
            return output.Contains("\"ok\":false") ? 2 : 0;
        } catch (Exception error) {
            Failure failure = error as Failure;
            Console.WriteLine(Json.Serialize(new { ok = false, code = failure == null ? "WINDOWS_OPERATION_FAILED" : failure.Code, message = error.Message }));
            return 1;
        }
    }
}
