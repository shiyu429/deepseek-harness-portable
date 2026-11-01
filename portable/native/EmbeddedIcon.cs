using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Collections.Generic;

static class EmbeddedIcon {
    delegate bool EnumName(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool EnumResourceNamesW(IntPtr module, IntPtr type, EnumName callback, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr FindResourceW(IntPtr module, IntPtr name, IntPtr type);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LockResource(IntPtr data);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint SizeofResource(IntPtr module, IntPtr resource);
    static byte[] Read(IntPtr module, IntPtr name, int type) {
        IntPtr resource = FindResourceW(module, name, new IntPtr(type));
        if (resource == IntPtr.Zero) throw new IOException("应用未包含有效的内嵌图标资源。");
        int size = checked((int)SizeofResource(module, resource)); IntPtr data = LockResource(LoadResource(module, resource));
        if (data == IntPtr.Zero || size == 0) throw new IOException("内嵌图标资源为空。");
        byte[] bytes = new byte[size]; Marshal.Copy(data, bytes, 0, size); return bytes;
    }
    public static byte[] Extract(string file) {
        IntPtr module = LoadLibraryExW(Path.GetFullPath(file), IntPtr.Zero, 0x22);
        if (module == IntPtr.Zero) throw new IOException("无法读取应用的图标资源。");
        try {
            IntPtr groupName = IntPtr.Zero;
            EnumName callback = (m, type, name, p) => { groupName = name; return false; };
            EnumResourceNamesW(module, new IntPtr(14), callback, IntPtr.Zero);
            if (groupName == IntPtr.Zero) throw new IOException("应用没有内嵌图标组。");
            byte[] group = Read(module, groupName, 14); int count = BitConverter.ToUInt16(group, 4);
            if (count < 1 || group.Length < 6 + count * 14) throw new IOException("内嵌图标组损坏。");
            var images = new List<byte[]>(); int length = 6 + count * 16;
            for (int i = 0; i < count; i++) { byte[] bytes = Read(module, new IntPtr(BitConverter.ToUInt16(group, 6 + i * 14 + 12)), 3); images.Add(bytes); length = checked(length + bytes.Length); }
            byte[] result = new byte[length]; Buffer.BlockCopy(group, 0, result, 0, 6); int offset = 6 + count * 16;
            for (int i = 0; i < count; i++) {
                Buffer.BlockCopy(group, 6 + i * 14, result, 6 + i * 16, 12);
                Buffer.BlockCopy(BitConverter.GetBytes(images[i].Length), 0, result, 6 + i * 16 + 8, 4);
                Buffer.BlockCopy(BitConverter.GetBytes(offset), 0, result, 6 + i * 16 + 12, 4);
                Buffer.BlockCopy(images[i], 0, result, offset, images[i].Length); offset += images[i].Length;
            }
            return result;
        } finally { FreeLibrary(module); }
    }
#if ICON_TOOL
    public static int Main(string[] args) {
        try { byte[] bytes = Extract(args[0]); if (args.Length > 1) File.WriteAllBytes(args[1], bytes); Console.WriteLine("Embedded icon frames: " + BitConverter.ToUInt16(bytes, 4)); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
#endif
}
