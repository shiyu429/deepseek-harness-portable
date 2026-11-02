using System;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
class LegacyZip {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern uint GetFileAttributesW(string path);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateDirectoryW(string path,IntPtr security);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool WriteFile(IntPtr file,byte[] bytes,int count,out int written,IntPtr overlapped);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr file);
    static void DirectoryTree(string path){
        if(GetFileAttributesW(path)!=UInt32.MaxValue)return;
        int slash=path.LastIndexOf('\\');if(slash>2)DirectoryTree(path.Substring(0,slash));
        if(!CreateDirectoryW(path,IntPtr.Zero))throw new IOException("Legacy CreateDirectory: "+Marshal.GetLastWin32Error()+" "+path);
    }
    static int Main(string[] args){try{
        Console.OutputEncoding=new System.Text.UTF8Encoding(false);
        if(args[0]=="fixture"){
            using(var file=new FileStream(args[1],FileMode.CreateNew))using(var zip=new ZipArchive(file,ZipArchiveMode.Create))using(var text=new StreamWriter(zip.CreateEntry(args[2]).Open()))text.Write("fixture resource");return 0;
        }
        if(args[0]=="extended"){
            WindowsDirectory.CreateDirectory(Path.GetDirectoryName(args[1]));
            using(var file=new WindowsFileStream(args[1],FileMode.CreateNew,FileAccess.Write,FileShare.None)){file.WriteByte(42);file.Flush(true);}
            if(WindowsFile.ReadAllBytes(args[1])[0]!=42)throw new IOException("Extended I/O mismatch");
            Console.WriteLine("extended I/O passed");return 0;
        }
        string root=Path.GetFullPath(args[1]).TrimEnd('\\');DirectoryTree(root);int count=0,max=0;
        using(var input=new FileStream(args[0],FileMode.Open,FileAccess.Read,FileShare.Read))using(var zip=new ZipArchive(input,ZipArchiveMode.Read))foreach(var entry in zip.Entries){
            string name=entry.FullName;if(name.Contains("..")||name.Contains(":")||name.StartsWith("/"))throw new IOException("Unsafe entry");
            string path=root+"\\"+name.Replace('/','\\').TrimEnd('\\');
            if(name.EndsWith("/")){DirectoryTree(path);continue;}
            DirectoryTree(path.Substring(0,path.LastIndexOf('\\')));
            IntPtr handle=CreateFileW(path,0x40000000,0,IntPtr.Zero,1,0,IntPtr.Zero);
            if(handle==new IntPtr(-1))throw new IOException("Legacy CreateFile: "+Marshal.GetLastWin32Error()+" length="+path.Length+" "+path);
            try{using(var source=entry.Open()){byte[] buffer=new byte[1024*1024];int n;while((n=source.Read(buffer,0,buffer.Length))>0){int written;if(!WriteFile(handle,buffer,n,out written,IntPtr.Zero)||written!=n)throw new IOException("Legacy WriteFile failed");}}}
            finally{CloseHandle(handle);}count++;max=Math.Max(max,path.Length);
        }
        Console.WriteLine("{\"ok\":true,\"files\":"+count+",\"maximumAbsolutePath\":"+max+"}");return 0;
    }catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}}
}
