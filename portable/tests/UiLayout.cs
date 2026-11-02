using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using System.IO;
class UiRegression {
 [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index,uint dpi);
 [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr handle,out IconInfo info);
 [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
 [StructLayout(LayoutKind.Sequential)] struct IconInfo { public bool IsIcon; public int X,Y; public IntPtr Mask,Color; }
 static void Check(bool test,string message){if(!test)throw new Exception(message);}
 [STAThread] static void Main(string[] args){try{Run(args);}catch(Exception error){Console.WriteLine(error.GetType().FullName+": "+error.Message);Environment.ExitCode=1;}}
 static void Run(string[] args){
  UiKit.Initialize();int synthetic=0;
  foreach(var area in new[]{new Rectangle(0,0,1024,728),new Rectangle(0,0,1920,1040),new Rectangle(-3840,0,3840,2080),new Rectangle(1920,-1080,1920,1040)})
   foreach(float dpi in new[]{1f,1.25f,1.5f,2.25f,3f}){
    var bounds=CrispForm.FitBounds(new Rectangle(900,600,(int)(860*dpi),(int)(580*dpi)),area,true);
    Check(area.Contains(bounds),"Window exceeds working area");Check(Math.Abs((bounds.Left+bounds.Width/2)-(area.Left+area.Width/2))<=1,"Horizontal center");Check(Math.Abs((bounds.Top+bounds.Height/2)-(area.Top+area.Height/2))<=1,"Vertical center");synthetic++;
   }
  using(var f=new MaintenanceForm(args[0])){
   f.Show();Application.DoEvents();var work=Screen.FromHandle(f.Handle).WorkingArea;
   Check(work.Contains(f.Bounds),"Actual window exceeds work area");
   Check(Math.Abs((f.Left+f.Width/2)-(work.Left+work.Width/2))<=2,"Actual horizontal center");
   Check(Math.Abs((f.Top+f.Height/2)-(work.Top+work.Height/2))<=2,"Actual vertical center");
   IconInfo info;Check(GetIconInfo(f.ActionCursor.Handle,out info),"Cursor info unavailable");int width,height;
   try{using(var bitmap=Image.FromHbitmap(info.Color==IntPtr.Zero?info.Mask:info.Color)){width=bitmap.Width;height=bitmap.Height/(info.Color==IntPtr.Zero?2:1);}}
   finally{if(info.Mask!=IntPtr.Zero)DeleteObject(info.Mask);if(info.Color!=IntPtr.Zero)DeleteObject(info.Color);}
   int expected=GetSystemMetricsForDpi(13,(uint)Math.Round(f.LayoutScale*96));Check(width==expected,"Hand cursor DPI mismatch: "+width+" != "+expected);
   var result=new {syntheticLayouts=synthetic,actualDpi=f.LayoutScale*96,bounds=new {f.Left,f.Top,f.Width,f.Height},workingArea=work,handCursorWidth=width,handCursorHeight=height,expectedCursorWidth=expected};
   File.WriteAllText(args[1]+".json",new JavaScriptSerializer().Serialize(result));
   Console.WriteLine(new JavaScriptSerializer().Serialize(result));f.MinimumSize=Size.Empty;f.Size=new Size(1100,750);f.PerformLayout();Application.DoEvents();
   var content=(Panel)typeof(MaintenanceForm).GetField("content",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance).GetValue(f);
   Check(content.HorizontalScroll.Visible,"Small viewport must expose horizontal scrolling instead of clipping controls");f.Close();
  }
  MaintenanceForm.Smoke(args[0],args[1]);StartupWindow.Smoke(args[1]+".启动.png");
 }
}
